// The handler behind t3_card_update. The order matters: what the agent
// reports is recorded first, then the column's checks run, then its approval
// gate, then the move.
import { BOARD_REVIEWS_WANTED, ThreadId, columnNeedsApproval } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadToolError } from "../../mcp/toolkits/threads/tools.ts";
import { BoardFlow } from "../BoardFlow.ts";
import { BoardService } from "../BoardService.ts";
import { BoardToolkit } from "./tools.ts";

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
};

const failWith = (prefix: string) => (cause: unknown) =>
  new ThreadToolError({ reason: `${prefix}: ${describeCause(cause)}` });

const makeHandlers = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const board = yield* BoardService;
  const boardFlow = yield* BoardFlow;

  const requireScope = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("threads")) {
      return yield* new ThreadToolError({
        reason: "this agent session was not granted access to Roost threads",
      });
    }
    return yield* McpInvocationContext.requireThreadScope(scope, "Roost history and thread tools");
  });

  const cardUpdate = Effect.fn("BoardToolkit.t3_card_update")(function* (input: {
    readonly stage?: string | undefined;
    readonly summary?: string | undefined;
    readonly next?: string | undefined;
    readonly reviewedBy?: ReadonlyArray<string> | null | undefined;
    readonly tests?:
      | ReadonlyArray<{
          readonly case: string;
          readonly result: "pass" | "fail" | "skip";
          readonly note?: string | undefined;
        }>
      | undefined;
    readonly regression?:
      | { readonly passed: boolean; readonly command: string; readonly summary: string }
      | undefined;
    readonly assignee?: "agent" | "user" | undefined;
    readonly comment?: string | undefined;
    readonly branch?: string | null | undefined;
    readonly threadId?: ThreadId | undefined;
  }) {
    const scope = yield* requireScope;
    const boardFailed = (error: { readonly reason: string }) =>
      new ThreadToolError({ reason: error.reason });
    const columns = yield* board.columns.pipe(Effect.mapError(boardFailed));

    let column: (typeof columns)[number] | undefined;
    if (input.stage !== undefined) {
      const wanted = input.stage.trim().toLowerCase();
      column = columns.find(
        (entry) => entry.id.toLowerCase() === wanted || entry.title.toLowerCase() === wanted,
      );
      if (column === undefined) {
        return yield* new ThreadToolError({
          reason: `no column "${input.stage}". The board's columns: ${columns
            .map((entry) => `${entry.id} ("${entry.title}"): ${entry.description}`)
            .join("; ")}`,
        });
      }
    }
    const threadId = input.threadId ?? scope.thread.threadId;
    const target = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(failWith("could not read the thread")));
    if (target === null || target.deletedAt !== null) {
      return yield* new ThreadToolError({ reason: `no thread ${threadId}` });
    }
    const columnList = columns.map((entry) => ({
      id: entry.id,
      title: entry.title,
      description: entry.description,
      archives: entry.archives,
      requiresApproval: columnNeedsApproval(entry, target.projectId),
      checks: (entry.checks ?? []).map((check) =>
        check.kind === "merged" ? `merged into ${check.into ?? "main"}` : check.kind,
      ),
    }));
    const currentCard = yield* board.card(threadId).pipe(Effect.mapError(boardFailed));
    const currentStage =
      columns.find((entry) => entry.id === currentCard?.stage)?.id ??
      columns.find((entry) => !entry.archives)?.id ??
      "";
    const now = DateTime.formatIso(yield* DateTime.now);
    const previous = (yield* board.summaries.pipe(Effect.mapError(boardFailed))).find(
      (entry) => entry.threadId === threadId,
    );

    // What the agent reports is recorded first, so this call's checks can see it.
    if (input.branch !== undefined) {
      const named = input.branch?.trim() ?? "";
      yield* board
        .setBranch(threadId, named.length > 0 ? named : null)
        .pipe(Effect.mapError(boardFailed));
    }
    const reports =
      input.summary !== undefined ||
      input.next !== undefined ||
      input.reviewedBy !== undefined ||
      input.tests !== undefined ||
      input.regression !== undefined;
    const report = (stage: string) => ({
      threadId,
      summary: input.summary?.trim() ?? previous?.summary ?? "",
      next: input.next?.trim() ?? previous?.next ?? "",
      suggestedStage: stage,
      reason: "Set by the thread's agent",
      confidence: 1,
      summarizedAt: now,
      source: "agent" as const,
      reviewedBy:
        input.reviewedBy === undefined
          ? (previous?.reviewedBy ?? null)
          : input.reviewedBy === null
            ? null
            : input.reviewedBy.map((name) => name.trim()).filter((name) => name.length > 0),
      tests:
        input.tests === undefined
          ? (previous?.tests ?? null)
          : input.tests.map((entry) => ({
              case: entry.case.trim(),
              result: entry.result,
              ...(entry.note === undefined ? {} : { note: entry.note.trim() }),
            })),
      regression:
        input.regression === undefined
          ? (previous?.regression ?? null)
          : { ...input.regression, at: now },
    });
    if (reports) {
      yield* board.saveSummary(report(currentStage)).pipe(Effect.mapError(boardFailed));
    }

    // A column's checks are facts Roost confirms; the card waits until they hold.
    let checks: ReadonlyArray<{ kind: string; ok: boolean; detail: string }> = [];
    let instruction = "";
    if (column !== undefined && column.id !== currentStage && (column.checks ?? []).length > 0) {
      checks = yield* boardFlow.checkColumn(threadId, column).pipe(Effect.mapError(boardFailed));
      const failing = checks.filter((entry) => !entry.ok);
      if (failing.length > 0) {
        instruction = `Not moved: "${column.title}" needs ${failing
          .map((entry) => entry.detail)
          .join("; ")}. Do that, record it (reviewedBy, tests, regression, branch), and ask again.`;
        column = undefined;
      }
    }

    // A column that needs approval is entered only with one granted; asking files a request.
    let approval: { stage: string; status: string; instruction: string } | null = null;
    if (
      column !== undefined &&
      column.id !== currentStage &&
      columnNeedsApproval(column, target.projectId)
    ) {
      const filed = yield* board
        .requestApproval({
          threadId,
          stage: column.id,
          note: (input.next ?? input.summary ?? "").trim(),
        })
        .pipe(Effect.mapError(boardFailed));
      if (filed.status === "approved") {
        yield* board.useApproval(threadId, column.id).pipe(Effect.mapError(boardFailed));
        approval = { stage: column.id, status: "used", instruction: "Approved; the card moved." };
      } else {
        approval = {
          stage: column.id,
          status: "pending",
          instruction: `"${column.title}" needs the user's approval. A request is on the card and the card has not moved. Stop here, tell the user what you want to do there, and wait: a message arrives when they decide.`,
        };
        column = undefined;
      }
    }
    if (column !== undefined) {
      yield* board
        .move({ threadIds: [threadId], stage: column.id, movedBy: "agent" })
        .pipe(Effect.mapError(boardFailed));
    }
    const stage = column?.id ?? currentStage;
    // A move alone still counts as the agent's report, so the summarizer leaves the turn be.
    if (reports || column !== undefined) {
      yield* board.saveSummary(report(stage)).pipe(Effect.mapError(boardFailed));
    }
    if (input.comment !== undefined && input.comment.trim().length > 0) {
      yield* board
        .comment(threadId, "agent", input.comment.trim())
        .pipe(Effect.mapError(boardFailed));
    }
    if (input.assignee !== undefined) {
      yield* board.assign(threadId, input.assignee).pipe(Effect.mapError(boardFailed));
    }
    const assignee =
      input.assignee ??
      (yield* board.card(threadId).pipe(Effect.mapError(boardFailed)))?.assignee ??
      "agent";
    const recent = (yield* board.comments(threadId).pipe(Effect.mapError(boardFailed)))
      .slice(-10)
      .map((entry) => ({ author: entry.author, body: entry.body, createdAt: entry.createdAt }));
    const shown = reports || column !== undefined ? report(stage) : previous;
    return {
      threadId,
      stage,
      summary: shown?.summary ?? "",
      next: shown?.next ?? "",
      reviewedBy: shown?.reviewedBy ?? null,
      reviewsWanted: BOARD_REVIEWS_WANTED,
      columns: columnList,
      checks: checks.map((entry) => ({ kind: entry.kind, ok: entry.ok, detail: entry.detail })),
      instruction,
      approval,
      assignee,
      comments: recent,
    };
  });

  return {
    t3_card_update: McpToolAccess.writesThreads(
      (input: { readonly threadId?: ThreadId | undefined }) => [input.threadId],
      cardUpdate,
    ),
  } satisfies McpToolAccess.Handlers<typeof BoardToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(BoardToolkit, makeHandlers);
