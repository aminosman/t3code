// @effect-diagnostics nodeBuiltinImport:off - the meetings fixture is a real
// folder on disk, written once before any layer is built.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import type { OrchestrationEvent } from "@t3tools/contracts";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Embedder from "./Embedder.ts";
import * as HistorySearch from "./HistorySearch.ts";

const meetingsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "roost-meetings-"));
const writeMeeting = (id: string, files: Record<string, string>) => {
  NodeFS.mkdirSync(NodePath.join(meetingsDir, id), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    NodeFS.writeFileSync(NodePath.join(meetingsDir, id, name), text);
  }
};
writeMeeting("2026.09.21-1330", {
  "summary.md":
    "# Meeting Notes\n\nSOC 2 compliance planning and whether Plaid can carry the financial data.\n\n" +
    "## Decisions\n- Follow up on Plaid by Friday.\n\n<sub>generated locally by ollama:qwen3:8b</sub>\n",
  "transcript.md":
    "# 2026.09.21-1330\n\nengine: parakeet\n\n" +
    "**[8:51] Speaker 8dd4:** Rethinking sock two for this family law thing.\n\n" +
    "**[9:40] Speaker 8dd4:** It is a certification for how you receive, store, and send data.\n\n" +
    "**[12:37] Speaker a8cb:** What if they say we cannot use it until the audit is done.\n\n" +
    "**[31:02] me:** Wisprflow launched meeting notes, that is straight up our lane.\n",
  "meta.json": JSON.stringify({
    started: "2026-09-21T17:30:30Z",
    duration_seconds: 3137,
    context: { app: "org.mozilla.firefox", title: "Meet - Ficra Team Sync" },
  }),
  "project.json": JSON.stringify({ people: ["Whisperflow"], projectId: "p-tui", name: "tui" }),
});
writeMeeting("2026.08.12-1634", {
  "summary.md": "# Bookkeeping sync\n\nQuickBooks reporting and the chart of accounts.\n",
});
// Still recording: audio only, nothing to read yet.
writeMeeting("2026.09.22-0900", { "meta.json": "{}" });

// Word search is tested without a model, as it runs on a Mac that has none.
const HistorySearchTest = HistorySearch.layerWith({ meetingsDir }).pipe(
  Layer.provide(Embedder.layerNone),
);

// A stand-in for the model: words that mean the same thing share an axis, and
// every other word gets a faint axis of its own. Enough to be a space in which
// "invoice" is near "billing" and far from "release".
const CONCEPTS: ReadonlyArray<ReadonlyArray<string>> = [
  ["billing", "invoice", "invoices", "charges", "payment", "owe", "customers"],
  ["release", "ship", "shipping", "publish", "deploy", "build"],
  ["texted", "imessage", "message", "sent", "send", "permission"],
];
const fakeVector = (text: string): Float32Array => {
  const vector = Array.from({ length: Embedder.DIMENSIONS }, () => 0);
  for (const word of text.toLowerCase().match(/[a-z]+/gu) ?? []) {
    const concept = CONCEPTS.findIndex((words) => words.includes(word));
    if (concept >= 0) {
      vector[concept] = (vector[concept] ?? 0) + 1;
    } else {
      let hash = 7;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 240;
      vector[8 + hash] = (vector[8 + hash] ?? 0) + 0.15;
    }
  }
  return Embedder.normalize(vector);
};
const FakeEmbedder = Layer.succeed(
  Embedder.Embedder,
  Embedder.Embedder.of({
    status: Effect.succeed({ available: true, model: "fake", reason: null }),
    embedDocuments: (texts) => Effect.succeed(texts.map(fakeVector)),
    embedQuery: (text) => Effect.succeed(fakeVector(text)),
  }),
);

const layer = it.layer(
  HistorySearchTest.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

const addProject = (id: string, title: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${id}, ${title}, ${`/tmp/${title}`}, '[]', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `;
  });

const addThread = (
  id: string,
  projectId: string,
  title: string,
  archivedAt: string | null = null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, archived_at)
      VALUES (${id}, ${projectId}, ${title}, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', ${archivedAt})
    `;
  });

const addMessage = (
  id: string,
  threadId: string,
  role: string,
  text: string,
  createdAt: string,
  isStreaming = 0,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${id}, ${threadId}, NULL, ${role}, ${text}, ${isStreaming}, ${createdAt}, ${createdAt})
    `;
  });

it("reads a sentence as quoted terms, dropping filler and splitting identifiers", () => {
  assert.deepStrictEqual(
    HistorySearch.queryTerms('how did we fix kea_ask in "the bridge" OR x').map((term) => term.fts),
    ['"fix"', '"kea ask"', '"the bridge"'],
  );
  assert.strictEqual(HistorySearch.editDistance("whisperflow", "wisprflow", 2), 2);
  assert.strictEqual(HistorySearch.editDistance("recieve", "receive", 1), 1);
  assert.isAbove(HistorySearch.editDistance("stripe", "plaid", 2), 2);
  assert.deepStrictEqual(HistorySearch.queryTerms("the of and"), []);
});

layer("HistorySearch", (it) => {
  it.effect("finds threads by stemmed words across projects and ranks coverage first", () =>
    Effect.gen(function* () {
      const search = yield* HistorySearch.HistorySearch;
      yield* addProject("p-tui", "tui");
      yield* addProject("p-web", "web");
      yield* addThread("t-imessage", "p-tui", "Simple Tasks");
      yield* addThread("t-noise", "p-web", "Newsletter", "2026-09-03T00:00:00.000Z");
      yield* addThread("t-caller", "p-tui", "Caller");
      yield* addMessage(
        "m1",
        "t-imessage",
        "user",
        "Hands sent an iMessage on its own, it should never press send for me",
        "2026-09-02T10:00:00.000Z",
      );
      yield* addMessage(
        "m2",
        "t-imessage",
        "assistant",
        "The loop's never-send guard relied on the model marking the call. Fixed in HandsLoop.swift.",
        "2026-09-02T10:05:00.000Z",
      );
      yield* addMessage(
        "m3",
        "t-noise",
        "assistant",
        "The newsletter job sends and sends and sends every hour; sending is its whole purpose.",
        "2026-09-02T11:00:00.000Z",
      );
      yield* addMessage(
        "m4",
        "t-caller",
        "user",
        "is the hands sending imessages bug fixed",
        "2026-09-02T12:00:00.000Z",
      );

      const found = yield* search.search({
        query: "hands sending iMessages on its own",
        sources: ["threads"],
        excludeThreadId: "t-caller",
      });
      // Two threads is thin, so each word also stood for what starts with it.
      assert.deepStrictEqual(found.terms, [
        '"hands" ~ hands*',
        '"sending" ~ sending*',
        '"imessages" ~ imessages*',
      ]);
      assert.isTrue(found.results.every((result) => result.kind === "thread"));
      assert.deepStrictEqual(
        found.results.map((result) => result.id),
        ["t-imessage", "t-noise"],
      );
      const best = found.results[0]!;
      assert.strictEqual(best.projectTitle, "tui");
      assert.strictEqual(best.matchedTerms, 3);
      assert.strictEqual(best.hits[0]?.messageId, "m1");
      assert.include(best.hits[0]?.snippet ?? "", "«iMessage»");
      assert.isNotNull(found.results[1]!.archivedAt);

      // Identifiers are phrases of their parts; a project filter narrows.
      const byFile = yield* search.search({ query: "HandsLoop.swift", projectId: "p-tui" });
      assert.deepStrictEqual(
        byFile.results.map((result) => result.id),
        ["t-imessage"],
      );
      const usersOnly = yield* search.search({ query: "newsletter sending", role: "user" });
      // A title is nobody's words, so it stays; what agents wrote does not.
      const roles = usersOnly.results.flatMap((result) => result.hits.map((hit) => hit.role));
      assert.include(roles, "user");
      assert.include(roles, "title");
      assert.notInclude(roles, "assistant");
    }),
  );

  it.effect("catches up with finished, edited and deleted messages, and with titles", () =>
    Effect.gen(function* () {
      const search = yield* HistorySearch.HistorySearch;
      const sql = yield* SqlClient.SqlClient;
      yield* addProject("p-sync", "sync");
      yield* addThread("t-sync", "p-sync", "Untitled");
      yield* addMessage("s1", "t-sync", "assistant", "zeppelin", "2026-09-05T10:00:00.000Z", 1);
      const ids = (query: string) =>
        search
          .search({ query, projectId: "p-sync" })
          .pipe(Effect.map((found) => found.results.map((result) => result.id)));

      // Still streaming: not indexed yet.
      assert.deepStrictEqual(yield* ids("zeppelin"), []);

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'zeppelin moored at the quay', is_streaming = 0, updated_at = '2026-09-05T10:01:00.000Z'
        WHERE message_id = 's1'
      `;
      yield* sql`UPDATE projection_threads SET title = 'Airship docking' WHERE thread_id = 't-sync'`;
      yield* TestClock.adjust("6 seconds");
      assert.deepStrictEqual(yield* ids("quay"), ["t-sync"]);
      assert.deepStrictEqual(yield* ids("airships"), ["t-sync"]);

      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 's1'`;
      yield* TestClock.adjust("6 seconds");
      assert.deepStrictEqual(yield* ids("quay"), []);
      assert.deepStrictEqual(yield* ids("untitled"), []);
    }),
  );

  it.effect("finds meetings beside threads, by notes and by the minute it was said", () =>
    Effect.gen(function* () {
      const search = yield* HistorySearch.HistorySearch;
      yield* addProject("p-soc", "compliance");
      yield* addThread("t-soc", "p-soc", "Audit prep");
      yield* addMessage(
        "c1",
        "t-soc",
        "user",
        "list the external systems we need for the SOC 2 audit",
        "2026-09-20T10:00:00.000Z",
      );

      yield* TestClock.adjust("6 seconds");
      const both = yield* search.search({ query: "SOC 2 compliance planning audit" });
      assert.deepStrictEqual(both.results.map((result) => `${result.kind}:${result.id}`).sort(), [
        "meeting:2026.09.21-1330",
        "thread:t-soc",
      ]);
      const meeting = both.results.find((result) => result.kind === "meeting")!;
      assert.strictEqual(meeting.title, "Meet - Ficra Team Sync");
      assert.strictEqual(meeting.date, "2026-09-21T17:30:30Z");
      assert.strictEqual(meeting.projectId, "p-tui");
      assert.strictEqual(meeting.hits[0]?.role, "notes");
      assert.notInclude(meeting.hits[0]?.snippet ?? "", "generated locally");

      // Said, not written down: the hit carries the minute to read around.
      const said = yield* search.search({
        query: "certification receive store",
        sources: ["meetings"],
      });
      assert.strictEqual(said.results[0]?.hits[0]?.role, "transcript");
      assert.strictEqual(said.results[0]?.hits[0]?.at, "8:51");

      // Filed under a project; a role is a thread's, so it leaves meetings out.
      const filed = yield* search.search({ query: "plaid", projectId: "p-tui" });
      assert.deepStrictEqual(
        filed.results.map((result) => result.id),
        ["2026.09.21-1330"],
      );
      const usersOnly = yield* search.search({ query: "plaid audit", role: "user" });
      assert.isTrue(usersOnly.results.every((result) => result.kind === "thread"));

      // A heading of its own is a better title than a folder name.
      const books = yield* search.search({ query: "quickbooks" });
      assert.strictEqual(books.results[0]?.title, "Bookkeeping sync");
    }),
  );

  it.effect("widens a word the index barely knows, and falls back to prefixes", () =>
    Effect.gen(function* () {
      const search = yield* HistorySearch.HistorySearch;
      // The recogniser wrote "Wisprflow"; the person asking spells it properly.
      const heard = yield* search.search({ query: "whisperflow", sources: ["meetings"] });
      assert.deepStrictEqual(
        heard.results.map((result) => result.id),
        ["2026.09.21-1330"],
      );
      assert.include(heard.terms[0] ?? "", "~ wisprflow");
      assert.include(heard.results[0]?.hits[0]?.snippet ?? "", "«Wisprflow»");

      // Half a word still lands.
      const half = yield* search.search({ query: "certif", sources: ["meetings"] });
      assert.deepStrictEqual(
        half.results.map((result) => result.id),
        ["2026.09.21-1330"],
      );
      assert.include(half.terms[0] ?? "", "certif*");
    }),
  );

  it.effect("lists meetings and reads one: its notes, or the minutes around a moment", () =>
    Effect.gen(function* () {
      const search = yield* HistorySearch.HistorySearch;
      const listed = yield* search.listMeetings({});
      // The one still recording has nothing to read and is not listed.
      assert.deepStrictEqual(
        listed.map((meeting) => meeting.id),
        ["2026.09.21-1330", "2026.08.12-1634"],
      );
      assert.deepStrictEqual(listed[0]?.people, ["Whisperflow"]);
      assert.strictEqual(listed[0]?.durationMinutes, 52);
      assert.lengthOf(yield* search.listMeetings({ since: "2026-09-01" }), 1);

      const notes = yield* search.readMeeting({ meetingId: "2026.09.21-1330" });
      assert.include(notes?.notes ?? "", "Follow up on Plaid by Friday");
      assert.notInclude(notes?.notes ?? "", "generated locally");
      assert.lengthOf(notes?.lines ?? [], 0);
      assert.isTrue(notes?.transcriptPath.endsWith("2026.09.21-1330/transcript.md"));

      const around = yield* search.readMeeting({
        meetingId: "2026.09.21-1330",
        around: "9:40",
        minutes: 1,
      });
      assert.isNull(around?.notes ?? null);
      assert.deepStrictEqual(
        around?.lines.map((line) => line.at),
        ["8:51", "9:40"],
      );
      assert.isFalse(around?.hasEarlier);
      assert.isTrue(around?.hasLater);

      assert.isNull(yield* search.readMeeting({ meetingId: "../../etc" }));
      assert.isNull(yield* search.readMeeting({ meetingId: "2030.01.01-0000" }));
    }),
  );

  it.effect("reads a window around a message and the tail of an archived thread", () =>
    Effect.gen(function* () {
      const search = yield* HistorySearch.HistorySearch;
      yield* addProject("p-read", "read");
      yield* addThread("t-read", "p-read", "Long one", "2026-09-06T00:00:00.000Z");
      for (let index = 0; index < 9; index++) {
        yield* addMessage(
          `r${index}`,
          "t-read",
          index % 2 === 0 ? "user" : "assistant",
          `message ${index}`,
          `2026-09-05T10:0${index}:00.000Z`,
        );
      }
      const around = yield* search.readMessages({
        threadId: "t-read",
        aroundMessageId: "r4",
        before: 1,
        after: 2,
      });
      assert.deepStrictEqual(
        around?.messages.map((message) => message.id),
        ["r3", "r4", "r5", "r6"],
      );
      assert.isTrue(around?.hasOlder);
      assert.isTrue(around?.hasNewer);

      const tail = yield* search.readMessages({ threadId: "t-read", before: 1, after: 1 });
      assert.deepStrictEqual(
        tail?.messages.map((message) => message.id),
        ["r6", "r7", "r8"],
      );
      assert.isTrue(tail?.hasOlder);
      assert.isNull(yield* search.readMessages({ threadId: "t-nowhere" }));
    }),
  );
});

it.effect("builds the index at launch and folds in new messages as thread events arrive", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const persistence = SqlitePersistenceMemory;
    const seeded = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* addProject("p-live", "live");
        yield* addThread("t-live", "p-live", "Live");
        yield* addMessage("l1", "t-live", "user", "gondola", "2026-09-07T10:00:00.000Z");
      }),
    );
    const live = HistorySearch.followLayer.pipe(
      Layer.provideMerge(HistorySearchTest),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({ streamDomainEvents: Stream.fromQueue(events) }),
      ),
      Layer.provideMerge(seeded),
      Layer.provideMerge(persistence),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const indexed = (word: string) =>
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM roost_history_search WHERE roost_history_search MATCH ${word}
        `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

      // Nobody has searched: the launch build alone put it there.
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* indexed("gondola"), 1);

      yield* addMessage("l2", "t-live", "assistant", "funicular", "2026-09-07T10:01:00.000Z");
      yield* TestClock.adjust("4 seconds");
      // Nothing said anything moved, so nothing was read.
      assert.strictEqual(yield* indexed("funicular"), 0);

      yield* Queue.offer(events, { type: "thread.message-sent" } as OrchestrationEvent);
      yield* TestClock.adjust("4 seconds");
      assert.strictEqual(yield* indexed("funicular"), 1);
    }).pipe(Effect.provide(live));
  }),
);

it.effect("finds by meaning what shares no word with the question, and says which way", () =>
  Effect.gen(function* () {
    const search = yield* HistorySearch.HistorySearch;
    yield* addProject("p-ops", "ops");
    yield* addThread("t-billing", "p-ops", "Spreadsheet");
    yield* addThread("t-release", "p-ops", "Cut");
    yield* addMessage(
      "b1",
      "t-billing",
      "user",
      "look into the billing from today, the spreadsheet of charges is in the root",
      "2026-09-10T10:00:00.000Z",
    );
    yield* addMessage(
      "r1",
      "t-release",
      "user",
      "publish the release and deploy the new build tonight",
      "2026-09-10T11:00:00.000Z",
    );
    // A one-line aside from an agent is indexed for words, not worth a vector.
    yield* addMessage("r2", "t-release", "assistant", "on it", "2026-09-10T11:01:00.000Z");

    const ask = () =>
      search.search({ query: "invoice customers what they owe", sources: ["threads"] });
    const indexed = yield* search.refresh;
    assert.strictEqual(indexed.embedded, 0);
    const before = yield* ask();
    assert.isFalse(before.meaning.active);
    assert.lengthOf(before.results, 0);

    // The embedder trails the index in the background.
    yield* TestClock.adjust("21 seconds");
    const state = yield* search.refresh;
    assert.strictEqual(state.toEmbed, 0);
    // Two user messages, and the fixture meetings: two sets of notes and one transcript passage.
    assert.strictEqual(state.embedded, 2 + 3);

    const found = yield* ask();
    assert.isTrue(found.meaning.active);
    assert.isNull(found.meaning.reason);
    assert.deepStrictEqual(
      found.results.map((result) => result.id),
      ["t-billing"],
    );
    assert.strictEqual(found.results[0]?.matchedBy, "meaning");
    assert.strictEqual(found.results[0]?.hits[0]?.matchedBy, "meaning");
    assert.strictEqual(found.results[0]?.hits[0]?.messageId, "b1");
    assert.include(found.results[0]?.hits[0]?.snippet ?? "", "spreadsheet of charges");

    // Found both ways outranks found one way.
    const both = yield* search.search({ query: "billing charges owed", sources: ["threads"] });
    assert.strictEqual(both.results[0]?.matchedBy, "both");
    assert.strictEqual(both.results[0]?.score, 100);

    // A deleted message takes its vector with it.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'b1'`;
    yield* TestClock.adjust("6 seconds");
    assert.lengthOf((yield* ask()).results, 0);
    const vectors = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM roost_history_vectors
    `;
    assert.strictEqual(vectors[0]?.count, 1 + 3);
  }).pipe(
    Effect.provide(
      HistorySearch.layerWith({ meetingsDir }).pipe(
        Layer.provide(FakeEmbedder),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it("keeps a vector's direction through a byte per dimension", () => {
  const a = fakeVector("billing invoice charges for the customers");
  const b = fakeVector("what customers owe in payment");
  const c = fakeVector("publish the release build");
  const cosine = (x: Float32Array, bytes: Uint8Array) => {
    const y = new Int8Array(bytes.buffer);
    let dot = 0;
    let norm = 0;
    for (let index = 0; index < x.length; index++) {
      dot += x[index]! * y[index]!;
      norm += y[index]! * y[index]!;
    }
    return dot / Math.sqrt(norm);
  };
  assert.isAbove(cosine(a, Embedder.quantize(b)), 0.9);
  assert.isBelow(cosine(a, Embedder.quantize(c)), 0.2);
});

it.effect("keeps a record of its use: the search, what was opened from it, and the verdict", () =>
  Effect.gen(function* () {
    const search = yield* HistorySearch.HistorySearch;
    const sql = yield* SqlClient.SqlClient;
    yield* addProject("p-use", "use");
    yield* addThread("t-answer", "p-use", "Answer");
    yield* addThread("t-other", "p-use", "Other");
    yield* addMessage(
      "u1",
      "t-answer",
      "user",
      "the gondola cable snapped",
      "2026-09-11T10:00:00.000Z",
    );
    yield* addMessage("u2", "t-other", "user", "gondola tickets", "2026-09-11T10:01:00.000Z");
    yield* search.refresh;

    const caller = { threadId: "t-asker", provider: "codex" };
    const found = yield* search.search({ query: "gondola cable", sources: ["threads"], caller });
    assert.isNotNull(found.searchId);
    // Not recorded without a caller: tests, the evaluation, internal use.
    assert.isNull((yield* search.search({ query: "gondola" })).searchId);

    yield* search.recordOpen({ callerThreadId: "t-asker", kind: "thread", id: "t-other" });
    yield* search.recordOpen({ callerThreadId: "t-asker", kind: "thread", id: "t-unrelated" });
    const filed = yield* search.recordFeedback({
      callerThreadId: "t-asker",
      found: false,
      note: "  wanted the snapped cable thread first  ",
    });
    assert.strictEqual(filed, found.searchId);

    const rows = yield* sql<{
      readonly kind: string;
      readonly query: string | null;
      readonly results: string | null;
      readonly searchId: number | null;
      readonly openedId: string | null;
      readonly openedRank: number | null;
      readonly found: number | null;
      readonly note: string | null;
    }>`
      SELECT kind AS "kind", query AS "query", results AS "results", search_id AS "searchId",
        opened_id AS "openedId", opened_rank AS "openedRank", found AS "found", note AS "note"
      FROM roost_history_usage ORDER BY id
    `;
    assert.deepStrictEqual(
      rows.map((row) => row.kind),
      ["search", "open", "open", "feedback"],
    );
    assert.strictEqual(rows[0]?.query, "gondola cable");
    assert.match(rows[0]?.results ?? "", /^1\tthread\tt-answer\t\d+\twords\n2\tthread\tt-other\t/u);
    // Opened from second place; the other read had nothing to do with a search.
    assert.deepInclude(rows[1], { searchId: found.searchId, openedId: "t-other", openedRank: 2 });
    assert.deepInclude(rows[2], { searchId: null, openedId: "t-unrelated", openedRank: null });
    assert.deepInclude(rows[3], {
      searchId: found.searchId,
      found: 0,
      note: "wanted the snapped cable thread first",
    });
  }).pipe(
    Effect.provide(
      HistorySearchTest.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
