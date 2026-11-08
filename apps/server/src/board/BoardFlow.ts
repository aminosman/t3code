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
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { compareBranch, gitIn } from "./BoardBranch.ts";
import { checkGit, checkRecorded } from "./BoardChecks.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { BoardError, BoardService } from "./BoardService.ts";

/** A short, stable fingerprint of text (FNV-1a), to tell one working tree from another. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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
  /** What a reviewer reads: the card's folder, branch, commit, and the base it goes into. */
  readonly reviewTarget: (threadId: string) => Effect.Effect<
    {
      readonly cwd: string;
      readonly branch: string;
      readonly head: string;
      /** The commit plus a fingerprint of uncommitted changes: what one round of review saw. */
      readonly state: string;
      readonly base: string | null;
    } | null,
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
    return { cwd, git, current, branch: placed?.branch ?? shell.branch ?? current };
  });

  const reviewTarget: BoardFlowShape["reviewTarget"] = Effect.fn("BoardFlow.reviewTarget")(
    function* (threadId) {
      const where = yield* facts(threadId);
      if (where === null || where.branch === null) return null;
      const head = (yield* where.git(["rev-parse", "--verify", "--quiet", where.branch]))?.trim();
      if (!head) return null;
      const compared = yield* branch(threadId).pipe(Effect.orElseSucceed(() => null));
      // Reviews come before the commit, so edits made after one count as new work.
      // New files count by their contents, so a fix in one is new work too. NUL-separated,
      // so odd names survive; a nested repo ("dir/") or an unreadable file hashes as its name.
      const checkedOut = where.branch === where.current;
      const untracked = checkedOut
        ? ((yield* where.git(["ls-files", "-z", "--others", "--exclude-standard"])) ?? "")
            .split("\0")
            .filter((path) => path.length > 0 && !path.endsWith("/"))
        : [];
      // Past the first 200, a file counts by its name only.
      const untrackedHashes = yield* Effect.forEach(untracked.slice(0, 200), (path) =>
        where.git(["hash-object", "--", path]).pipe(Effect.map((hash) => `${path} ${hash ?? "?"}`)),
      );
      // --binary, so an edit to a tracked binary file changes the state too.
      const diff = checkedOut
        ? yield* where.git(["diff", "--no-ext-diff", "--binary", "HEAD"])
        : "";
      // A state that cannot be read is not "the same as before": no automatic round on it.
      if (diff === null) return null;
      const uncommitted =
        `${diff}\n${untrackedHashes.join("\n")}\n${untracked.slice(200).join("\n")}`.trim();
      // Nothing on the branch and nothing uncommitted: there is nothing to review.
      if ((compared?.ahead ?? 1) === 0 && uncommitted.length === 0) return null;
      return {
        cwd: where.cwd,
        branch: where.branch,
        head,
        state: uncommitted.length === 0 ? head : `${head}+${fingerprint(uncommitted)}`,
        base: compared?.base ?? null,
      };
    },
    Effect.mapError(failed),
  );

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

  return BoardFlow.of({ decide, nudge, card, branch, checks, checkColumn, reviewTarget, addCard });
});

export const layer = Layer.effect(BoardFlow, make);
