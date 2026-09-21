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
import * as ThreadSearch from "./ThreadSearch.ts";

const layer = it.layer(ThreadSearch.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

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
  assert.deepStrictEqual(ThreadSearch.queryTerms('how did we fix kea_ask in "the bridge" OR x'), [
    '"fix"',
    '"kea ask"',
    '"the bridge"',
  ]);
  assert.deepStrictEqual(ThreadSearch.queryTerms("the of and"), []);
});

layer("ThreadSearch", (it) => {
  it.effect("finds threads by stemmed words across projects and ranks coverage first", () =>
    Effect.gen(function* () {
      const search = yield* ThreadSearch.ThreadSearch;
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
        excludeThreadId: "t-caller",
      });
      assert.deepStrictEqual(found.terms, ['"hands"', '"sending"', '"imessages"']);
      assert.deepStrictEqual(
        found.results.map((result) => result.threadId),
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
        byFile.results.map((result) => result.threadId),
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
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      yield* addProject("p-sync", "sync");
      yield* addThread("t-sync", "p-sync", "Untitled");
      yield* addMessage("s1", "t-sync", "assistant", "zeppelin", "2026-09-05T10:00:00.000Z", 1);
      const ids = (query: string) =>
        search
          .search({ query, projectId: "p-sync" })
          .pipe(Effect.map((found) => found.results.map((result) => result.threadId)));

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

  it.effect("reads a window around a message and the tail of an archived thread", () =>
    Effect.gen(function* () {
      const search = yield* ThreadSearch.ThreadSearch;
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
    const live = ThreadSearch.followLayer.pipe(
      Layer.provideMerge(ThreadSearch.layer),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({ streamDomainEvents: Stream.fromQueue(events) }),
      ),
      Layer.provideMerge(seeded),
      Layer.provideMerge(persistence),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const indexed = (word: string) =>
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM roost_thread_search WHERE roost_thread_search MATCH ${word}
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
