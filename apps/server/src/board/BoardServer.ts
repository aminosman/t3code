// The card wall's server side, attached to upstream's server with one line in
// each place: `layer` in server.ts, `rpcHandlers` and `captureLayer` in ws.ts.
import { BoardApiError, BoardRpcGroup, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BoardFlow from "./BoardFlow.ts";
import * as BoardService from "./BoardService.ts";
import * as BoardSummarizer from "./BoardSummarizer.ts";

/** One store for the board RPCs and the agents' t3_card_update, for the server's lifetime. */
export const layer = Layer.mergeAll(BoardSummarizer.layer, BoardFlow.layer).pipe(
  Layer.provideMerge(BoardService.layer),
);

/** Board services that are never called, for tests of upstream's RPC layer. */
export const layerUnused = Layer.mergeAll(
  Layer.mock(BoardService.BoardService)({}),
  Layer.mock(BoardSummarizer.BoardSummarizer)({}),
  Layer.mock(BoardFlow.BoardFlow)({}),
);

/** The server-lifetime board services, handed on to each socket's RPC layer. */
export const captureLayer = Effect.gen(function* () {
  // Only these three: the ambient context also holds services each socket provides itself.
  const board = yield* BoardService.BoardService;
  const summarizer = yield* BoardSummarizer.BoardSummarizer;
  const flow = yield* BoardFlow.BoardFlow;
  return Layer.mergeAll(
    Layer.succeed(BoardService.BoardService, board),
    Layer.succeed(BoardSummarizer.BoardSummarizer, summarizer),
    Layer.succeed(BoardFlow.BoardFlow, flow),
  );
});

/** The board's WebSocket RPC handlers, spread into upstream's handler record. */
export const rpcHandlers = Effect.gen(function* () {
  const board = yield* BoardService.BoardService;
  const summarizer = yield* BoardSummarizer.BoardSummarizer;
  const boardFlow = yield* BoardFlow.BoardFlow;
  const boardFailed = (error: BoardService.BoardError) =>
    new BoardApiError({ message: error.reason });
  return BoardRpcGroup.of({
    [WS_METHODS.boardList]: (_input) =>
      Effect.all({
        cards: board.list,
        columns: board.columns,
        subCards: board.subCards,
        summaries: board.summaries,
        approvals: board.approvals,
        comments: board.commentSummaries,
        summarizing: summarizer.pending.pipe(
          Effect.map((ids) => ids.map((id) => ThreadId.make(id))),
        ),
      }).pipe(Effect.mapError(boardFailed)),
    [WS_METHODS.boardMove]: (input) =>
      board.move({ threadIds: input.threadIds, stage: input.stage, movedBy: "user" }).pipe(
        Effect.map((cards) => ({ cards })),
        Effect.mapError(boardFailed),
      ),
    [WS_METHODS.boardSetColumns]: (input) =>
      board.setColumns(input.columns).pipe(
        Effect.map((columns) => ({ columns })),
        Effect.mapError(boardFailed),
      ),
    [WS_METHODS.boardDecide]: (input) =>
      boardFlow
        .decide({
          threadId: input.threadId,
          stage: input.stage,
          approve: input.approve,
          note: input.note ?? "",
        })
        .pipe(
          Effect.map((approval) => ({ approval })),
          Effect.mapError(boardFailed),
        ),
    [WS_METHODS.boardComments]: (input) =>
      board.comments(input.threadId).pipe(
        Effect.map((comments) => ({ comments })),
        Effect.mapError(boardFailed),
      ),
    [WS_METHODS.boardCard]: (input) =>
      boardFlow
        .card({ threadId: input.threadId, comment: input.comment, assignee: input.assignee })
        .pipe(Effect.mapError(boardFailed)),
    [WS_METHODS.boardBranch]: (input) =>
      boardFlow.branch(input.threadId).pipe(Effect.mapError(boardFailed)),
    [WS_METHODS.boardChecks]: (input) =>
      boardFlow.checks(input.threadId).pipe(
        Effect.map((columns) => ({ columns })),
        Effect.mapError(boardFailed),
      ),
    [WS_METHODS.boardAddCard]: (input) =>
      boardFlow.addCard(input).pipe(
        Effect.map((threadId) => ({ threadId: ThreadId.make(threadId) })),
        Effect.mapError(boardFailed),
      ),
    [WS_METHODS.boardNudge]: (input) =>
      boardFlow.nudge(input.threadIds).pipe(
        Effect.map((sent) => ({ sent })),
        Effect.mapError(boardFailed),
      ),
    [WS_METHODS.boardSummarize]: (input) =>
      summarizer.enqueue(input.threadIds).pipe(Effect.map((queued) => ({ queued }))),
  });
});
