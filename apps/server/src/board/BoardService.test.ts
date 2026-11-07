import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardService from "./BoardService.ts";

const layer = it.layer(BoardService.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)));

layer("BoardService", (it) => {
  it.effect("places cards, moves them again, and keeps who moved them last", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      assert.deepStrictEqual(yield* board.list, []);

      yield* board.move({ threadIds: ["a", "b", "a"], stage: "fix", movedBy: "user" });
      yield* board.move({ threadIds: ["b"], stage: "review", movedBy: "agent" });

      const cards = (yield* board.list).toSorted((x, y) => x.threadId.localeCompare(y.threadId));
      assert.deepStrictEqual(
        cards.map((card) => [card.threadId, card.stage, card.movedBy]),
        [
          ["a", "fix", "user"],
          ["b", "review", "agent"],
        ],
      );
    }),
  );

  it.effect("counts each thread's subagent children, done when archived or deployed", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-01T00:00:00.000Z";
      const child = (id: string, parent: string, relationship: string, archived: boolean) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, payload_json
        ) VALUES (
          ${id}, 'p', ${id}, 'codex', 'full-access', 'default', ${at}, ${at},
          ${archived ? at : null},
          ${JSON.stringify({ lineage: { parentThreadId: parent, relationshipToParent: relationship } })}
        )
      `;
      yield* child("c1", "owner", "subagent", false);
      yield* child("c2", "owner", "subagent", true);
      yield* child("c3", "owner", "subagent", false);
      yield* child("f1", "owner", "fork", false);
      yield* board.move({ threadIds: ["c3"], stage: "deployed", movedBy: "agent" });
      assert.deepStrictEqual(
        (yield* board.subCards).map((count) => [count.threadId as string, count.total, count.done]),
        [["owner", 3, 2]],
      );
    }),
  );
});
