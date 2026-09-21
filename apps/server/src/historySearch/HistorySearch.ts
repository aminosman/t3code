/**
 * HistorySearch — full-text search over what has been said: every thread this
 * server holds, and every meeting recorded on this Mac.
 *
 * An agent that wants to know "has this been worked on before", or "what did
 * they decide on the call", should not page through five hundred threads and
 * eighty transcripts to find out. This is the index that answers it: SQLite
 * FTS5 over the message projection, the thread titles, and each meeting's
 * notes, transcript and slides. Answers come back as threads and meetings
 * rather than passages — each with the few snippets that earned it its place —
 * so the caller spends a few KB of context to learn where to read, and reads
 * only there.
 *
 * It is meant to be asked loosely. Three things make a loose question land:
 *   - stemming (porter): "sending" finds "send" and "sends";
 *   - any word may match, and a thread or meeting that holds more of the
 *     question's words outranks one that repeats a single word;
 *   - a word the index barely knows is widened to the words it does know that
 *     are spelled nearly the same. Transcripts are full of these — a name the
 *     recogniser heard three ways — and so is typing.
 * When even that finds little, the words are retried as prefixes.
 *
 * And it matches by meaning, when it can: "invoice" finds the thread that only
 * ever said "billing". Every passage worth it is embedded by a model running on
 * this Mac (see Embedder), the question is embedded the same way, and the
 * nearest passages are ranked beside the word matches — the two lists are
 * fused by rank, so a thread found both ways comes first and one found either
 * way still comes. Embedding is slow where indexing is not (tens of passages a
 * second), so it trails behind in the background, newest first; until it has
 * caught up, and whenever there is no model, search is by words and says so.
 *
 * The index is kept by catching up, not by triggers. Assistant messages are
 * upserted once per streamed delta; a trigger would re-tokenise a growing
 * message hundreds of times. Catching up is one join that finds which messages
 * are new, edited or gone, and one directory listing that finds which meetings
 * are. It runs at three moments:
 *   - at every launch, in the background, so the index is whole before anyone
 *     asks (a from-scratch build is a couple of seconds for 45,000 messages,
 *     and a launch after that only folds in the difference);
 *   - while the server runs, a few seconds after any thread event and once a
 *     minute for meetings (`followLayer`), so what finishes is indexed without
 *     anyone searching;
 *   - before each search, so a search never misses what finished a moment ago.
 *
 * The tables are created here with IF NOT EXISTS rather than by a numbered
 * migration. Roost merges upstream often and upstream owns the migration
 * sequence; an index that can always be rebuilt from its sources has no
 * business holding a number in it.
 *
 * @module historySearch/HistorySearch
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as Embedder from "./Embedder.ts";
import * as Meetings from "./Meetings.ts";

export class HistorySearchError extends Schema.TaggedError<HistorySearchError>()(
  "HistorySearchError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export type HistorySource = "threads" | "meetings";

export interface HistorySearchInput {
  readonly query: string;
  /** Default both. */
  readonly sources?: ReadonlyArray<HistorySource> | undefined;
  readonly projectId?: string | undefined;
  /** Threads only: what the user wrote, or what agents wrote. */
  readonly role?: "user" | "assistant" | undefined;
  /** ISO timestamp; only what was written or recorded at or after it. */
  readonly since?: string | undefined;
  /** Left out of the results: the thread asking already knows itself. */
  readonly excludeThreadId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface MeaningStatus {
  /** True when this search was also matched by meaning. */
  readonly active: boolean;
  readonly embedded: number;
  /** Passages still waiting to be embedded; they are found by words only. */
  readonly pending: number;
  readonly reason: string | null;
}

export interface HistorySearchHit {
  readonly matchedBy: "words" | "meaning";
  /** Thread hits: the message. Null for a title, and for meetings. */
  readonly messageId: string | null;
  /** Meeting hits: where in the recording, as m:ss. Null for notes and slides. */
  readonly at: string | null;
  /** user, assistant, title — or for a meeting: notes, transcript, slides. */
  readonly role: string;
  readonly createdAt: string | null;
  readonly snippet: string;
}

export interface HistorySearchResult {
  readonly kind: "thread" | "meeting";
  /** A thread id, or a meeting id (its folder name, e.g. 2026.09.21-1330). */
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  /** A thread's last update; a meeting's start. */
  readonly date: string | null;
  readonly archivedAt: string | null;
  readonly score: number;
  readonly matchedBy: "words" | "meaning" | "both";
  readonly matchedTerms: number;
  readonly hitCount: number;
  readonly hits: ReadonlyArray<HistorySearchHit>;
}

export interface HistorySearchOutput {
  /** How the question was read; a widened word shows what it was widened to. */
  readonly terms: ReadonlyArray<string>;
  readonly meaning: MeaningStatus;
  readonly results: ReadonlyArray<HistorySearchResult>;
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

export interface MeetingSummary {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string | null;
  readonly durationMinutes: number | null;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  readonly people: ReadonlyArray<string>;
}

export interface MeetingReadInput {
  readonly meetingId: string;
  /** m:ss or h:mm:ss into the recording. Omit for the notes. */
  readonly around?: string | undefined;
  /** Minutes of transcript either side of `around`. Default 2. */
  readonly minutes?: number | undefined;
}

export interface MeetingReadOutput {
  readonly meeting: MeetingSummary;
  /** The written notes (summary, decisions, action items); null with `around`. */
  readonly notes: string | null;
  readonly lines: ReadonlyArray<Meetings.TranscriptLine>;
  readonly hasEarlier: boolean;
  readonly hasLater: boolean;
  readonly notesPath: string;
  readonly transcriptPath: string;
}

export interface HistoryIndexState {
  readonly messages: number;
  readonly threads: number;
  readonly meetings: number;
  readonly embedded: number;
  readonly toEmbed: number;
}

export interface HistorySearchShape {
  readonly search: (
    input: HistorySearchInput,
  ) => Effect.Effect<HistorySearchOutput, HistorySearchError>;
  /** Plain SQL over the projection, so archived threads read like any other. */
  readonly readMessages: (
    input: ThreadMessagesInput,
  ) => Effect.Effect<ThreadMessagesOutput | null, HistorySearchError>;
  readonly listMeetings: (input: {
    readonly since?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<MeetingSummary>, HistorySearchError>;
  readonly readMeeting: (
    input: MeetingReadInput,
  ) => Effect.Effect<MeetingReadOutput | null, HistorySearchError>;
  /** Fold in everything that changed since the last catch-up, now. */
  readonly refresh: Effect.Effect<HistoryIndexState, HistorySearchError>;
}

export class HistorySearch extends Context.Service<HistorySearch, HistorySearchShape>()(
  "t3/historySearch/HistorySearch",
) {}

// Words that say nothing about what was being talked about. A query is written
// as a sentence ("how did we cut the testflight build"); these are dropped so
// the ranking is carried by the words that are left.
const STOPWORDS = new Set(
  (
    "a an the of to in on for and or is are was were be been being it its this that these those " +
    "with how what when where why who whom which did do does done we i you he she they our my " +
    "your me us at by from as have has had not no can could should would will about into there " +
    "their them then than so if but also just any some all own get got make made use used " +
    "without within someone something anything everything keep keeps getting never always " +
    "itself still really very much many more most other another"
  ).split(" "),
);

const MAX_TERMS = 12;

export interface QueryTerm {
  /** The quoted FTS5 string for the word or phrase as asked. */
  readonly fts: string;
  /** Set for a lone word, which is what near-spellings and prefixes apply to. */
  readonly word: string | null;
}

/**
 * A sentence in, FTS5 terms out. Every term is quoted, so nothing the caller
 * types can be read as FTS5 syntax. A word the tokenizer would split
 * (`kea_ask`, `Updater.swift`) becomes a phrase of its parts, which is how it
 * was indexed; a "quoted phrase" stays a phrase.
 */
export function queryTerms(query: string): ReadonlyArray<QueryTerm> {
  const terms: Array<QueryTerm> = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const quoted = match[1] !== undefined;
    const runs = (match[1] ?? match[2] ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (runs.length === 0) continue;
    if (!quoted && runs.length === 1 && (STOPWORDS.has(runs[0]!) || runs[0]!.length < 2)) continue;
    const fts = `"${runs.join(" ")}"`;
    if (terms.some((term) => term.fts === fts)) continue;
    terms.push({ fts, word: !quoted && runs.length === 1 ? runs[0]! : null });
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/** Edit distance with transpositions, giving up once it passes `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous2: Array<number> = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previous2[j - 2]! + 1);
      }
      current.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous2 = previous;
    previous = current;
  }
  return previous[b.length]!;
}

// The index holds stems, the question holds words. Porter is not worth
// carrying in JS for this; the common endings are enough to bring a word close
// to its stem before the distance is measured.
const roughStem = (word: string): string =>
  word.replace(/(?:ations?|ingly|ings?|edly|ed|ies|es|s|ly)$/u, "") || word;

const isHistorySearchError = Schema.is(HistorySearchError);

const SYNC_INTERVAL_MS = 5_000;
const HIT_POOL = 400;
const HITS_PER_RESULT = 3;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const DEFAULT_WINDOW = 4;
const MAX_WINDOW = 40;
/** A word found in fewer documents than this is a candidate for widening. */
const RARE_BELOW = 6;
const NEAR_SPELLINGS = 4;
/** Fewer results than this and the words are retried as prefixes. */
const THIN_BELOW = 3;
/** What the user asked for says more about a thread than what was said back. */
const USER_WEIGHT = 1.5;
const TITLE_WEIGHT = 3;
/** Notes are a meeting's own account of what mattered in it. */
const NOTES_WEIGHT = 2;
/** A passage holding every term of the question, or all but one. */
const ALL_TOGETHER = 3;
const MOST_TOGETHER = 1.8;
/** Passages embedded per request to the model, and the pause when none wait. */
const EMBED_BATCH = 32;
const EMBED_IDLE = "20 seconds";
/** What is embedded of a long passage: where it starts and where it lands. */
const EMBED_HEAD = 1200;
const EMBED_TAIL = 800;
/** An agent's one-line "let me check" is not worth a vector. */
const EMBED_MIN_ASSISTANT_CHARS = 200;
const MEANING_POOL = 80;
// Measured on the live index (embeddinggemma, 256 dimensions, one byte each):
// passages that answer the question score 0.5-0.6, and the best a question
// about nothing here ("how to bake sourdough bread") reaches is 0.30.
/** Below this a passage is merely about the same world, not the same thing. */
const MIN_COSINE = 0.38;
/** ...and it must be within reach of the best one found. */
const NEAR_BEST = 0.8;
/** Reciprocal-rank fusion: small, so the head of each list counts most. */
const FUSION_K = 20;

/** Vectors are comparable only within one model at one width. */
const vectorSpace = (model: string) =>
  model === "none" ? model : `${model}@${Embedder.DIMENSIONS}`;

const forEmbedding = (text: string) =>
  text.length <= EMBED_HEAD + EMBED_TAIL
    ? text
    : `${text.slice(0, EMBED_HEAD)}\n…\n${text.slice(text.length - EMBED_TAIL)}`;

interface VectorMatrix {
  readonly stamp: string;
  readonly ids: ReadonlyArray<number>;
  readonly data: Int8Array;
  readonly norms: Float32Array;
}

const describeCause = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

const failWith = (prefix: string) => (cause: unknown) =>
  isHistorySearchError(cause)
    ? cause
    : new HistorySearchError({ reason: `${prefix}: ${describeCause(cause)}` });

const clamp = (value: number | undefined, fallback: number, max: number) =>
  Math.max(0, Math.min(max, Math.trunc(value ?? fallback)));

export interface HistorySearchOptions {
  /** Where meetings are kept. Default: `meetings.dir` from tui's config, else ~/Meetings. */
  readonly meetingsDir?: string | undefined;
}

const make = (options: HistorySearchOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const embedder = yield* Embedder.Embedder;
    const lastSync = yield* Ref.make<number | null>(null);
    const matrix = yield* Ref.make<VectorMatrix | null>(null);
    const meetingsDir = options.meetingsDir ?? (yield* Meetings.configuredDir);

    const ensureSchema = Effect.gen(function* () {
      yield* sql`
        CREATE VIRTUAL TABLE IF NOT EXISTS roost_history_search USING fts5(
          text,
          source UNINDEXED,
          container_id UNINDEXED,
          ref UNINDEXED,
          role UNINDEXED,
          at UNINDEXED,
          tokenize = 'porter unicode61 remove_diacritics 2'
        )
      `;
      // Every word the index knows, with how many documents hold it: what a
      // barely-known word is compared against to find its near-spellings.
      yield* sql`
        CREATE VIRTUAL TABLE IF NOT EXISTS roost_history_vocab
        USING fts5vocab(roost_history_search, 'row')
      `;
      // One row per indexed document; its id is the FTS rowid. `version` is
      // what the source looked like when it was indexed (a message's
      // updated_at, a thread's title, a meeting's files), so a changed source
      // is found by comparing it.
      yield* sql`
        CREATE TABLE IF NOT EXISTS roost_history_docs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          doc_key TEXT NOT NULL,
          version TEXT NOT NULL,
          indexed INTEGER NOT NULL DEFAULT 0,
          embedded INTEGER NOT NULL DEFAULT 0,
          UNIQUE (kind, doc_key)
        )
      `;
      // embedded: 0 waiting, 1 has a vector, 2 not worth one.
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_roost_history_docs_embedded
        ON roost_history_docs (embedded, id)
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS roost_history_vectors (
          doc_id INTEGER PRIMARY KEY,
          model TEXT NOT NULL,
          vector BLOB NOT NULL
        )
      `;
      // A different model measures a different space: start over in it.
      const model = vectorSpace((yield* embedder.status).model);
      if (model !== "none") {
        yield* sql`DELETE FROM roost_history_vectors WHERE model <> ${model}`;
        yield* sql`
          UPDATE roost_history_docs SET embedded = 0
          WHERE embedded = 1 AND id NOT IN (SELECT doc_id FROM roost_history_vectors)
        `;
      }
      yield* sql`
        CREATE TABLE IF NOT EXISTS roost_history_meetings (
          meeting_id TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          title TEXT NOT NULL,
          started_at TEXT,
          duration_seconds INTEGER,
          project_id TEXT,
          project_title TEXT,
          people TEXT NOT NULL
        )
      `;
    });

    const dropMarked = Effect.gen(function* () {
      yield* sql`
        DELETE FROM roost_history_search
        WHERE rowid IN (SELECT id FROM roost_history_docs WHERE indexed = -1)
      `;
      yield* sql`
        DELETE FROM roost_history_vectors
        WHERE doc_id IN (SELECT id FROM roost_history_docs WHERE indexed = -1)
      `;
      yield* sql`DELETE FROM roost_history_docs WHERE indexed = -1`;
    });

    const catchUpThreads = Effect.gen(function* () {
      // Gone, edited, or streaming again: out of the index.
      yield* sql`
        UPDATE roost_history_docs SET indexed = -1
        WHERE id IN (
          SELECT d.id FROM roost_history_docs d
          LEFT JOIN projection_thread_messages m ON m.message_id = d.doc_key
          WHERE d.kind = 'message'
            AND (m.message_id IS NULL OR m.updated_at <> d.version OR m.is_streaming = 1)
          UNION ALL
          SELECT d.id FROM roost_history_docs d
          LEFT JOIN projection_threads t ON t.thread_id = d.doc_key
          WHERE d.kind = 'title' AND (t.thread_id IS NULL OR t.title <> d.version)
        )
      `;
      yield* dropMarked;

      // New since last time.
      yield* sql`
        INSERT INTO roost_history_docs (kind, doc_key, version)
        SELECT 'message', m.message_id, m.updated_at
        FROM projection_thread_messages m
        LEFT JOIN roost_history_docs d ON d.kind = 'message' AND d.doc_key = m.message_id
        WHERE d.id IS NULL AND m.is_streaming = 0 AND length(m.text) > 0
      `;
      yield* sql`
        INSERT INTO roost_history_docs (kind, doc_key, version)
        SELECT 'title', t.thread_id, t.title
        FROM projection_threads t
        LEFT JOIN roost_history_docs d ON d.kind = 'title' AND d.doc_key = t.thread_id
        WHERE d.id IS NULL AND length(t.title) > 0
      `;
      yield* sql`
        INSERT INTO roost_history_search (rowid, text, source, container_id, ref, role, at)
        SELECT d.id, m.text, 'thread', m.thread_id, m.message_id, m.role, m.created_at
        FROM roost_history_docs d
        JOIN projection_thread_messages m ON m.message_id = d.doc_key
        WHERE d.kind = 'message' AND d.indexed = 0
      `;
      yield* sql`
        INSERT INTO roost_history_search (rowid, text, source, container_id, ref, role, at)
        SELECT d.id, t.title, 'thread', t.thread_id, NULL, 'title', NULL
        FROM roost_history_docs d
        JOIN projection_threads t ON t.thread_id = d.doc_key
        WHERE d.kind = 'title' AND d.indexed = 0
      `;
      yield* sql`UPDATE roost_history_docs SET indexed = 1 WHERE indexed = 0`;
    });

    const catchUpMeetings = Effect.gen(function* () {
      const onDisk = yield* Meetings.scan(meetingsDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const known = yield* sql<{ readonly meetingId: string; readonly version: string }>`
        SELECT meeting_id AS "meetingId", version AS "version" FROM roost_history_meetings
      `;
      const knownVersion = new Map(known.map((row) => [row.meetingId, row.version]));
      const present = new Set(onDisk.map((meeting) => meeting.id));

      const stale = [
        ...known.filter((row) => !present.has(row.meetingId)).map((row) => row.meetingId),
        ...onDisk
          .filter((m) => knownVersion.has(m.id) && knownVersion.get(m.id) !== m.version)
          .map((m) => m.id),
      ];
      for (const meetingId of stale) {
        yield* sql`
          UPDATE roost_history_docs SET indexed = -1
          WHERE kind = 'meeting' AND doc_key LIKE ${`${meetingId}#%`}
        `;
        yield* sql`DELETE FROM roost_history_meetings WHERE meeting_id = ${meetingId}`;
      }
      if (stale.length > 0) yield* dropMarked;

      for (const found of onDisk) {
        if (knownVersion.get(found.id) === found.version) continue;
        const meeting = yield* Meetings.load(meetingsDir, found.id).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (meeting === null) continue;
        yield* sql`
          INSERT INTO roost_history_meetings (
            meeting_id, version, title, started_at, duration_seconds,
            project_id, project_title, people
          ) VALUES (
            ${meeting.id}, ${found.version}, ${meeting.title}, ${meeting.startedAt},
            ${meeting.durationSeconds}, ${meeting.projectId}, ${meeting.projectTitle},
            ${meeting.people.join("\n")}
          )
        `;
        for (const [index, doc] of Meetings.documents(meeting).entries()) {
          const inserted = yield* sql<{ readonly id: number }>`
            INSERT INTO roost_history_docs (kind, doc_key, version, indexed)
            VALUES ('meeting', ${`${meeting.id}#${index}`}, ${found.version}, 1)
            RETURNING id AS "id"
          `;
          yield* sql`
            INSERT INTO roost_history_search (rowid, text, source, container_id, ref, role, at)
            VALUES (
              ${inserted[0]!.id}, ${doc.text}, 'meeting', ${meeting.id},
              ${doc.at}, ${doc.role}, ${meeting.startedAt}
            )
          `;
        }
      }
    });

    // One catch-up at a time: the launch build, the follower and a search can
    // all ask at once, and the second should find the first one's work done.
    const catchUpLock = yield* Semaphore.make(1);
    const catchUpNow = catchUpLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(lastSync)) === null) yield* ensureSchema;
        yield* sql.withTransaction(catchUpThreads);
        yield* sql.withTransaction(catchUpMeetings);
        yield* Ref.set(lastSync, yield* Clock.currentTimeMillis);
      }),
    );

    const sync = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(lastSync);
      if (last !== null && now - last < SYNC_INTERVAL_MS) return;
      yield* catchUpNow;
    });

    const embeddingCounts = sql<{ readonly embedded: number; readonly pending: number }>`
      SELECT
        COALESCE(SUM(embedded = 1), 0) AS "embedded",
        COALESCE(SUM(embedded = 0), 0) AS "pending"
      FROM roost_history_docs
    `.pipe(Effect.map((rows) => rows[0] ?? { embedded: 0, pending: 0 }));

    /**
     * Embed the newest passages still waiting; returns how many it settled.
     * Newest first, so what was said today is findable by meaning today and
     * last year's threads fill in behind it.
     */
    const embedSome = Effect.gen(function* () {
      if ((yield* Ref.get(lastSync)) === null) return 0;
      const status = yield* embedder.status;
      if (!status.available) return 0;
      const waiting = yield* sql<{
        readonly id: number;
        readonly text: string;
        readonly role: string;
      }>`
        SELECT d.id AS "id", s.text AS "text", s.role AS "role"
        FROM roost_history_docs d
        JOIN roost_history_search s ON s.rowid = d.id
        WHERE d.embedded = 0 AND d.indexed = 1
        ORDER BY d.id DESC
        LIMIT ${EMBED_BATCH}
      `;
      if (waiting.length === 0) return 0;
      const worth = waiting.filter(
        (doc) =>
          doc.role !== "title" &&
          (doc.role !== "assistant" || doc.text.length >= EMBED_MIN_ASSISTANT_CHARS),
      );
      const vectors =
        worth.length === 0
          ? []
          : yield* embedder.embedDocuments(worth.map((doc) => forEmbedding(doc.text)));
      if (vectors === null) return 0;
      const skipped = waiting.filter((doc) => !worth.includes(doc)).map((doc) => doc.id);
      // Under the catch-up lock: both write on the one connection, and a
      // statement slipped inside the other's transaction shares its fate.
      yield* catchUpLock.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            for (const [index, doc] of worth.entries()) {
              yield* sql`
                INSERT OR REPLACE INTO roost_history_vectors (doc_id, model, vector)
                VALUES (${doc.id}, ${vectorSpace(status.model)}, ${Embedder.quantize(vectors[index]!)})
              `;
            }
            if (worth.length > 0) {
              yield* sql`
                UPDATE roost_history_docs SET embedded = 1
                WHERE ${sql.in(
                  "id",
                  worth.map((doc) => doc.id),
                )}
              `;
            }
            if (skipped.length > 0) {
              yield* sql`
                UPDATE roost_history_docs SET embedded = 2 WHERE ${sql.in("id", skipped)}
              `;
            }
          }),
        ),
      );
      return waiting.length;
    });

    yield* embedSome.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("history search: embedding stalled").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
          Effect.as(0),
        ),
      ),
      // Work while there is work, a breath between batches so the model is
      // not held against whatever else wants it; rest when there is none.
      Effect.flatMap((settled) => Effect.sleep(settled > 0 ? "50 millis" : EMBED_IDLE)),
      Effect.forever,
      Effect.forkScoped,
    );

    /** Every vector, in memory: a few MB, and a search reads all of it. */
    const loadMatrix = Effect.gen(function* () {
      const stamps = yield* sql<{ readonly count: number; readonly last: number }>`
        SELECT COUNT(*) AS "count", COALESCE(MAX(doc_id), 0) AS "last"
        FROM roost_history_vectors
      `;
      const stamp = `${stamps[0]?.count ?? 0}:${stamps[0]?.last ?? 0}`;
      const held = yield* Ref.get(matrix);
      if (held !== null && held.stamp === stamp) return held;
      const rows = yield* sql<{ readonly id: number; readonly vector: Uint8Array }>`
        SELECT doc_id AS "id", vector AS "vector" FROM roost_history_vectors
      `;
      const usable = rows.filter((row) => row.vector.length === Embedder.DIMENSIONS);
      const data = new Int8Array(usable.length * Embedder.DIMENSIONS);
      const norms = new Float32Array(usable.length);
      for (const [index, row] of usable.entries()) {
        const bytes = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.length);
        data.set(bytes, index * Embedder.DIMENSIONS);
        let norm = 0;
        for (const value of bytes) norm += value * value;
        norms[index] = Math.sqrt(norm) || 1;
      }
      const next = { stamp, ids: usable.map((row) => row.id), data, norms };
      yield* Ref.set(matrix, next);
      return next;
    });

    /** The passages nearest the question, best first, with their cosine. */
    const nearest = (query: Float32Array, held: VectorMatrix) => {
      const scored: Array<{ readonly id: number; readonly cosine: number }> = [];
      for (let row = 0; row < held.ids.length; row++) {
        let dot = 0;
        const offset = row * Embedder.DIMENSIONS;
        for (let index = 0; index < Embedder.DIMENSIONS; index++) {
          dot += query[index]! * held.data[offset + index]!;
        }
        const cosine = dot / held.norms[row]!;
        if (cosine >= MIN_COSINE) scored.push({ id: held.ids[row]!, cosine });
      }
      scored.sort((a, b) => b.cosine - a.cosine);
      const floor = (scored[0]?.cosine ?? 0) * NEAR_BEST;
      return scored.filter((entry) => entry.cosine >= floor).slice(0, MEANING_POOL);
    };

    const refresh: HistorySearchShape["refresh"] = Effect.gen(function* () {
      yield* catchUpNow;
      const counts = yield* sql<{ readonly kind: string; readonly count: number }>`
        SELECT kind AS "kind", COUNT(*) AS "count" FROM roost_history_docs GROUP BY kind
        UNION ALL
        SELECT 'meetings', COUNT(*) FROM roost_history_meetings
      `;
      const count = (kind: string) => counts.find((row) => row.kind === kind)?.count ?? 0;
      const embedding = yield* embeddingCounts;
      return {
        messages: count("message"),
        threads: count("title"),
        meetings: count("meetings"),
        embedded: embedding.embedded,
        toEmbed: embedding.pending,
      };
    }).pipe(Effect.mapError(failWith("could not build the history search index")));

    // Every launch: make the index whole before anyone asks. In the background,
    // because a server that is slow to listen is worse than a first search that
    // waits a second, and a failure here is a search that says so later.
    yield* Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const state = yield* refresh;
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      yield* Effect.logInfo("history search index ready").pipe(
        Effect.annotateLogs({ ...state, elapsedMs }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("history search index could not be built at launch").pipe(
          Effect.annotateLogs({ reason: error.reason }),
        ),
      ),
      Effect.forkScoped,
    );

    /**
     * A word the index barely knows, widened to the words it does know that are
     * spelled nearly the same, most common first. "whisperflow" finds
     * "wisprflow"; "emin" finds "amin". A word the index knows well is left as
     * asked: widening "build" would only add noise.
     */
    const nearSpellings = (word: string) =>
      Effect.gen(function* () {
        if (word.length < 4 || /^\d+$/u.test(word)) return [];
        const known = yield* sql<{ readonly one: number }>`
          SELECT 1 AS "one" FROM roost_history_search
          WHERE roost_history_search MATCH ${`"${word}"`} LIMIT ${RARE_BELOW}
        `;
        if (known.length >= RARE_BELOW) return [];
        const max = word.length >= 8 ? 2 : 1;
        const stem = roughStem(word);
        const candidates = yield* sql<{ readonly term: string; readonly doc: number }>`
          SELECT term AS "term", doc AS "doc" FROM roost_history_vocab
          WHERE length(term) BETWEEN ${stem.length - max} AND ${word.length + max}
        `;
        return candidates
          .filter(
            (candidate) =>
              candidate.term !== word &&
              candidate.term !== stem &&
              candidate.term.length >= 4 &&
              !STOPWORDS.has(candidate.term) &&
              // Only towards a word the index knows better than the one asked:
              // a near-spelling is a guess, and a guess at a rarer word is noise.
              candidate.doc >= Math.max(1, known.length * 3) &&
              Math.min(
                editDistance(candidate.term, word, max),
                editDistance(candidate.term, stem, max),
              ) <= max,
          )
          .sort((a, b) => b.doc - a.doc)
          .slice(0, NEAR_SPELLINGS)
          .map((candidate) => candidate.term);
      });

    const search: HistorySearchShape["search"] = Effect.fn("HistorySearch.search")(
      function* (input) {
        const asked = queryTerms(input.query);
        if (asked.length === 0) {
          return yield* new HistorySearchError({
            reason: "the query holds no searchable words; name the thing you are looking for",
          });
        }
        yield* sync;

        const sources = new Set<HistorySource>(
          input.role !== undefined ? ["threads"] : (input.sources ?? ["threads", "meetings"]),
        );
        const sourceFilter =
          sources.size === 2
            ? sql`1 = 1`
            : sql`s.source = ${sources.has("threads") ? "thread" : "meeting"}`;
        const projectFilter =
          input.projectId === undefined
            ? sql`1 = 1`
            : sql`COALESCE(t.project_id, g.project_id) = ${input.projectId}`;
        const roleFilter =
          input.role === undefined ? sql`1 = 1` : sql`s.role IN (${input.role}, 'title')`;
        const sinceFilter =
          input.since === undefined ? sql`1 = 1` : sql`(s.at IS NULL OR s.at >= ${input.since})`;
        const excludeFilter =
          input.excludeThreadId === undefined
            ? sql`1 = 1`
            : sql`NOT (s.source = 'thread' AND s.container_id = ${input.excludeThreadId})`;

        type Hit = {
          readonly docId: number;
          readonly source: string;
          readonly containerId: string;
          readonly ref: string | null;
          readonly role: string;
          readonly at: string | null;
          readonly rank: number;
          readonly snippet: string;
          /** Set when the passage was found by meaning. */
          readonly cosine?: number;
        };
        // Any of the words, best first: a description of an incident rarely
        // shares every word with the thread that fixed it.
        const hitsFor = (groups: ReadonlyArray<string>) => sql<Hit>`
          SELECT
            s.rowid AS "docId",
            s.source AS "source",
            s.container_id AS "containerId",
            s.ref AS "ref",
            s.role AS "role",
            s.at AS "at",
            bm25(roost_history_search) AS "rank",
            snippet(roost_history_search, 0, '«', '»', '…', 24) AS "snippet"
          FROM roost_history_search s
          LEFT JOIN projection_threads t ON s.source = 'thread' AND t.thread_id = s.container_id
          LEFT JOIN roost_history_meetings g
            ON s.source = 'meeting' AND g.meeting_id = s.container_id
          WHERE roost_history_search MATCH ${groups.join(" OR ")}
            AND (
              (s.source = 'thread' AND t.thread_id IS NOT NULL AND t.deleted_at IS NULL)
              OR (s.source = 'meeting' AND g.meeting_id IS NOT NULL)
            )
            AND ${sourceFilter} AND ${projectFilter} AND ${roleFilter}
            AND ${sinceFilter} AND ${excludeFilter}
          ORDER BY bm25(roost_history_search)
          LIMIT ${HIT_POOL}
        `;

        const widened = yield* Effect.forEach(asked, (term) =>
          term.word === null
            ? Effect.succeed({ term, near: [] as ReadonlyArray<string> })
            : nearSpellings(term.word).pipe(Effect.map((near) => ({ term, near }))),
        );
        let groups = widened.map(({ term, near }) =>
          near.length === 0
            ? term.fts
            : `(${[term.fts, ...near.map((n) => `"${n}"`)].join(" OR ")})`,
        );
        let labels = widened.map(({ term, near }) =>
          near.length === 0 ? term.fts : `${term.fts} ~ ${near.join(", ")}`,
        );
        let hits = yield* hitsFor(groups);
        const containers = (rows: ReadonlyArray<Hit>) =>
          new Set(rows.map((hit) => `${hit.source}:${hit.containerId}`)).size;
        if (containers(hits) < THIN_BELOW && asked.some((term) => (term.word?.length ?? 0) >= 4)) {
          // Thin: let each word stand for every word that starts with it.
          groups = widened.map(({ term }, index) =>
            term.word !== null && term.word.length >= 4
              ? `(${groups[index]} OR ${term.fts} *)`
              : groups[index]!,
          );
          labels = labels.map((label, index) =>
            (asked[index]!.word?.length ?? 0) >= 4 ? `${label} ~ ${asked[index]!.word}*` : label,
          );
          hits = yield* hitsFor(groups);
        }

        // By meaning, beside by words: the same filters, a different way in.
        const embedderStatus = yield* embedder.status;
        const counts = yield* embeddingCounts;
        let meaningHits: ReadonlyArray<Hit> = [];
        let meaningActive = false;
        if (embedderStatus.available && counts.embedded > 0) {
          const queryVector = yield* embedder.embedQuery(input.query);
          if (queryVector !== null) {
            meaningActive = true;
            const near = nearest(queryVector, yield* loadMatrix);
            if (near.length > 0) {
              const cosineOf = new Map(near.map((entry) => [entry.id, entry.cosine]));
              const rows = yield* sql<Hit>`
                SELECT
                  s.rowid AS "docId",
                  s.source AS "source",
                  s.container_id AS "containerId",
                  s.ref AS "ref",
                  s.role AS "role",
                  s.at AS "at",
                  0 AS "rank",
                  substr(s.text, 1, 240) AS "snippet"
                FROM roost_history_search s
                LEFT JOIN projection_threads t
                  ON s.source = 'thread' AND t.thread_id = s.container_id
                LEFT JOIN roost_history_meetings g
                  ON s.source = 'meeting' AND g.meeting_id = s.container_id
                WHERE ${sql.in(
                  "s.rowid",
                  near.map((entry) => entry.id),
                )}
                  AND (
                    (s.source = 'thread' AND t.thread_id IS NOT NULL AND t.deleted_at IS NULL)
                    OR (s.source = 'meeting' AND g.meeting_id IS NOT NULL)
                  )
                  AND ${sourceFilter} AND ${projectFilter} AND ${roleFilter}
                  AND ${sinceFilter} AND ${excludeFilter}
              `;
              meaningHits = rows
                .map((row) => ({ ...row, cosine: cosineOf.get(row.docId) ?? 0 }))
                .sort((a, b) => b.cosine - a.cosine);
            }
          }
        }
        const meaning: MeaningStatus = {
          active: meaningActive,
          embedded: counts.embedded,
          pending: counts.pending,
          reason: meaningActive
            ? counts.pending > 0
              ? `${counts.pending} passages are still being embedded and are found by words only`
              : null
            : (embedderStatus.reason ??
              (counts.embedded === 0 ? "nothing is embedded yet" : "the model did not answer")),
        };
        if (hits.length === 0 && meaningHits.length === 0) {
          return { terms: labels, meaning, results: [] };
        }

        // How many of the words each thread or meeting holds anywhere in it.
        // The words of a request are usually spread over several messages, so
        // coverage is counted per container, and one holding all of them
        // outranks one that says a single word often.
        const coverage = new Map<string, number>();
        for (const group of groups) {
          const rows = yield* sql<{ readonly key: string }>`
            SELECT DISTINCT source || ':' || container_id AS "key"
            FROM roost_history_search WHERE roost_history_search MATCH ${group}
          `;
          for (const row of rows) coverage.set(row.key, (coverage.get(row.key) ?? 0) + 1);
        }

        // Words that land in the same passage are about the same thing; words
        // scattered over a long thread are often three unrelated remarks. A
        // passage holding every term, or all but one, counts for more.
        const together = new Map<number, number>();
        if (groups.length >= 2) {
          const tiers: Array<readonly [ReadonlyArray<string>, number]> = [[groups, ALL_TOGETHER]];
          if (groups.length >= 3) {
            for (const left of groups) {
              tiers.push([groups.filter((group) => group !== left), MOST_TOGETHER]);
            }
          }
          for (const [subset, weight] of tiers) {
            const rows = yield* sql<{ readonly docId: number }>`
              SELECT rowid AS "docId" FROM roost_history_search
              WHERE roost_history_search MATCH ${subset.join(" AND ")}
              LIMIT 2000
            `;
            for (const row of rows) {
              together.set(row.docId, Math.max(together.get(row.docId) ?? 1, weight));
            }
          }
        }

        const byContainer = new Map<string, { score: number; hits: Array<Hit> }>();
        for (const hit of [...hits].sort(
          (a, b) => a.rank * (together.get(a.docId) ?? 1) - b.rank * (together.get(b.docId) ?? 1),
        )) {
          const key = `${hit.source}:${hit.containerId}`;
          const entry = byContainer.get(key) ?? { score: 0, hits: [] };
          const weight =
            hit.role === "title"
              ? TITLE_WEIGHT
              : hit.role === "notes"
                ? NOTES_WEIGHT
                : hit.role === "user"
                  ? USER_WEIGHT
                  : 1;
          // bm25 is negative, better is lower. Later hits in the same place
          // count for less, so a long thread does not win on length alone.
          entry.score +=
            (-hit.rank * weight * (together.get(hit.docId) ?? 1)) / (1 + entry.hits.length);
          entry.hits.push(hit);
          byContainer.set(key, entry);
        }
        const byWords = [...byContainer.entries()]
          .map(([key, entry]) => ({
            key,
            hits: entry.hits,
            score: entry.score * ((coverage.get(key) ?? 1) / groups.length) ** 2,
          }))
          .sort((a, b) => b.score - a.score);

        const nearContainers = new Map<string, { score: number; hits: Array<Hit> }>();
        for (const hit of meaningHits) {
          const key = `${hit.source}:${hit.containerId}`;
          const entry = nearContainers.get(key) ?? { score: 0, hits: [] };
          entry.score += (hit.cosine ?? 0) / (1 + entry.hits.length);
          entry.hits.push(hit);
          nearContainers.set(key, entry);
        }
        const byMeaning = [...nearContainers.entries()]
          .map(([key, entry]) => ({ key, hits: entry.hits, score: entry.score }))
          .sort((a, b) => b.score - a.score);

        // Fused by rank, not by score: bm25 and cosine do not share a scale,
        // but "third best by words and best by meaning" means the same in both.
        const fused = new Map<string, { score: number; words: Array<Hit>; meaning: Array<Hit> }>();
        for (const [list, side] of [
          [byWords, "words"],
          [byMeaning, "meaning"],
        ] as const) {
          for (const [rank, entry] of list.entries()) {
            const held = fused.get(entry.key) ?? { score: 0, words: [], meaning: [] };
            held.score += 1 / (FUSION_K + rank + 1);
            held[side] = entry.hits;
            fused.set(entry.key, held);
          }
        }
        const ranked = [...fused.entries()]
          .map(([key, entry]) => {
            const seen = new Set(entry.words.map((hit) => hit.ref));
            return {
              key,
              matchedTerms: coverage.get(key) ?? 0,
              matchedBy:
                entry.words.length > 0 && entry.meaning.length > 0
                  ? ("both" as const)
                  : entry.words.length > 0
                    ? ("words" as const)
                    : ("meaning" as const),
              // Word hits first: their snippets show the match. Then what only
              // meaning found, which is the passage's opening lines.
              hits: [...entry.words, ...entry.meaning.filter((hit) => !seen.has(hit.ref))],
              hitCount: entry.words.length + entry.meaning.length,
              score: entry.score,
            };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, clamp(input.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT);

        const idsOf = (source: string) =>
          ranked
            .filter((entry) => entry.hits[0]!.source === source)
            .map((e) => e.hits[0]!.containerId);
        const threadIds = idsOf("thread");
        const meetingIds = idsOf("meeting");
        const threads =
          threadIds.length === 0
            ? []
            : yield* sql<{
                readonly id: string;
                readonly projectId: string;
                readonly projectTitle: string | null;
                readonly title: string;
                readonly updatedAt: string;
                readonly archivedAt: string | null;
              }>`
                SELECT
                  t.thread_id AS "id",
                  t.project_id AS "projectId",
                  p.title AS "projectTitle",
                  t.title AS "title",
                  t.updated_at AS "updatedAt",
                  t.archived_at AS "archivedAt"
                FROM projection_threads t
                LEFT JOIN projection_projects p ON p.project_id = t.project_id
                WHERE ${sql.in("t.thread_id", threadIds)}
              `;
        const meetings = meetingIds.length === 0 ? [] : yield* meetingRows(meetingIds);
        const threadById = new Map(threads.map((thread) => [thread.id, thread]));
        const meetingById = new Map(meetings.map((meeting) => [meeting.id, meeting]));

        return {
          terms: labels,
          meaning,
          results: ranked.flatMap((entry): ReadonlyArray<HistorySearchResult> => {
            const first = entry.hits[0]!;
            const common = {
              // Out of 100, which is first by words and first by meaning.
              score: Math.round((entry.score / (2 / (FUSION_K + 1))) * 100),
              matchedBy: entry.matchedBy,
              matchedTerms: entry.matchedTerms,
              hitCount: entry.hitCount,
              hits: entry.hits.slice(0, HITS_PER_RESULT).map((hit) => ({
                matchedBy: hit.cosine === undefined ? ("words" as const) : ("meaning" as const),
                messageId: hit.source === "thread" ? hit.ref : null,
                at: hit.source === "meeting" ? hit.ref : null,
                role: hit.role,
                createdAt: hit.at,
                snippet: hit.snippet.replaceAll(/\s+/g, " ").trim(),
              })),
            };
            if (first.source === "thread") {
              const thread = threadById.get(first.containerId);
              if (thread === undefined) return [];
              return [
                {
                  kind: "thread",
                  id: thread.id,
                  title: thread.title,
                  projectId: thread.projectId,
                  projectTitle: thread.projectTitle,
                  date: thread.updatedAt,
                  archivedAt: thread.archivedAt,
                  ...common,
                },
              ];
            }
            const meeting = meetingById.get(first.containerId);
            if (meeting === undefined) return [];
            return [
              {
                kind: "meeting",
                id: meeting.id,
                title: meeting.title,
                projectId: meeting.projectId,
                projectTitle: meeting.projectTitle,
                date: meeting.startedAt,
                archivedAt: null,
                ...common,
              },
            ];
          }),
        };
      },
      Effect.mapError(failWith("history search failed")),
    );

    type MeetingRow = {
      readonly id: string;
      readonly title: string;
      readonly startedAt: string | null;
      readonly durationSeconds: number | null;
      readonly projectId: string | null;
      readonly projectTitle: string | null;
      readonly people: string;
    };
    const meetingColumns = sql`
      g.meeting_id AS "id", g.title AS "title", g.started_at AS "startedAt",
      g.duration_seconds AS "durationSeconds", g.project_id AS "projectId",
      COALESCE(p.title, g.project_title) AS "projectTitle", g.people AS "people"
    `;
    const toMeetingSummary = (row: MeetingRow): MeetingSummary => ({
      id: row.id,
      title: row.title,
      startedAt: row.startedAt,
      durationMinutes: row.durationSeconds === null ? null : Math.round(row.durationSeconds / 60),
      projectId: row.projectId,
      projectTitle: row.projectTitle,
      people: row.people.length === 0 ? [] : row.people.split("\n"),
    });
    const meetingRows = (ids: ReadonlyArray<string>) =>
      sql<MeetingRow>`
        SELECT ${meetingColumns} FROM roost_history_meetings g
        LEFT JOIN projection_projects p ON p.project_id = g.project_id
        WHERE ${sql.in("g.meeting_id", ids)}
      `.pipe(Effect.map((rows) => rows.map(toMeetingSummary)));

    const listMeetings: HistorySearchShape["listMeetings"] = Effect.fn(
      "HistorySearch.listMeetings",
    )(
      function* (input) {
        yield* sync;
        const rows = yield* sql<MeetingRow>`
          SELECT ${meetingColumns} FROM roost_history_meetings g
          LEFT JOIN projection_projects p ON p.project_id = g.project_id
          WHERE ${input.since === undefined ? sql`1 = 1` : sql`g.started_at >= ${input.since}`}
          ORDER BY g.meeting_id DESC
          LIMIT ${clamp(input.limit, 20, 200) || 20}
        `;
        return rows.map(toMeetingSummary);
      },
      Effect.mapError(failWith("could not list meetings")),
    );

    const readMeeting: HistorySearchShape["readMeeting"] = Effect.fn("HistorySearch.readMeeting")(
      function* (input) {
        const meeting = yield* Meetings.load(meetingsDir, input.meetingId).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (meeting === null) return null;
        const indexed = yield* meetingRows([meeting.id]).pipe(Effect.orElseSucceed(() => []));
        const summary: MeetingSummary = indexed[0] ?? {
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.startedAt,
          durationMinutes:
            meeting.durationSeconds === null ? null : Math.round(meeting.durationSeconds / 60),
          projectId: meeting.projectId,
          projectTitle: meeting.projectTitle,
          people: meeting.people,
        };
        const paths = {
          notesPath: path.join(meetingsDir, meeting.id, "summary.md"),
          transcriptPath: path.join(meetingsDir, meeting.id, "transcript.md"),
        };
        if (input.around === undefined) {
          return {
            meeting: summary,
            notes: meeting.notes,
            lines: [],
            hasEarlier: false,
            hasLater: meeting.lines.length > 0,
            ...paths,
          };
        }
        const centre = Meetings.seconds(input.around);
        if (centre === null) {
          return yield* new HistorySearchError({
            reason: `"${input.around}" is not a time into the recording; use m:ss, as search hits give it`,
          });
        }
        const span = (clamp(input.minutes, 2, 30) || 2) * 60;
        const inside = meeting.lines.filter(
          (line) => line.seconds >= centre - span && line.seconds <= centre + span,
        );
        return {
          meeting: summary,
          notes: null,
          lines: inside,
          hasEarlier: meeting.lines.some((line) => line.seconds < centre - span),
          hasLater: meeting.lines.some((line) => line.seconds > centre + span),
          ...paths,
        };
      },
      Effect.mapError(failWith("could not read the meeting")),
    );

    const readMessages: HistorySearchShape["readMessages"] = Effect.fn(
      "HistorySearch.readMessages",
    )(
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
          return yield* new HistorySearchError({
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
      Effect.mapError(failWith("could not read the thread")),
    );

    return HistorySearch.of({ search, readMessages, listMeetings, readMeeting, refresh });
  });

export const layerWith = (options: HistorySearchOptions) =>
  Layer.effect(HistorySearch, make(options));

export const layer = layerWith({});

const FOLLOW_INTERVAL = "3 seconds";
/** Meetings announce nothing; their folder is looked at this often instead. */
const MEETINGS_EVERY_TICKS = 20;

/**
 * Keeps the index current while the server runs. Any thread event marks it
 * dirty; a few seconds later one catch-up folds in whatever finished — a
 * message sent, a reply completed, a title regenerated, a thread deleted or
 * reverted. Events are not read for what they say, only for the fact that
 * something moved: the catch-up is the one place that decides what belongs in
 * the index, so the follower cannot drift from it. A long stream of deltas
 * costs one cheap join every few seconds, not one per delta. Meetings are
 * written by another app and raise no event, so once a minute counts as one.
 */
export const followLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const search = yield* HistorySearch;
    const engine = yield* OrchestrationEngineService;
    const dirty = yield* Ref.make(false);
    const ticks = yield* Ref.make(0);
    yield* engine.streamDomainEvents.pipe(
      Stream.runForEach(() => Ref.set(dirty, true)),
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      const tick = yield* Ref.updateAndGet(ticks, (count) => count + 1);
      const moved = yield* Ref.getAndSet(dirty, false);
      if (!moved && tick % MEETINGS_EVERY_TICKS !== 0) return;
      yield* search.refresh.pipe(
        Effect.catch((error) =>
          Effect.logWarning("history search index fell behind").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          ),
        ),
      );
    }).pipe(Effect.repeat(Schedule.spaced(FOLLOW_INTERVAL)), Effect.forkScoped);
  }),
);
