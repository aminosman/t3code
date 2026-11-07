import { Schema } from "effect";

import { ThreadId } from "./baseSchemas.ts";

// Roost's card wall: a thread's stage is its card's column, stored beside T3's
// state (roost_board_cards) so upstream merges never meet it. Archiving stays
// T3's: an archived card shows in Deployed when it shipped, else in Archive.

/** The columns, in board order. */
export const BOARD_STAGES = [
  "research",
  "fix",
  "review",
  "pushed",
  "deployed",
  "archived",
] as const;

export const BoardStage = Schema.Literals(BOARD_STAGES);
export type BoardStage = typeof BoardStage.Type;

export const BoardCard = Schema.Struct({
  threadId: ThreadId,
  stage: BoardStage,
  /** ISO time the card last moved. */
  movedAt: Schema.String,
  /** Who moved it last: the user on the board, or an agent from its thread. */
  movedBy: Schema.Literals(["user", "agent"]),
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

export const BoardListOutput = Schema.Struct({
  /** Every thread that has been placed; a thread with no card is unplaced. */
  cards: Schema.Array(BoardCard),
  subCards: Schema.Array(BoardSubCards),
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

export class BoardApiError extends Schema.TaggedError<BoardApiError>()("BoardApiError", {
  message: Schema.String,
}) {}
