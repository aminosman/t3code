// The card wall's client atoms, for this environment's server. Kept out of
// client-runtime's server.ts, so upstream's file stays as it is.
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2OlderSettledCursor,
  type OrchestrationV2ThreadShell,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "~/connection/runtime";

const BOARD_OLDER_SETTLED_PAGE_SIZE = 50;
/** At most 2,000 older settled threads on the board. */
const BOARD_OLDER_SETTLED_PAGES = 40;

const runtime = connectionAtomRuntime;

export const boardEnvironment = {
  /**
   * The card wall's older settled threads, which shells leave out: all of
   * them below `before` (the shell's cut), read in pages while the board is
   * open. Those are the threads a cleanup is for.
   */
  boardOlderSettled: createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:server:board:older-settled",
    idleTtlMs: 0,
    staleTimeMs: 30_000,
    execute: Effect.fn("Board.readOlderSettled")(function* (input: { readonly before: string }) {
      const threads: OrchestrationV2ThreadShell[] = [];
      let cursor: OrchestrationV2OlderSettledCursor = { settledAt: input.before };
      for (let page = 0; page < BOARD_OLDER_SETTLED_PAGES; page += 1) {
        const read = yield* request(ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads, {
          before: cursor,
          limit: BOARD_OLDER_SETTLED_PAGE_SIZE,
        });
        threads.push(...read.threads);
        const last = read.threads.at(-1);
        if (read.threads.length < BOARD_OLDER_SETTLED_PAGE_SIZE || last?.settledAt == null) break;
        cursor = { settledAt: DateTime.formatIso(last.settledAt), threadId: last.id };
      }
      return threads;
    }),
  }),
  /** One card's mini pull request: its branch against the default branch. */
  boardBranch: createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:board:branch",
    tag: WS_METHODS.boardBranch,
    staleTimeMs: 10_000,
  }),
  /** One card's checks, column by column. */
  boardChecks: createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:board:checks",
    tag: WS_METHODS.boardChecks,
    staleTimeMs: 10_000,
  }),
  /** One card's comments, for its card back. */
  boardComments: createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:board:comments",
    tag: WS_METHODS.boardComments,
    staleTimeMs: 5_000,
  }),
  /** Roost's card wall: the stage of every placed thread. */
  boardList: createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:board:list",
    tag: WS_METHODS.boardList,
    staleTimeMs: 10_000,
  }),
  boardMove: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:board:move",
    tag: WS_METHODS.boardMove,
  }),
  boardSetColumns: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:board:set-columns",
    tag: WS_METHODS.boardSetColumns,
  }),
  boardAddCard: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:board:add-card",
    tag: WS_METHODS.boardAddCard,
  }),
  boardCard: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:board:card",
    tag: WS_METHODS.boardCard,
  }),
  boardDecide: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:board:decide",
    tag: WS_METHODS.boardDecide,
  }),
  boardNudge: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:board:nudge",
    tag: WS_METHODS.boardNudge,
  }),
  boardSummarize: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:board:summarize",
    tag: WS_METHODS.boardSummarize,
  }),
};
