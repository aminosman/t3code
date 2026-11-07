import { assert, it } from "@effect/vitest";
import { DEFAULT_BOARD_COLUMNS } from "@t3tools/contracts";
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

  it.effect(
    "starts with the default columns, saves edits in order, and refuses an unusable board",
    () =>
      Effect.gen(function* () {
        const board = yield* BoardService.BoardService;
        assert.deepStrictEqual(yield* board.columns, DEFAULT_BOARD_COLUMNS);
        const edited = [
          {
            id: "todo",
            title: "To do",
            description: "Not started.",
            archives: false,
            requireApprovalIn: [],
            checks: [],
          },
          {
            id: "qa",
            title: "QA",
            description: "On staging, waiting for QA.",
            archives: false,
            requireApprovalIn: ["project-careday"],
            checks: [{ kind: "merged" as const, into: "staging" }, { kind: "tests" as const }],
          },
          {
            id: "done",
            title: "Done",
            description: "Shipped.",
            archives: true,
            requireApprovalIn: ["*"],
            checks: [],
          },
        ];
        yield* board.setColumns(edited);
        assert.deepStrictEqual(yield* board.columns, edited);
        const refused = yield* board
          .setColumns(edited.filter((column) => !column.archives))
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "Keep at least one archiving column.");
        assert.deepStrictEqual(yield* board.columns, edited);
      }),
  );

  it.effect("files an approval request once, grants it, and spends it", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const asked = yield* board.requestApproval({
        threadId: "t",
        stage: "merged",
        note: "merge to main",
      });
      assert.strictEqual(asked.status, "pending");
      const again = yield* board.requestApproval({ threadId: "t", stage: "merged", note: "again" });
      assert.strictEqual(again.note, "merge to main");
      const declined = yield* board.decideApproval({
        threadId: "t",
        stage: "merged",
        approve: false,
        note: "not yet",
      });
      assert.strictEqual(declined.status, "declined");
      // Declined: asking again files a fresh request.
      assert.strictEqual(
        (yield* board.requestApproval({ threadId: "t", stage: "merged", note: "retry" })).status,
        "pending",
      );
      yield* board.decideApproval({ threadId: "t", stage: "merged", approve: true, note: "" });
      assert.strictEqual(
        (yield* board.requestApproval({ threadId: "t", stage: "merged", note: "" })).status,
        "approved",
      );
      yield* board.useApproval("t", "merged");
      assert.deepStrictEqual(yield* board.approvals, []);
    }),
  );

  it.effect(
    "assigns a card, placing it if it was never placed, and keeps its comments in order",
    () =>
      Effect.gen(function* () {
        const board = yield* BoardService.BoardService;
        yield* board.assign("fresh", "user");
        const placed = yield* board.card("fresh");
        const firstOpen = (yield* board.columns).find((column) => !column.archives)?.id;
        assert.deepStrictEqual([placed?.stage, placed?.assignee], [firstOpen, "user"]);
        // Moving keeps the assignee.
        yield* board.move({ threadIds: ["fresh"], stage: "qa", movedBy: "agent" });
        assert.strictEqual((yield* board.card("fresh"))?.assignee, "user");
        yield* board.comment("fresh", "agent", "Please sign in.");
        yield* board.comment("fresh", "user", "Done.");
        assert.deepStrictEqual(
          (yield* board.comments("fresh")).map((entry) => [entry.author, entry.body]),
          [
            ["agent", "Please sign in."],
            ["user", "Done."],
          ],
        );
        const [summary] = yield* board.commentSummaries;
        assert.deepStrictEqual([summary?.count, summary?.last.body], [2, "Done."]);
      }),
  );
});
