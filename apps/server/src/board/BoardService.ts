// Roost's card wall: a stage per thread, kept in its own table beside T3's
// state. Not a numbered migration — those are upstream's — so the table is
// created here, idempotently, when the service starts.
import type { BoardCard, BoardStage, BoardSubCards, BoardSummary } from "@t3tools/contracts";
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
  readonly card: (threadId: string) => Effect.Effect<BoardCard | null, BoardError>;
  readonly summaries: Effect.Effect<ReadonlyArray<BoardSummary>, BoardError>;
  readonly saveSummary: (summary: BoardSummary) => Effect.Effect<void, BoardError>;
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
    movedBy: row.moved_by === "agent" || row.moved_by === "auto" ? row.moved_by : "user",
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

  yield* sql`
    CREATE TABLE IF NOT EXISTS roost_board_summaries (
      thread_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      next TEXT NOT NULL,
      suggested_stage TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL,
      summarized_at TEXT NOT NULL
    )
  `.pipe(Effect.mapError(failed));

  const summaries = sql<{
    readonly thread_id: string;
    readonly summary: string;
    readonly next: string;
    readonly suggested_stage: string;
    readonly reason: string;
    readonly confidence: number;
    readonly summarized_at: string;
  }>`SELECT * FROM roost_board_summaries`.pipe(
    Effect.map((rows) =>
      rows.map(
        (row) =>
          ({
            threadId: row.thread_id,
            summary: row.summary,
            next: row.next,
            suggestedStage: row.suggested_stage,
            reason: row.reason,
            confidence: row.confidence,
            summarizedAt: row.summarized_at,
          }) as BoardSummary,
      ),
    ),
    Effect.mapError(failed),
  );

  const saveSummary = (summary: BoardSummary) =>
    sql`
      INSERT INTO roost_board_summaries
        (thread_id, summary, next, suggested_stage, reason, confidence, summarized_at)
      VALUES (${summary.threadId}, ${summary.summary}, ${summary.next}, ${summary.suggestedStage},
        ${summary.reason}, ${summary.confidence}, ${summary.summarizedAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        summary = excluded.summary,
        next = excluded.next,
        suggested_stage = excluded.suggested_stage,
        reason = excluded.reason,
        confidence = excluded.confidence,
        summarized_at = excluded.summarized_at
    `.pipe(Effect.asVoid, Effect.mapError(failed));

  const card = (threadId: string) =>
    sql<CardRow>`
      SELECT thread_id, stage, moved_at, moved_by FROM roost_board_cards
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toCard(rows[0]))),
      Effect.mapError(failed),
    );

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

  return BoardService.of({ list, subCards, move, card, summaries, saveSummary });
});

export const layer = Layer.effect(BoardService, make);
