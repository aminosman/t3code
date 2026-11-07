// Roost's card wall: a stage per thread, kept in its own table beside T3's
// state. Not a numbered migration — those are upstream's — so the table is
// created here, idempotently, when the service starts.
import {
  type BoardApproval,
  type BoardAssignee,
  type BoardCard,
  type BoardComment,
  type BoardCommentsSummary,
  type BoardColumn,
  type BoardStage,
  type BoardSubCards,
  type BoardSummary,
  boardColumnsProblem,
  DEFAULT_BOARD_COLUMNS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  /** The user's columns, in order; the defaults until they are edited. */
  readonly columns: Effect.Effect<ReadonlyArray<BoardColumn>, BoardError>;
  /** Requests waiting on the user, and approvals not yet used. */
  readonly approvals: Effect.Effect<ReadonlyArray<BoardApproval>, BoardError>;
  /** Files a request, or returns the one already filed or granted. */
  readonly requestApproval: (input: {
    readonly threadId: string;
    readonly stage: BoardStage;
    readonly note: string;
  }) => Effect.Effect<BoardApproval, BoardError>;
  readonly decideApproval: (input: {
    readonly threadId: string;
    readonly stage: BoardStage;
    readonly approve: boolean;
    readonly note: string;
  }) => Effect.Effect<BoardApproval, BoardError>;
  /** Hands the card to the agent or the user, placing it first if it was never placed. */
  readonly assign: (threadId: string, assignee: BoardAssignee) => Effect.Effect<void, BoardError>;
  /** The branch the work lives on, as the agent names it; null clears it. */
  readonly setBranch: (threadId: string, branch: string | null) => Effect.Effect<void, BoardError>;
  readonly comments: (threadId: string) => Effect.Effect<ReadonlyArray<BoardComment>, BoardError>;
  readonly comment: (
    threadId: string,
    author: BoardAssignee,
    body: string,
  ) => Effect.Effect<BoardComment, BoardError>;
  /** Each card's comment count and latest comment. */
  readonly commentSummaries: Effect.Effect<ReadonlyArray<BoardCommentsSummary>, BoardError>;
  /** Spends a granted approval once the card has moved. */
  readonly useApproval: (threadId: string, stage: BoardStage) => Effect.Effect<void, BoardError>;
  readonly setColumns: (
    columns: ReadonlyArray<BoardColumn>,
  ) => Effect.Effect<ReadonlyArray<BoardColumn>, BoardError>;
}

export class BoardService extends Context.Service<BoardService, BoardServiceShape>()(
  "t3/board/BoardService",
) {}

interface CardRow {
  readonly thread_id: string;
  readonly stage: string;
  readonly moved_at: string;
  readonly moved_by: string;
  readonly assignee: string | null;
  readonly branch: string | null;
}

const toCard = (row: CardRow): BoardCard =>
  ({
    threadId: row.thread_id,
    stage: row.stage,
    movedAt: row.moved_at,
    movedBy: row.moved_by === "agent" || row.moved_by === "auto" ? row.moved_by : "user",
    assignee: row.assignee === "user" ? "user" : "agent",
    branch: row.branch ?? null,
  }) as BoardCard;

const Reviewers = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeReviewers = Schema.encodeSync(Reviewers);
const decodeReviewersOption = Schema.decodeUnknownOption(Reviewers);
const decodeReviewers = (text: string | null): ReadonlyArray<string> | null =>
  text === null ? null : (decodeReviewersOption(text).pipe(Option.getOrNull) ?? null);

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
  const cardFields = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(roost_board_cards)`.pipe(
      Effect.mapError(failed),
    )).map((row) => row.name),
  );
  if (!cardFields.has("branch")) {
    yield* sql`ALTER TABLE roost_board_cards ADD COLUMN branch TEXT`.pipe(Effect.mapError(failed));
  }
  if (!cardFields.has("assignee")) {
    yield* sql`ALTER TABLE roost_board_cards ADD COLUMN assignee TEXT NOT NULL DEFAULT 'agent'`.pipe(
      Effect.mapError(failed),
    );
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS roost_board_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.pipe(Effect.mapError(failed));
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_roost_board_comments_thread
    ON roost_board_comments (thread_id, id)
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
  // Added after the table first shipped; older stores gain them here.
  const summaryColumns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(roost_board_summaries)`.pipe(
      Effect.mapError(failed),
    )).map((row) => row.name),
  );
  if (!summaryColumns.has("source")) {
    yield* sql`ALTER TABLE roost_board_summaries ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'`.pipe(
      Effect.mapError(failed),
    );
  }
  if (!summaryColumns.has("reviewed_by")) {
    yield* sql`ALTER TABLE roost_board_summaries ADD COLUMN reviewed_by TEXT`.pipe(
      Effect.mapError(failed),
    );
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS roost_board_columns (
      position INTEGER NOT NULL,
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      archives INTEGER NOT NULL
    )
  `.pipe(Effect.mapError(failed));

  const columnFields = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(roost_board_columns)`.pipe(
      Effect.mapError(failed),
    )).map((row) => row.name),
  );
  if (!columnFields.has("require_approval_in")) {
    yield* sql`ALTER TABLE roost_board_columns ADD COLUMN require_approval_in TEXT`.pipe(
      Effect.mapError(failed),
    );
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS roost_board_approvals (
      thread_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      note TEXT NOT NULL,
      PRIMARY KEY (thread_id, stage)
    )
  `.pipe(Effect.mapError(failed));

  const columns = sql<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly archives: number;
    readonly require_approval_in: string | null;
  }>`SELECT id, title, description, archives, require_approval_in FROM roost_board_columns ORDER BY position`.pipe(
    Effect.map((rows) =>
      rows.length === 0
        ? DEFAULT_BOARD_COLUMNS
        : rows.map(
            (row) =>
              ({
                id: row.id,
                title: row.title,
                description: row.description,
                archives: row.archives === 1,
                requireApprovalIn: decodeReviewers(row.require_approval_in) ?? [],
              }) as BoardColumn,
          ),
    ),
    Effect.mapError(failed),
  );

  const setColumns: BoardServiceShape["setColumns"] = Effect.fn("BoardService.setColumns")(
    function* (next) {
      const problem = boardColumnsProblem(next);
      if (problem !== null) return yield* new BoardError({ reason: problem });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM roost_board_columns`;
          yield* Effect.forEach(
            next,
            (column, position) => sql`
              INSERT INTO roost_board_columns
                (position, id, title, description, archives, require_approval_in)
              VALUES (${position}, ${column.id}, ${column.title}, ${column.description},
                ${column.archives ? 1 : 0}, ${encodeReviewers(column.requireApprovalIn ?? [])})
            `,
            { discard: true },
          );
        }),
      );
      return next;
    },
    Effect.mapError(failed),
  );

  interface ApprovalRow {
    readonly thread_id: string;
    readonly stage: string;
    readonly status: string;
    readonly requested_at: string;
    readonly decided_at: string | null;
    readonly note: string;
  }
  const toApproval = (row: ApprovalRow): BoardApproval =>
    ({
      threadId: row.thread_id,
      stage: row.stage,
      status: row.status === "approved" || row.status === "declined" ? row.status : "pending",
      requestedAt: row.requested_at,
      decidedAt: row.decided_at,
      note: row.note,
    }) as BoardApproval;
  const findApproval = (threadId: string, stage: string) =>
    sql<ApprovalRow>`
      SELECT * FROM roost_board_approvals WHERE thread_id = ${threadId} AND stage = ${stage}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toApproval(rows[0]))));

  const approvals = sql<ApprovalRow>`
    SELECT * FROM roost_board_approvals WHERE status IN ('pending', 'approved')
  `.pipe(
    Effect.map((rows) => rows.map(toApproval)),
    Effect.mapError(failed),
  );

  const requestApproval: BoardServiceShape["requestApproval"] = Effect.fn(
    "BoardService.requestApproval",
  )(function* ({ threadId, stage, note }) {
    const existing = yield* findApproval(threadId, stage);
    if (existing !== null && existing.status !== "declined") return existing;
    const requestedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
        INSERT INTO roost_board_approvals (thread_id, stage, status, requested_at, decided_at, note)
        VALUES (${threadId}, ${stage}, 'pending', ${requestedAt}, NULL, ${note})
        ON CONFLICT (thread_id, stage) DO UPDATE SET
          status = 'pending', requested_at = excluded.requested_at, decided_at = NULL,
          note = excluded.note
      `;
    return toApproval({
      thread_id: threadId,
      stage,
      status: "pending",
      requested_at: requestedAt,
      decided_at: null,
      note,
    });
  }, Effect.mapError(failed));

  const decideApproval: BoardServiceShape["decideApproval"] = Effect.fn(
    "BoardService.decideApproval",
  )(function* ({ threadId, stage, approve, note }) {
    const decidedAt = DateTime.formatIso(yield* DateTime.now);
    const existing = yield* findApproval(threadId, stage);
    const status = approve ? "approved" : "declined";
    const kept = approve ? (existing?.note ?? note) : note;
    yield* sql`
        INSERT INTO roost_board_approvals (thread_id, stage, status, requested_at, decided_at, note)
        VALUES (${threadId}, ${stage}, ${status}, ${existing?.requestedAt ?? decidedAt},
          ${decidedAt}, ${kept})
        ON CONFLICT (thread_id, stage) DO UPDATE SET
          status = excluded.status, decided_at = excluded.decided_at, note = excluded.note
      `;
    return toApproval({
      thread_id: threadId,
      stage,
      status,
      requested_at: existing?.requestedAt ?? decidedAt,
      decided_at: decidedAt,
      note: kept,
    });
  }, Effect.mapError(failed));

  const useApproval = (threadId: string, stage: string) =>
    sql`DELETE FROM roost_board_approvals WHERE thread_id = ${threadId} AND stage = ${stage}`.pipe(
      Effect.asVoid,
      Effect.mapError(failed),
    );

  const summaries = sql<{
    readonly thread_id: string;
    readonly summary: string;
    readonly next: string;
    readonly suggested_stage: string;
    readonly reason: string;
    readonly confidence: number;
    readonly summarized_at: string;
    readonly source: string;
    readonly reviewed_by: string | null;
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
            source: row.source === "agent" ? "agent" : "auto",
            reviewedBy: decodeReviewers(row.reviewed_by),
          }) as BoardSummary,
      ),
    ),
    Effect.mapError(failed),
  );

  const saveSummary = (summary: BoardSummary) =>
    sql`
      INSERT INTO roost_board_summaries
        (thread_id, summary, next, suggested_stage, reason, confidence, summarized_at, source,
         reviewed_by)
      VALUES (${summary.threadId}, ${summary.summary}, ${summary.next}, ${summary.suggestedStage},
        ${summary.reason}, ${summary.confidence}, ${summary.summarizedAt}, ${summary.source},
        ${summary.reviewedBy === null ? null : encodeReviewers(summary.reviewedBy)})
      ON CONFLICT (thread_id) DO UPDATE SET
        source = excluded.source,
        reviewed_by = excluded.reviewed_by,
        summary = excluded.summary,
        next = excluded.next,
        suggested_stage = excluded.suggested_stage,
        reason = excluded.reason,
        confidence = excluded.confidence,
        summarized_at = excluded.summarized_at
    `.pipe(Effect.asVoid, Effect.mapError(failed));

  const card = (threadId: string) =>
    sql<CardRow>`
      SELECT thread_id, stage, moved_at, moved_by, assignee, branch FROM roost_board_cards
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toCard(rows[0]))),
      Effect.mapError(failed),
    );

  const list = sql<CardRow>`
    SELECT thread_id, stage, moved_at, moved_by, assignee, branch FROM roost_board_cards
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
    const rows = yield* sql<CardRow>`
      SELECT thread_id, stage, moved_at, moved_by, assignee, branch FROM roost_board_cards
      WHERE ${sql.in("thread_id", ids)}
    `;
    return rows.map(toCard);
  }, Effect.mapError(failed));

  const assign: BoardServiceShape["assign"] = Effect.fn("BoardService.assign")(function* (
    threadId,
    assignee,
  ) {
    const placed = yield* card(threadId);
    if (placed === null) {
      // An unplaced card is placed where it shows: the first open column.
      const first = (yield* columns).find((column) => !column.archives);
      yield* move({ threadIds: [threadId], stage: first?.id ?? "research", movedBy: "user" });
    }
    yield* sql`UPDATE roost_board_cards SET assignee = ${assignee} WHERE thread_id = ${threadId}`;
  }, Effect.mapError(failed));

  const setBranch: BoardServiceShape["setBranch"] = Effect.fn("BoardService.setBranch")(function* (
    threadId,
    branch,
  ) {
    if ((yield* card(threadId)) === null) {
      const first = (yield* columns).find((column) => !column.archives);
      yield* move({ threadIds: [threadId], stage: first?.id ?? "research", movedBy: "agent" });
    }
    yield* sql`UPDATE roost_board_cards SET branch = ${branch} WHERE thread_id = ${threadId}`;
  }, Effect.mapError(failed));

  interface CommentRow {
    readonly id: number;
    readonly thread_id: string;
    readonly author: string;
    readonly body: string;
    readonly created_at: string;
  }
  const toComment = (row: CommentRow): BoardComment =>
    ({
      id: row.id,
      threadId: row.thread_id,
      author: row.author === "agent" ? "agent" : "user",
      body: row.body,
      createdAt: row.created_at,
    }) as BoardComment;

  const comments = (threadId: string) =>
    sql<CommentRow>`
      SELECT * FROM roost_board_comments WHERE thread_id = ${threadId} ORDER BY id
    `.pipe(
      Effect.map((rows) => rows.map(toComment)),
      Effect.mapError(failed),
    );

  const comment: BoardServiceShape["comment"] = Effect.fn("BoardService.comment")(function* (
    threadId,
    author,
    body,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql<CommentRow>`
        INSERT INTO roost_board_comments (thread_id, author, body, created_at)
        VALUES (${threadId}, ${author}, ${body}, ${createdAt})
        RETURNING *
      `;
    return toComment(rows[0]!);
  }, Effect.mapError(failed));

  const commentSummaries = sql<CommentRow & { readonly count: number }>`
    SELECT c.*, counts.count FROM roost_board_comments c
    JOIN (
      SELECT thread_id, COUNT(*) AS count, MAX(id) AS last_id
      FROM roost_board_comments GROUP BY thread_id
    ) counts ON counts.last_id = c.id
  `.pipe(
    Effect.map((rows) =>
      rows.map(
        (row) =>
          ({
            threadId: row.thread_id,
            count: row.count,
            last: toComment(row),
          }) as BoardCommentsSummary,
      ),
    ),
    Effect.mapError(failed),
  );

  // Done: archived, or placed in an archiving column while still open.
  const subCards = Effect.gen(function* () {
    const done = (yield* columns).filter((column) => column.archives).map((column) => column.id);
    return yield* sql<{ thread_id: string; total: number; done: number }>`
    SELECT
      json_extract(t.payload_json, '$.lineage.parentThreadId') AS thread_id,
      COUNT(*) AS total,
      SUM(CASE WHEN t.archived_at IS NOT NULL OR ${sql.in("c.stage", done)} THEN 1 ELSE 0 END) AS done
    FROM orchestration_v2_projection_threads t
    LEFT JOIN roost_board_cards c ON c.thread_id = t.thread_id
    WHERE t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
    GROUP BY 1
  `;
  }).pipe(
    Effect.map((rows) =>
      rows.map(
        (row) => ({ threadId: row.thread_id, total: row.total, done: row.done }) as BoardSubCards,
      ),
    ),
    // A server without the V2 projection has no sub-threads to count.
    Effect.orElseSucceed((): ReadonlyArray<BoardSubCards> => []),
  );

  return BoardService.of({
    list,
    subCards,
    move,
    card,
    summaries,
    saveSummary,
    columns,
    setColumns,
    approvals,
    requestApproval,
    decideApproval,
    useApproval,
    assign,
    setBranch,
    comments,
    comment,
    commentSummaries,
  });
});

export const layer = Layer.effect(BoardService, make);
