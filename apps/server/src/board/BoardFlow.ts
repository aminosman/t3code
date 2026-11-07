// What the user does to a card that the thread's agent has to hear about: an
// approval decided on the board, or a nudge to move the card forward. Each is
// a message into the thread, so the agent picks the work back up.
import type {
  BoardApproval,
  BoardAssignee,
  BoardBranchView,
  BoardCheckResult,
  BoardColumn,
  ModelSelection,
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
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { compareBranch, gitIn } from "./BoardBranch.ts";
import { checkGit, checkRecorded } from "./BoardChecks.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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
  /** Each column's checks for this card, in board order, for columns that have any. */
  readonly checks: (
    threadId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ stage: string; results: ReadonlyArray<BoardCheckResult> }>,
    BoardError
  >;
  /** One column's checks for this card. */
  readonly checkColumn: (
    threadId: string,
    column: BoardColumn,
  ) => Effect.Effect<ReadonlyArray<BoardCheckResult>, BoardError>;
  /** A new thread from a card added on the board, placed in its column. */
  readonly addCard: (input: {
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly stage: string;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<string, BoardError>;
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
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
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

  /** Where the card's work is in git: the folder, its branch, and what is checked out there. */
  const facts = Effect.fn("BoardFlow.facts")(function* (threadId: string) {
    const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
    if (shell === null) return null;
    const project = yield* projects.getById(ProjectId.make(shell.projectId));
    const cwd = shell.worktreePath ?? Option.getOrNull(project)?.workspaceRoot ?? null;
    if (cwd === null) return null;
    const git = gitIn(spawner, cwd);
    const head = yield* git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const current = head === null || head === "HEAD" ? null : head;
    const placed = yield* board.card(threadId);
    return { git, current, branch: placed?.branch ?? shell.branch ?? current };
  });

  const checkColumn: BoardFlowShape["checkColumn"] = Effect.fn("BoardFlow.checkColumn")(function* (
    threadId,
    column,
  ) {
    const checks = column.checks ?? [];
    if (checks.length === 0) return [];
    const summary = (yield* board.summaries).find((entry) => entry.threadId === threadId);
    const where = checks.some((check) => checkRecorded(check, summary) === null)
      ? yield* facts(threadId)
      : null;
    return yield* Effect.forEach(checks, (check) => {
      const recorded = checkRecorded(check, summary);
      if (recorded !== null) return Effect.succeed(recorded);
      if (where === null) {
        return Effect.succeed({
          kind: check.kind,
          ...(check.into ? { into: check.into } : {}),
          ok: false,
          detail: "no git folder for this thread",
        });
      }
      return checkGit(check, where.branch, where.current, where.git);
    });
  }, Effect.mapError(failed));

  const checks: BoardFlowShape["checks"] = Effect.fn("BoardFlow.checks")(function* (threadId) {
    const columns = (yield* board.columns).filter((column) => (column.checks ?? []).length > 0);
    return yield* Effect.forEach(columns, (column) =>
      checkColumn(threadId, column).pipe(Effect.map((results) => ({ stage: column.id, results }))),
    );
  }, Effect.mapError(failed));

  const addCard: BoardFlowShape["addCard"] = Effect.fn("BoardFlow.addCard")(function* (input) {
    const column = (yield* board.columns).find((entry) => entry.id === input.stage);
    if (column === undefined)
      return yield* new BoardError({ reason: `no column "${input.stage}"` });
    const project = Option.getOrNull(yield* projects.getById(ProjectId.make(input.projectId)));
    if (project === null) return yield* new BoardError({ reason: "no such project" });
    const settings = yield* serverSettings.getSettings;
    const runtimeMode = resolveProjectSettings(settings, project.id, project).settings
      .defaultRuntimeMode;
    const threadId = ThreadId.make(yield* crypto.randomUUIDv4());
    const description = input.description.trim();
    yield* launches.launch({
      commandId: CommandId.make(yield* crypto.randomUUIDv4()),
      threadId,
      projectId: project.id,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode,
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4()),
        text: `${input.title}${description ? `\n\n${description}` : ""}\n\n[Card wall] This card starts in ${describe(column)}. Take it from there toward done.`,
        attachments: [],
      },
      createdBy: "user",
      creationSource: "web",
    });
    yield* board.move({ threadIds: [threadId], stage: column.id, movedBy: "user" });
    return threadId;
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

  return BoardFlow.of({ decide, nudge, card, branch, checks, checkColumn, addCard });
});

export const layer = Layer.effect(BoardFlow, make);
