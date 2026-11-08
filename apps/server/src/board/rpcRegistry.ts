// What the board's RPCs need, merged into upstream's exhaustive maps with
// one spread each: the scope a caller must hold (RpcAuthorization.ts) and the
// aggregate its spans are counted under (RpcInstrumentation.ts).
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
} from "@t3tools/contracts";

export const BOARD_RPC_REQUIRED_SCOPES = {
  [WS_METHODS.boardList]: AuthOrchestrationReadScope,
  [WS_METHODS.boardMove]: AuthOrchestrationOperateScope,
  [WS_METHODS.boardSummarize]: AuthOrchestrationOperateScope,
  [WS_METHODS.boardSetColumns]: AuthOrchestrationOperateScope,
  [WS_METHODS.boardDecide]: AuthOrchestrationOperateScope,
  [WS_METHODS.boardNudge]: AuthOrchestrationOperateScope,
  [WS_METHODS.boardComments]: AuthOrchestrationReadScope,
  [WS_METHODS.boardCard]: AuthOrchestrationOperateScope,
  [WS_METHODS.boardBranch]: AuthOrchestrationReadScope,
  [WS_METHODS.boardChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.boardAddCard]: AuthOrchestrationOperateScope,
} as const;

export const BOARD_RPC_AGGREGATES = {
  [WS_METHODS.boardList]: "board",
  [WS_METHODS.boardMove]: "board",
  [WS_METHODS.boardSummarize]: "board",
  [WS_METHODS.boardSetColumns]: "board",
  [WS_METHODS.boardDecide]: "board",
  [WS_METHODS.boardNudge]: "board",
  [WS_METHODS.boardComments]: "board",
  [WS_METHODS.boardCard]: "board",
  [WS_METHODS.boardBranch]: "board",
  [WS_METHODS.boardChecks]: "board",
  [WS_METHODS.boardAddCard]: "board",
} as const;
