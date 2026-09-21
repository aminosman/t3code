/**
 * ThreadSearch — full-text search over every thread this server holds.
 *
 * An agent that wants to know "has this been worked on before" should not
 * page through five hundred threads to find out. This is the index that
 * answers it: SQLite FTS5 over the message projection and the thread titles,
 * stemmed (porter, so "sending" finds "send" and "sends"), ranked with BM25,
 * answered as threads rather than messages — each with the few snippets that
 * earned it its place, so the caller spends a few KB of context to learn
 * where to read, and reads only there.
 *
 * The index is kept by catching up, not by triggers. Assistant messages are
 * upserted once per streamed delta; a trigger would re-tokenise a growing
 * message hundreds of times. Catching up is one join that finds what is new,
 * edited or gone since last time, and it runs at three moments:
 *   - at every launch, in the background, so the index is whole before anyone
 *     asks (a from-scratch build is under a second for 45,000 messages, and a
 *     launch after that only folds in the difference);
 *   - while the server runs, a few seconds after any thread event (`follow`),
 *     so every finished message is in the index without anyone searching;
 *   - before each search, so a search never misses what finished a moment ago.
 *
 * The tables are created here with IF NOT EXISTS rather than by a numbered
 * migration. Roost merges upstream often and upstream owns the migration
 * sequence; an index that can always be rebuilt from the projection has no
 * business holding a number in it.
 *
 * @module threadSearch/ThreadSearch
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface ThreadSearchInput {
  readonly query: string;
  readonly projectId?: string | undefined;
  readonly role?: "user" | "assistant" | undefined;
  /** ISO timestamp; only messages written at or after it. */
  readonly since?: string | undefined;
  /** Left out of the results: the thread asking already knows itself. */
  readonly excludeThreadId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ThreadSearchHit {
  readonly messageId: string | null;
  readonly role: string;
  readonly createdAt: string | null;
  readonly snippet: string;
}

export interface ThreadSearchResult {
  readonly threadId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly score: number;
  readonly matchedTerms: number;
  readonly hitCount: number;
  readonly hits: ReadonlyArray<ThreadSearchHit>;
}

export interface ThreadSearchOutput {
  readonly terms: ReadonlyArray<string>;
  readonly results: ReadonlyArray<ThreadSearchResult>;
}

export interface ThreadMessagesInput {
  readonly threadId: string;
  /** Centre the window on this message; omit for the thread's latest messages. */
  readonly aroundMessageId?: string | undefined;
  readonly before?: number | undefined;
  readonly after?: number | undefined;
}

export interface ThreadMessageRow {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly streaming: boolean;
}

export interface ThreadMessagesOutput {
  readonly thread: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly branch: string | null;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  };
  readonly messages: ReadonlyArray<ThreadMessageRow>;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

export interface ThreadSearchShape {
  readonly search: (
    input: ThreadSearchInput,
  ) => Effect.Effect<ThreadSearchOutput, ThreadSearchError>;
  /** Plain SQL over the projection, so archived threads read like any other. */
  readonly readMessages: (
    input: ThreadMessagesInput,
  ) => Effect.Effect<ThreadMessagesOutput | null, ThreadSearchError>;
  /** Fold in everything that changed since the last catch-up, now. */
  readonly refresh: Effect.Effect<ThreadSearchIndexState, ThreadSearchError>;
}

export interface ThreadSearchIndexState {
  readonly messages: number;
  readonly threads: number;
}

export class ThreadSearch extends Context.Service<ThreadSearch, ThreadSearchShape>()(
  "t3/threadSearch/ThreadSearch",
) {}

// Words that say nothing about what a thread was about. A query is written
// as a sentence ("how did we cut the testflight build"); these are dropped so
// the ranking is carried by the words that are left.
const STOPWORDS = new Set(
  (
    "a an the of to in on for and or is are was were be been being it its this that these those " +
    "with how what when where why who whom which did do does done we i you he she they our my " +
    "your me us at by from as have has had not no can could should would will about into there " +
    "their them then than so if but also just any some all own get got make made use used"
  ).split(" "),
);

const MAX_TERMS = 12;

/**
 * A sentence in, FTS5 terms out. Every term is quoted, so nothing the caller
 * types can be read as FTS5 syntax. A word the tokenizer would split
 * (`kea_ask`, `Updater.swift`) becomes a phrase of its parts, which is how it
 * was indexed; a "quoted phrase" stays a phrase.
 */
export function queryTerms(query: string): ReadonlyArray<string> {
  const terms: Array<string> = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const quoted = match[1] !== undefined;
    const runs = (match[1] ?? match[2] ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (runs.length === 0) continue;
    if (!quoted && runs.length === 1 && (STOPWORDS.has(runs[0]!) || runs[0]!.length < 2)) continue;
    const term = `"${runs.join(" ")}"`;
    if (!terms.includes(term)) terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

const isThreadSearchError = Schema.is(ThreadSearchError);

const SYNC_INTERVAL_MS = 5_000;
const HIT_POOL = 400;
const HITS_PER_THREAD = 3;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const DEFAULT_WINDOW = 4;
const MAX_WINDOW = 40;
/** What the user asked for says more about a thread than what was said back. */
const USER_WEIGHT = 1.5;
const TITLE_WEIGHT = 3;

const describeCause = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

const failWith = (prefix: string) => (cause: unknown) =>
  new ThreadSearchError({ reason: `${prefix}: ${describeCause(cause)}` });

const clamp = (value: number | undefined, fallback: number, max: number) =>
  Math.max(0, Math.min(max, Math.trunc(value ?? fallback)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lastSync = yield* Ref.make<number | null>(null);

  const ensureSchema = Effect.gen(function* () {
    yield* sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS roost_thread_search USING fts5(
        text,
        message_id UNINDEXED,
        thread_id UNINDEXED,
        role UNINDEXED,
        tokenize = 'porter unicode61 remove_diacritics 2'
      )
    `;
    // One row per indexed document; its id is the FTS rowid. `version` is
    // what the source looked like when it was indexed (a message's
    // updated_at, a thread's title), so a changed source is found by a join.
    yield* sql`
      CREATE TABLE IF NOT EXISTS roost_thread_search_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        version TEXT NOT NULL,
        indexed INTEGER NOT NULL DEFAULT 0,
        UNIQUE (kind, doc_key)
      )
    `;
  });

  const catchUp = sql.withTransaction(
    Effect.gen(function* () {
      // Gone, edited, or streaming again: out of the index.
      yield* sql`
        UPDATE roost_thread_search_docs SET indexed = -1
        WHERE id IN (
          SELECT d.id FROM roost_thread_search_docs d
          LEFT JOIN projection_thread_messages m ON m.message_id = d.doc_key
          WHERE d.kind = 'message'
            AND (m.message_id IS NULL OR m.updated_at <> d.version OR m.is_streaming = 1)
          UNION ALL
          SELECT d.id FROM roost_thread_search_docs d
          LEFT JOIN projection_threads t ON t.thread_id = d.doc_key
          WHERE d.kind = 'title' AND (t.thread_id IS NULL OR t.title <> d.version)
        )
      `;
      yield* sql`
        DELETE FROM roost_thread_search
        WHERE rowid IN (SELECT id FROM roost_thread_search_docs WHERE indexed = -1)
      `;
      yield* sql`DELETE FROM roost_thread_search_docs WHERE indexed = -1`;

      // New since last time.
      yield* sql`
        INSERT INTO roost_thread_search_docs (kind, doc_key, version)
        SELECT 'message', m.message_id, m.updated_at
        FROM projection_thread_messages m
        LEFT JOIN roost_thread_search_docs d ON d.kind = 'message' AND d.doc_key = m.message_id
        WHERE d.id IS NULL AND m.is_streaming = 0 AND length(m.text) > 0
      `;
      yield* sql`
        INSERT INTO roost_thread_search_docs (kind, doc_key, version)
        SELECT 'title', t.thread_id, t.title
        FROM projection_threads t
        LEFT JOIN roost_thread_search_docs d ON d.kind = 'title' AND d.doc_key = t.thread_id
        WHERE d.id IS NULL AND length(t.title) > 0
      `;
      yield* sql`
        INSERT INTO roost_thread_search (rowid, text, message_id, thread_id, role)
        SELECT d.id, m.text, m.message_id, m.thread_id, m.role
        FROM roost_thread_search_docs d
        JOIN projection_thread_messages m ON m.message_id = d.doc_key
        WHERE d.kind = 'message' AND d.indexed = 0
      `;
      yield* sql`
        INSERT INTO roost_thread_search (rowid, text, message_id, thread_id, role)
        SELECT d.id, t.title, NULL, t.thread_id, 'title'
        FROM roost_thread_search_docs d
        JOIN projection_threads t ON t.thread_id = d.doc_key
        WHERE d.kind = 'title' AND d.indexed = 0
      `;
      yield* sql`UPDATE roost_thread_search_docs SET indexed = 1 WHERE indexed = 0`;
    }),
  );

  // One catch-up at a time: the launch build, the follower and a search can
  // all ask at once, and the second should find the first one's work done.
  const catchUpLock = yield* Semaphore.make(1);
  const catchUpNow = catchUpLock.withPermits(1)(
    Effect.gen(function* () {
      if ((yield* Ref.get(lastSync)) === null) yield* ensureSchema;
      yield* catchUp;
      yield* Ref.set(lastSync, yield* Clock.currentTimeMillis);
    }),
  );

  const sync = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(lastSync);
    if (last !== null && now - last < SYNC_INTERVAL_MS) return;
    yield* catchUpNow;
  });

  const refresh: ThreadSearchShape["refresh"] = Effect.gen(function* () {
    yield* catchUpNow;
    const counts = yield* sql<{ readonly kind: string; readonly count: number }>`
      SELECT kind AS "kind", COUNT(*) AS "count" FROM roost_thread_search_docs GROUP BY kind
    `;
    const count = (kind: string) => counts.find((row) => row.kind === kind)?.count ?? 0;
    return { messages: count("message"), threads: count("title") };
  }).pipe(Effect.mapError(failWith("could not build the thread search index")));

  // Every launch: make the index whole before anyone asks. In the background,
  // because a server that is slow to listen is worse than a first search that
  // waits a second, and a failure here is a search that says so later.
  yield* Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const state = yield* refresh;
    const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
    yield* Effect.logInfo("thread search index ready").pipe(
      Effect.annotateLogs({ ...state, elapsedMs }),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("thread search index could not be built at launch").pipe(
        Effect.annotateLogs({ reason: error.reason }),
      ),
    ),
    Effect.forkScoped,
  );

  const search: ThreadSearchShape["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const terms = queryTerms(input.query);
      if (terms.length === 0) {
        return yield* new ThreadSearchError({
          reason: "the query holds no searchable words; name the thing you are looking for",
        });
      }
      yield* sync;

      const projectFilter =
        input.projectId === undefined ? sql`1 = 1` : sql`t.project_id = ${input.projectId}`;
      const roleFilter =
        input.role === undefined ? sql`1 = 1` : sql`s.role IN (${input.role}, 'title')`;
      const sinceFilter =
        input.since === undefined
          ? sql`1 = 1`
          : sql`(m.created_at IS NULL OR m.created_at >= ${input.since})`;
      const excludeFilter =
        input.excludeThreadId === undefined
          ? sql`1 = 1`
          : sql`s.thread_id <> ${input.excludeThreadId}`;

      // Any of the words, best first: a description of an incident rarely
      // shares every word with the thread that fixed it.
      const hits = yield* sql<{
        readonly threadId: string;
        readonly messageId: string | null;
        readonly role: string;
        readonly createdAt: string | null;
        readonly rank: number;
        readonly snippet: string;
      }>`
        SELECT
          s.thread_id AS "threadId",
          s.message_id AS "messageId",
          s.role AS "role",
          m.created_at AS "createdAt",
          bm25(roost_thread_search) AS "rank",
          snippet(roost_thread_search, 0, '«', '»', '…', 24) AS "snippet"
        FROM roost_thread_search s
        JOIN projection_threads t ON t.thread_id = s.thread_id AND t.deleted_at IS NULL
        LEFT JOIN projection_thread_messages m ON m.message_id = s.message_id
        WHERE roost_thread_search MATCH ${terms.join(" OR ")}
          AND ${projectFilter} AND ${roleFilter} AND ${sinceFilter} AND ${excludeFilter}
        ORDER BY bm25(roost_thread_search)
        LIMIT ${HIT_POOL}
      `;
      if (hits.length === 0) return { terms, results: [] };

      // How many of the words each thread holds anywhere in it. The words of
      // a request are usually spread over a thread's messages, so coverage is
      // counted per thread, and a thread holding all of them outranks one
      // that says a single word often.
      const coverage = new Map<string, number>();
      for (const term of terms) {
        const rows = yield* sql<{ readonly threadId: string }>`
          SELECT DISTINCT thread_id AS "threadId"
          FROM roost_thread_search WHERE roost_thread_search MATCH ${term}
        `;
        for (const row of rows) coverage.set(row.threadId, (coverage.get(row.threadId) ?? 0) + 1);
      }

      const byThread = new Map<string, { score: number; hits: Array<(typeof hits)[number]> }>();
      for (const hit of hits) {
        const entry = byThread.get(hit.threadId) ?? { score: 0, hits: [] };
        const weight = hit.role === "title" ? TITLE_WEIGHT : hit.role === "user" ? USER_WEIGHT : 1;
        // bm25 is negative, better is lower. Later hits in the same thread
        // count for less, so a long thread does not win on length alone.
        entry.score += (-hit.rank * weight) / (1 + entry.hits.length);
        entry.hits.push(hit);
        byThread.set(hit.threadId, entry);
      }
      const ranked = [...byThread.entries()]
        .map(([threadId, entry]) => {
          const matchedTerms = coverage.get(threadId) ?? 1;
          return {
            threadId,
            matchedTerms,
            hits: entry.hits,
            score: entry.score * (matchedTerms / terms.length) ** 2,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, clamp(input.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT);

      const threads = yield* sql<{
        readonly threadId: string;
        readonly projectId: string;
        readonly projectTitle: string | null;
        readonly title: string;
        readonly updatedAt: string;
        readonly archivedAt: string | null;
      }>`
        SELECT
          t.thread_id AS "threadId",
          t.project_id AS "projectId",
          p.title AS "projectTitle",
          t.title AS "title",
          t.updated_at AS "updatedAt",
          t.archived_at AS "archivedAt"
        FROM projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE ${sql.in(
          "t.thread_id",
          ranked.map((entry) => entry.threadId),
        )}
      `;
      const threadById = new Map(threads.map((thread) => [thread.threadId, thread]));

      return {
        terms,
        results: ranked.flatMap((entry) => {
          const thread = threadById.get(entry.threadId);
          if (thread === undefined) return [];
          return [
            {
              threadId: thread.threadId,
              projectId: thread.projectId,
              projectTitle: thread.projectTitle ?? "",
              title: thread.title,
              updatedAt: thread.updatedAt,
              archivedAt: thread.archivedAt,
              score: Math.round(entry.score * 10) / 10,
              matchedTerms: entry.matchedTerms,
              hitCount: entry.hits.length,
              hits: entry.hits.slice(0, HITS_PER_THREAD).map((hit) => ({
                messageId: hit.messageId,
                role: hit.role,
                createdAt: hit.createdAt,
                snippet: hit.snippet.replaceAll(/\s+/g, " ").trim(),
              })),
            },
          ];
        }),
      };
    },
    Effect.mapError((cause) =>
      isThreadSearchError(cause) ? cause : failWith("thread search failed")(cause),
    ),
  );

  const readMessages: ThreadSearchShape["readMessages"] = Effect.fn("ThreadSearch.readMessages")(
    function* (input) {
      const threads = yield* sql<{
        readonly id: string;
        readonly projectId: string;
        readonly title: string;
        readonly branch: string | null;
        readonly updatedAt: string;
        readonly archivedAt: string | null;
      }>`
        SELECT
          thread_id AS "id",
          project_id AS "projectId",
          title AS "title",
          branch AS "branch",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM projection_threads
        WHERE thread_id = ${input.threadId} AND deleted_at IS NULL
      `;
      const thread = threads[0];
      if (thread === undefined) return null;

      const before = clamp(input.before, DEFAULT_WINDOW, MAX_WINDOW);
      const after = clamp(input.after, DEFAULT_WINDOW, MAX_WINDOW);
      type Row = {
        readonly id: string;
        readonly role: string;
        readonly text: string;
        readonly createdAt: string;
        readonly isStreaming: number;
      };
      const columns = sql`
        message_id AS "id", role AS "role", text AS "text",
        created_at AS "createdAt", is_streaming AS "isStreaming"
      `;
      const toMessage = (row: Row): ThreadMessageRow => ({
        id: row.id,
        role: row.role,
        text: row.text,
        createdAt: row.createdAt,
        streaming: row.isStreaming === 1,
      });

      if (input.aroundMessageId === undefined) {
        // One more than asked for says whether there is anything older.
        const rows = yield* sql<Row>`
          SELECT ${columns} FROM projection_thread_messages
          WHERE thread_id = ${input.threadId}
          ORDER BY created_at DESC, message_id DESC
          LIMIT ${before + after + 2}
        `;
        const window = rows.slice(0, before + after + 1).toReversed();
        return {
          thread,
          messages: window.map(toMessage),
          hasOlder: rows.length > before + after + 1,
          hasNewer: false,
        };
      }

      const anchors = yield* sql<Row>`
        SELECT ${columns} FROM projection_thread_messages
        WHERE thread_id = ${input.threadId} AND message_id = ${input.aroundMessageId}
      `;
      const anchor = anchors[0];
      if (anchor === undefined) {
        return yield* new ThreadSearchError({
          reason: `thread ${input.threadId} holds no message ${input.aroundMessageId}`,
        });
      }
      const older = yield* sql<Row>`
        SELECT ${columns} FROM projection_thread_messages
        WHERE thread_id = ${input.threadId}
          AND (created_at, message_id) < (${anchor.createdAt}, ${anchor.id})
        ORDER BY created_at DESC, message_id DESC
        LIMIT ${before + 1}
      `;
      const newer = yield* sql<Row>`
        SELECT ${columns} FROM projection_thread_messages
        WHERE thread_id = ${input.threadId}
          AND (created_at, message_id) > (${anchor.createdAt}, ${anchor.id})
        ORDER BY created_at ASC, message_id ASC
        LIMIT ${after + 1}
      `;
      return {
        thread,
        messages: [...older.slice(0, before).toReversed(), anchor, ...newer.slice(0, after)].map(
          toMessage,
        ),
        hasOlder: older.length > before,
        hasNewer: newer.length > after,
      };
    },
    Effect.mapError((cause) =>
      isThreadSearchError(cause) ? cause : failWith("could not read the thread")(cause),
    ),
  );

  return ThreadSearch.of({ search, readMessages, refresh });
});

export const layer = Layer.effect(ThreadSearch, make);

const FOLLOW_INTERVAL = "3 seconds";

/**
 * Keeps the index current while the server runs. Any thread event marks it
 * dirty; a few seconds later one catch-up folds in whatever finished — a
 * message sent, a reply completed, a title regenerated, a thread deleted or
 * reverted. Events are not read for what they say, only for the fact that
 * something moved: the catch-up join is the one place that decides what
 * belongs in the index, so the follower cannot drift from it. A long stream
 * of deltas costs one cheap join every few seconds, not one per delta.
 */
export const followLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const search = yield* ThreadSearch;
    const engine = yield* OrchestrationEngineService;
    const dirty = yield* Ref.make(false);
    yield* engine.streamDomainEvents.pipe(
      Stream.runForEach(() => Ref.set(dirty, true)),
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      if (!(yield* Ref.getAndSet(dirty, false))) return;
      yield* search.refresh.pipe(
        Effect.catch((error) =>
          Effect.logWarning("thread search index fell behind").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          ),
        ),
      );
    }).pipe(Effect.repeat(Schedule.spaced(FOLLOW_INTERVAL)), Effect.forkScoped);
  }),
);
