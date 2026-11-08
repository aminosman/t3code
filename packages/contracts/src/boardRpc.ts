// Roost's card wall RPCs, kept apart from upstream's rpc.ts: WS_METHODS and
// WsRpcGroup each spread these in with one line.
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  BoardApiError,
  BoardListInput,
  BoardListOutput,
  BoardMoveInput,
  BoardMoveOutput,
  BoardSummarizeInput,
  BoardSummarizeOutput,
  BoardSetColumnsInput,
  BoardSetColumnsOutput,
  BoardDecideInput,
  BoardDecideOutput,
  BoardNudgeInput,
  BoardNudgeOutput,
  BoardCommentsInput,
  BoardCommentsOutput,
  BoardCardInput,
  BoardCardOutput,
  BoardBranchInput,
  BoardBranchView,
  BoardChecksInput,
  BoardChecksOutput,
  BoardAddCardInput,
  BoardAddCardOutput,
} from "./board.ts";

export const BOARD_WS_METHODS = {
  boardList: "board.list",
  boardMove: "board.move",
  boardSummarize: "board.summarize",
  boardSetColumns: "board.setColumns",
  boardDecide: "board.decide",
  boardNudge: "board.nudge",
  boardComments: "board.comments",
  boardCard: "board.card",
  boardBranch: "board.branch",
  boardChecks: "board.checks",
  boardAddCard: "board.addCard",
} as const;

const WsBoardListRpc = Rpc.make(BOARD_WS_METHODS.boardList, {
  payload: BoardListInput,
  success: BoardListOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardMoveRpc = Rpc.make(BOARD_WS_METHODS.boardMove, {
  payload: BoardMoveInput,
  success: BoardMoveOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardSummarizeRpc = Rpc.make(BOARD_WS_METHODS.boardSummarize, {
  payload: BoardSummarizeInput,
  success: BoardSummarizeOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardSetColumnsRpc = Rpc.make(BOARD_WS_METHODS.boardSetColumns, {
  payload: BoardSetColumnsInput,
  success: BoardSetColumnsOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardDecideRpc = Rpc.make(BOARD_WS_METHODS.boardDecide, {
  payload: BoardDecideInput,
  success: BoardDecideOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardNudgeRpc = Rpc.make(BOARD_WS_METHODS.boardNudge, {
  payload: BoardNudgeInput,
  success: BoardNudgeOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardCommentsRpc = Rpc.make(BOARD_WS_METHODS.boardComments, {
  payload: BoardCommentsInput,
  success: BoardCommentsOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardCardRpc = Rpc.make(BOARD_WS_METHODS.boardCard, {
  payload: BoardCardInput,
  success: BoardCardOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardBranchRpc = Rpc.make(BOARD_WS_METHODS.boardBranch, {
  payload: BoardBranchInput,
  success: BoardBranchView,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardChecksRpc = Rpc.make(BOARD_WS_METHODS.boardChecks, {
  payload: BoardChecksInput,
  success: BoardChecksOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

const WsBoardAddCardRpc = Rpc.make(BOARD_WS_METHODS.boardAddCard, {
  payload: BoardAddCardInput,
  success: BoardAddCardOutput,
  error: Schema.Union([BoardApiError, EnvironmentAuthorizationError]),
});

export const BOARD_RPCS = [
  WsBoardListRpc,
  WsBoardMoveRpc,
  WsBoardSummarizeRpc,
  WsBoardSetColumnsRpc,
  WsBoardDecideRpc,
  WsBoardNudgeRpc,
  WsBoardCommentsRpc,
  WsBoardCardRpc,
  WsBoardBranchRpc,
  WsBoardChecksRpc,
  WsBoardAddCardRpc,
] as const;

/** The board RPCs alone, so the server can type its handlers apart from upstream's. */
export const BoardRpcGroup = RpcGroup.make(...BOARD_RPCS);
