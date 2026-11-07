import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Roost's card wall: a thread's stage is its card's column, stored beside T3's
// state (roost_board_cards) so upstream merges never meet it. The user edits
// the columns; archiving stays T3's, done by dropping on an archiving column.

/** A column's id; a card's stage names one. */
export const BoardStage = TrimmedNonEmptyString.check(Schema.isMaxLength(48));
export type BoardStage = typeof BoardStage.Type;

export const BoardColumn = Schema.Struct({
  id: BoardStage,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  /** What belongs here; the summarizer reads it to place cards. */
  description: Schema.String.check(Schema.isMaxLength(600)),
  /** Dropping a card here archives its thread; archived threads sit in these. */
  archives: Schema.Boolean,
});
export type BoardColumn = typeof BoardColumn.Type;

/** The board a new install starts with. */
export const DEFAULT_BOARD_COLUMNS: ReadonlyArray<BoardColumn> = [
  {
    id: "research",
    title: "Research",
    description:
      "Finding out. Investigating, reading code, exploring options, planning, answering questions. No code changed yet.",
    archives: false,
  },
  {
    id: "fix",
    title: "Fix",
    description:
      "Changing things. Editing code or config, building, running tests, iterating on a change.",
    archives: false,
  },
  {
    id: "review",
    title: "Waiting · In review",
    description:
      "Waiting on someone. The agent stopped for the user's answer, approval or decision, or a PR or review is open and pending.",
    archives: false,
  },
  {
    id: "pushed",
    title: "Committed & pushed",
    description: "Committed and pushed (or merged), not yet released or deployed.",
    archives: false,
  },
  {
    id: "deployed",
    title: "Deployed",
    description:
      "Done. Released, deployed or published; or, for work with nothing to ship, finished with nothing left to do.",
    archives: true,
  },
  {
    id: "archived",
    title: "Archive",
    description: "Dead end. Abandoned, superseded, duplicated, or failed with no way forward.",
    archives: true,
  },
];

/**
 * A usable board: unique ids, at least one open column for new threads and
 * one archiving column for archived ones.
 */
export function boardColumnsProblem(columns: ReadonlyArray<BoardColumn>): string | null {
  if (new Set(columns.map((column) => column.id)).size !== columns.length) {
    return "Two columns share an id.";
  }
  if (!columns.some((column) => !column.archives)) return "Keep at least one open column.";
  if (!columns.some((column) => column.archives)) return "Keep at least one archiving column.";
  return null;
}

export const BoardCard = Schema.Struct({
  threadId: ThreadId,
  stage: BoardStage,
  /** ISO time the card last moved. */
  movedAt: Schema.String,
  /** Who moved it last: the user on the board, the thread's agent, or the summarizer. */
  movedBy: Schema.Literals(["user", "agent", "auto"]),
});
export type BoardCard = typeof BoardCard.Type;

export const BoardListInput = Schema.Struct({});
export type BoardListInput = typeof BoardListInput.Type;

/** A thread's sub-threads, which shells leave out once idle. */
export const BoardSubCards = Schema.Struct({
  threadId: ThreadId,
  total: Schema.Number,
  /** Deployed or archived. */
  done: Schema.Number,
});
export type BoardSubCards = typeof BoardSubCards.Type;

/** What a quick read of the thread's last turns says: where it stands, and its column. */
export const BoardSummary = Schema.Struct({
  threadId: ThreadId,
  /** One or two sentences: what the work is and where it stands. */
  summary: Schema.String,
  /** Who acts next and on what; empty when nothing is pending. */
  next: Schema.String,
  suggestedStage: BoardStage,
  /** Why that column, in a few words. */
  reason: Schema.String,
  confidence: Schema.Number,
  summarizedAt: Schema.String,
});
export type BoardSummary = typeof BoardSummary.Type;

export const BoardListOutput = Schema.Struct({
  /** Every thread that has been placed; a thread with no card is unplaced. */
  cards: Schema.Array(BoardCard),
  columns: Schema.Array(BoardColumn),
  subCards: Schema.Array(BoardSubCards),
  summaries: Schema.Array(BoardSummary),
  /** Threads waiting for or being summarized now. */
  summarizing: Schema.Array(ThreadId),
});
export type BoardListOutput = typeof BoardListOutput.Type;

export const BoardMoveInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1)),
  stage: BoardStage,
});
export type BoardMoveInput = typeof BoardMoveInput.Type;

export const BoardMoveOutput = Schema.Struct({
  cards: Schema.Array(BoardCard),
});
export type BoardMoveOutput = typeof BoardMoveOutput.Type;

export const BoardSummarizeInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type BoardSummarizeInput = typeof BoardSummarizeInput.Type;

export const BoardSummarizeOutput = Schema.Struct({
  queued: Schema.Number,
});
export type BoardSummarizeOutput = typeof BoardSummarizeOutput.Type;

export const BoardSetColumnsInput = Schema.Struct({
  /** The whole board, in order; replaces the columns there were. */
  columns: Schema.Array(BoardColumn).check(Schema.isMinLength(2), Schema.isMaxLength(20)),
});
export type BoardSetColumnsInput = typeof BoardSetColumnsInput.Type;

export const BoardSetColumnsOutput = Schema.Struct({
  columns: Schema.Array(BoardColumn),
});
export type BoardSetColumnsOutput = typeof BoardSetColumnsOutput.Type;

export class BoardApiError extends Schema.TaggedError<BoardApiError>()("BoardApiError", {
  message: Schema.String,
}) {}
