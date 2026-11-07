// Roost's card wall: a stage per thread, kept in its own table beside T3's
// state. Not a numbered migration — those are upstream's — so the table is
// created here, idempotently, when the service starts.
import type { BoardCard, BoardStage, BoardSubCards } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class BoardError extends Schema.TaggedError<BoardError>()("BoardError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export interface BoardServiceShape {
  readonly list: Effect.Effect<ReadonlyArray<BoardCard>, BoardError>;
  /** Each thread's subagent children, counted here because shells omit idle ones. */
  readonly subCards: Effect.Effect<ReadonlyArray<BoardSubCards>, BoardError>;
  readonly move: (input: {
    readonly threadIds: ReadonlyArray<string>;
    readonly stage: BoardStage;
    readonly movedBy: BoardCard["movedBy"];
  }) => Effect.Effect<ReadonlyArray<BoardCard>, BoardError>;
}

export class BoardService extends Context.Service<BoardService, BoardServiceShape>()(
  "t3/board/BoardService",
) {}

interface CardRow {
  readonly thread_id: string;
  readonly stage: string;
  readonly moved_at: string;
  readonly moved_by: string;
}

const toCard = (row: CardRow): BoardCard =>
  ({
    threadId: row.thread_id,
    stage: row.stage,
    movedAt: row.moved_at,
    movedBy: row.moved_by === "agent" ? "agent" : "user",
  }) as BoardCard;

const failed = (cause: unknown) =>
  new BoardError({ reason: cause instanceof Error ? cause.message : String(cause) });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS roost_board_cards (
      thread_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      moved_at TEXT NOT NULL,
      moved_by TEXT NOT NULL
    )
  `.pipe(Effect.mapError(failed));

  const list = sql<CardRow>`
    SELECT thread_id, stage, moved_at, moved_by FROM roost_board_cards
  `.pipe(
    Effect.map((rows) => rows.map(toCard)),
    Effect.mapError(failed),
  );

  const move: BoardServiceShape["move"] = Effect.fn("BoardService.move")(function* ({
    threadIds,
    stage,
    movedBy,
  }) {
    const movedAt = DateTime.formatIso(yield* DateTime.now);
    const ids = [...new Set(threadIds)];
    yield* sql.withTransaction(
      Effect.forEach(
        ids,
        (threadId) => sql`
            INSERT INTO roost_board_cards (thread_id, stage, moved_at, moved_by)
            VALUES (${threadId}, ${stage}, ${movedAt}, ${movedBy})
            ON CONFLICT (thread_id) DO UPDATE SET
              stage = excluded.stage,
              moved_at = excluded.moved_at,
              moved_by = excluded.moved_by
          `,
        { discard: true },
      ),
    );
    return ids.map((threadId) =>
      toCard({ thread_id: threadId, stage, moved_at: movedAt, moved_by: movedBy }),
    );
  }, Effect.mapError(failed));

  const subCards = sql<{ thread_id: string; total: number; done: number }>`
    SELECT
      json_extract(t.payload_json, '$.lineage.parentThreadId') AS thread_id,
      COUNT(*) AS total,
      SUM(CASE WHEN t.archived_at IS NOT NULL OR c.stage = 'deployed' THEN 1 ELSE 0 END) AS done
    FROM orchestration_v2_projection_threads t
    LEFT JOIN roost_board_cards c ON c.thread_id = t.thread_id
    WHERE t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
    GROUP BY 1
  `.pipe(
    Effect.map((rows) =>
      rows.map(
        (row) => ({ threadId: row.thread_id, total: row.total, done: row.done }) as BoardSubCards,
      ),
    ),
    // A server without the V2 projection has no sub-threads to count.
    Effect.orElseSucceed((): ReadonlyArray<BoardSubCards> => []),
  );

  return BoardService.of({ list, subCards, move });
});

export const layer = Layer.effect(BoardService, make);
