// What the user does to a card that the thread's agent has to hear about: an
// approval decided on the board, or a nudge to move the card forward. Each is
// a message into the thread, so the agent picks the work back up.
import type {
  BoardApproval,
  BoardAssignee,
  BoardBranchView,
  BoardColumn,
  BoardComment,
} from "@t3tools/contracts";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { compareBranch } from "./BoardBranch.ts";
import { BoardError, BoardService } from "./BoardService.ts";
import { agentReportedTurn } from "./BoardSummarizer.ts";
import { setBoardStopCheck } from "./stopGuard.ts";

export interface BoardFlowShape {
  readonly decide: (input: {
    readonly threadId: string;
    readonly stage: string;
    readonly approve: boolean;
    readonly note: string;
  }) => Effect.Effect<BoardApproval, BoardError>;
  /** Asks each thread to check its card and move it forward; returns how many were told. */
  readonly nudge: (threadIds: ReadonlyArray<string>) => Effect.Effect<number, BoardError>;
  /** The user comments and/or reassigns; handing the card to the agent sends it the comments. */
  /** The card's mini pull request: its branch against the default branch. */
  readonly branch: (threadId: string) => Effect.Effect<BoardBranchView, BoardError>;
  readonly card: (input: {
    readonly threadId: string;
    readonly comment?: string | undefined;
    readonly assignee?: BoardAssignee | undefined;
  }) => Effect.Effect<
    { assignee: BoardAssignee; comments: ReadonlyArray<BoardComment>; told: boolean },
    BoardError
  >;
}

export class BoardFlow extends Context.Service<BoardFlow, BoardFlowShape>()("t3/board/BoardFlow") {}

const describe = (column: BoardColumn) =>
  `"${column.title}"${column.description.trim() ? ` (${column.description.trim()})` : ""}`;

function decisionMessage(column: BoardColumn, approve: boolean, note: string): string {
  return approve
    ? `[Card wall] Approved: you may move this work into ${describe(column)}. Do that column's work now, then move the card there with t3_card_update.`
    : `[Card wall] Declined: do not move this work into ${describe(column)}.${note.trim() ? ` The user's reason: ${note.trim()}` : ""} Update the card with t3_card_update to say what happens instead.`;
}

/** The user's comments since the agent last wrote, as the message that hands the card back. */
export function handBackMessage(comments: ReadonlyArray<BoardComment>): string {
  const lastAgent = comments.findLastIndex((entry) => entry.author === "agent");
  const fresh = comments.slice(lastAgent + 1).filter((entry) => entry.author === "user");
  const said = fresh.map((entry) => `- ${entry.body.trim()}`).join("\n");
  return `[Card wall] The user handed this card back to you.${said ? ` Their comments on it:\n${said}\n` : " "}Carry on with the work and keep the card current with t3_card_update.`;
}

const STOP_REASON =
  "Before you end this turn, update your card with one t3_card_update call: the column, a summary, next, and reviewedBy if code changed. If you are waiting on the user, assign the card to them with a comment saying what you need. Then end the turn.";

const NUDGE_MESSAGE =
  "[Card wall] Check your card with t3_card_update and move the work forward: if the current column's work is done and the next column's requirement is met, do it and move the card. If the next column needs approval, ask for it and stop. If something blocks you, say what in the card's next.";

const make = Effect.gen(function* () {
  const board = yield* BoardService;
  const threads = yield* ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = (cause: unknown) =>
    new BoardError({ reason: cause instanceof Error ? cause.message : String(cause) });

  const send = Effect.fn("BoardFlow.send")(function* (threadId: string, text: string) {
    const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return false;
    yield* threads.sendToThread({
      projectId: shell.projectId,
      commandId: CommandId.make(yield* crypto.randomUUIDv4()),
      threadId: shell.id,
      messageId: MessageId.make(yield* crypto.randomUUIDv4()),
      text,
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
    return true;
  });

  const decide: BoardFlowShape["decide"] = Effect.fn("BoardFlow.decide")(function* ({
    threadId,
    stage,
    approve,
    note,
  }) {
    const column = (yield* board.columns).find((entry) => entry.id === stage);
    if (column === undefined) return yield* new BoardError({ reason: `no column "${stage}"` });
    const approval = yield* board.decideApproval({ threadId, stage, approve, note });
    yield* send(threadId, decisionMessage(column, approve, note));
    return approval;
  }, Effect.mapError(failed));

  const nudge: BoardFlowShape["nudge"] = Effect.fn("BoardFlow.nudge")(function* (threadIds) {
    const told = yield* Effect.forEach([...new Set(threadIds)], (id) => send(id, NUDGE_MESSAGE));
    return told.filter(Boolean).length;
  }, Effect.mapError(failed));

  const card: BoardFlowShape["card"] = Effect.fn("BoardFlow.card")(function* ({
    threadId,
    comment,
    assignee,
  }) {
    if (comment !== undefined && comment.trim().length > 0) {
      yield* board.comment(threadId, "user", comment.trim());
    }
    if (assignee !== undefined) yield* board.assign(threadId, assignee);
    const comments = yield* board.comments(threadId);
    const told = assignee === "agent" ? yield* send(threadId, handBackMessage(comments)) : false;
    const placed = yield* board.card(threadId);
    return { assignee: placed?.assignee ?? "agent", comments, told };
  }, Effect.mapError(failed));

  const branch: BoardFlowShape["branch"] = Effect.fn("BoardFlow.branch")(function* (threadId) {
    const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
    if (shell === null) return yield* new BoardError({ reason: `no thread ${threadId}` });
    const project = yield* projects.getById(ProjectId.make(shell.projectId));
    const cwd = shell.worktreePath ?? Option.getOrNull(project)?.workspaceRoot ?? null;
    const placed = yield* board.card(threadId);
    const named = placed?.branch ?? shell.branch ?? null;
    if (cwd === null) {
      return {
        branch: named,
        base: null,
        ahead: 0,
        behind: 0,
        insertions: 0,
        deletions: 0,
        files: [],
        commits: [],
        uncommitted: null,
      };
    }
    return yield* compareBranch({ cwd, branch: named }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  }, Effect.mapError(failed));

  // A turn ending with the card unreported is sent back once to update it.
  const stopCheck = Effect.fn("BoardFlow.stopCheck")(function* (threadId: string) {
    const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return null;
    const turnStartedAt =
      shell.latestRunRequestedAt == null ? null : DateTime.formatIso(shell.latestRunRequestedAt);
    const previous = (yield* board.summaries).find((entry) => entry.threadId === threadId);
    return agentReportedTurn(previous, turnStartedAt) ? null : STOP_REASON;
  });
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  setBoardStopCheck((threadId) =>
    runPromise(stopCheck(threadId).pipe(Effect.orElseSucceed(() => null))),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => setBoardStopCheck(null)));

  return BoardFlow.of({ decide, nudge, card, branch });
});

export const layer = Layer.effect(BoardFlow, make);
