import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

// Roost's card wall: a thread's stage is its card's column, stored beside T3's
// state (roost_board_cards) so upstream merges never meet it. The user edits
// the columns; archiving stays T3's, done by dropping on an archiving column.

/** A column's id; a card's stage names one. */
export const BoardStage = TrimmedNonEmptyString.check(Schema.isMaxLength(48));
export type BoardStage = typeof BoardStage.Type;

/**
 * A fact Roost checks itself before an agent may move a card into a column:
 * two reviews recorded; on a feature branch; committed and pushed with
 * nothing uncommitted; merged into a branch (\`into\`); the test matrix all
 * passing; the regression run passing.
 */
export const BoardCheckKind = Schema.Literals([
  "reviews",
  "feature-branch",
  "pushed",
  "merged",
  "tests",
  "regression",
]);
export type BoardCheckKind = typeof BoardCheckKind.Type;

export const BoardCheck = Schema.Struct({
  kind: BoardCheckKind,
  /** For "merged": the branch it must be merged into, such as staging or main. */
  into: Schema.optional(Schema.String),
});
export type BoardCheck = typeof BoardCheck.Type;

export const BoardCheckResult = Schema.Struct({
  kind: BoardCheckKind,
  into: Schema.optional(Schema.String),
  ok: Schema.Boolean,
  /** What was found, in a few words. */
  detail: Schema.String,
});
export type BoardCheckResult = typeof BoardCheckResult.Type;

/** One case of a card's end-to-end test matrix, as the agent ran it. */
export const BoardTestCase = Schema.Struct({
  case: Schema.String,
  result: Schema.Literals(["pass", "fail", "skip"]),
  note: Schema.optional(Schema.String),
});
export type BoardTestCase = typeof BoardTestCase.Type;

/** The agent's last regression run: the existing suites, to show nothing else broke. */
export const BoardRegression = Schema.Struct({
  passed: Schema.Boolean,
  command: Schema.String,
  summary: Schema.String,
  at: Schema.String,
});
export type BoardRegression = typeof BoardRegression.Type;

export const BoardColumn = Schema.Struct({
  id: BoardStage,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  /** What belongs here; the summarizer reads it to place cards. */
  description: Schema.String.check(Schema.isMaxLength(600)),
  /** Dropping a card here archives its thread; archived threads sit in these. */
  archives: Schema.Boolean,
  /**
   * Projects whose agents need the user's approval to move a card in ("*" for
   * every project); the user's own moves are never gated.
   */
  requireApprovalIn: Schema.optional(Schema.Array(Schema.String)),
  /** Facts Roost checks before an agent may move a card in; the user's moves are not held. */
  checks: Schema.optional(Schema.Array(BoardCheck)),
});
export type BoardColumn = typeof BoardColumn.Type;

/** Whether an agent needs the user's approval to move this project's card into the column. */
export function columnNeedsApproval(column: BoardColumn, projectId: string): boolean {
  const projects = column.requireApprovalIn ?? [];
  return projects.includes("*") || projects.includes(projectId);
}

/** An agent's request to move its card into a column that needs approval. */
export const BoardApproval = Schema.Struct({
  threadId: ThreadId,
  stage: BoardStage,
  status: Schema.Literals(["pending", "approved", "declined"]),
  requestedAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  /** What the agent wants to do there, or the user's reason for declining. */
  note: Schema.String,
});
export type BoardApproval = typeof BoardApproval.Type;

/** The board a new install starts with: a development workflow, research to production. */
export const DEFAULT_BOARD_COLUMNS: ReadonlyArray<BoardColumn> = [
  {
    id: "research",
    title: "Research",
    description:
      "Understanding the problem: reading code, investigating, planning, answering questions. No code changed yet.",
    archives: false,
  },
  {
    id: "fix",
    title: "Building",
    description:
      "Implementing the change on a feature branch: editing code, building, running tests while iterating. Not committed yet.",
    archives: false,
  },
  {
    id: "review",
    title: "Reviewed",
    description:
      "Two independent agents (other models, read-only) reviewed the change and approved it, with what they found fixed. Required before committing.",
    archives: false,
    checks: [{ kind: "reviews" }],
  },
  {
    id: "pushed",
    title: "Committed to branch",
    description:
      "Committed and pushed to a feature branch, named on the card, with nothing left uncommitted.",
    archives: false,
    checks: [{ kind: "reviews" }, { kind: "feature-branch" }, { kind: "pushed" }],
  },
  {
    id: "tested",
    title: "Tested end to end",
    description:
      "A test matrix of every case and permutation that matters for this change, each run end to end and passing, recorded on the card.",
    archives: false,
    checks: [{ kind: "tests" }],
  },
  {
    id: "regression",
    title: "Regression tested",
    description:
      "The project's existing suites run and pass, so nothing else broke; the run recorded on the card.",
    archives: false,
    checks: [{ kind: "regression" }],
  },
  {
    id: "staging",
    title: "Merged to staging",
    description:
      "The branch merged into staging and deployed there. Skip for projects without a staging branch.",
    archives: false,
    checks: [{ kind: "merged", into: "staging" }],
  },
  {
    id: "staging-verified",
    title: "Verified on staging",
    description:
      "The change checked working on staging, as a user would use it. Skip for projects without staging.",
    archives: false,
  },
  {
    id: "production",
    title: "Merged to production",
    description: "Merged into the production branch (main) and released.",
    archives: false,
    requireApprovalIn: ["*"],
    checks: [{ kind: "merged", into: "main" }],
  },
  {
    id: "deployed",
    title: "Verified in production",
    description:
      "Done: the change checked working in production. Work with nothing to ship (questions, research, personal tasks) lands here once finished.",
    archives: true,
  },
  {
    id: "archived",
    title: "Archive",
    description: "Dead end: abandoned, superseded, duplicated, or failed with no way forward.",
    archives: true,
  },
];

/** Reviews the board asks for before code ships; fewer shows as missing. */
export const BOARD_REVIEWS_WANTED = 2;

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
  /** Whose move it is: the thread's agent, or the user it handed the card to. */
  assignee: Schema.optional(Schema.Literals(["agent", "user"])),
  /** The branch the work lives on, as the agent named it; else the thread's own. */
  branch: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BoardCard = typeof BoardCard.Type;

export const BoardAssignee = Schema.Literals(["agent", "user"]);
export type BoardAssignee = typeof BoardAssignee.Type;

/** A comment on a card, by the user or the thread's agent. */
export const BoardComment = Schema.Struct({
  id: Schema.Number,
  threadId: ThreadId,
  author: BoardAssignee,
  body: Schema.String,
  createdAt: Schema.String,
});
export type BoardComment = typeof BoardComment.Type;

/** How many comments a card has, and its latest, for the card's face. */
export const BoardCommentsSummary = Schema.Struct({
  threadId: ThreadId,
  count: Schema.Number,
  last: BoardComment,
});
export type BoardCommentsSummary = typeof BoardCommentsSummary.Type;

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
  /** The end-to-end test matrix as last reported; null before any. */
  tests: Schema.optional(Schema.NullOr(Schema.Array(BoardTestCase))),
  regression: Schema.optional(Schema.NullOr(BoardRegression)),
  /** Who wrote it: the thread's own agent, or the summarizer after a turn it left unreported. */
  source: Schema.Literals(["agent", "auto"]),
  /**
   * Who has independently reviewed the current code changes; empty when code
   * changed and nobody has, null when no code changed.
   */
  reviewedBy: Schema.NullOr(Schema.Array(Schema.String)),
});
export type BoardSummary = typeof BoardSummary.Type;

export const BoardListOutput = Schema.Struct({
  /** Every thread that has been placed; a thread with no card is unplaced. */
  cards: Schema.Array(BoardCard),
  columns: Schema.Array(BoardColumn),
  subCards: Schema.Array(BoardSubCards),
  summaries: Schema.Array(BoardSummary),
  /** Requests waiting on the user, and approvals not yet used. */
  approvals: Schema.Array(BoardApproval),
  comments: Schema.Array(BoardCommentsSummary),
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

export const BoardDecideInput = Schema.Struct({
  threadId: ThreadId,
  stage: BoardStage,
  approve: Schema.Boolean,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type BoardDecideInput = typeof BoardDecideInput.Type;

export const BoardDecideOutput = Schema.Struct({ approval: BoardApproval });
export type BoardDecideOutput = typeof BoardDecideOutput.Type;

export const BoardNudgeInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type BoardNudgeInput = typeof BoardNudgeInput.Type;

export const BoardNudgeOutput = Schema.Struct({ sent: Schema.Number });
export type BoardNudgeOutput = typeof BoardNudgeOutput.Type;

export const BoardCommentsInput = Schema.Struct({ threadId: ThreadId });
export type BoardCommentsInput = typeof BoardCommentsInput.Type;

export const BoardCommentsOutput = Schema.Struct({ comments: Schema.Array(BoardComment) });
export type BoardCommentsOutput = typeof BoardCommentsOutput.Type;

/** The user comments on a card and/or reassigns it; handing it to the agent tells the thread. */
export const BoardCardInput = Schema.Struct({
  threadId: ThreadId,
  comment: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  assignee: Schema.optional(BoardAssignee),
});
export type BoardCardInput = typeof BoardCardInput.Type;

export const BoardCardOutput = Schema.Struct({
  assignee: BoardAssignee,
  comments: Schema.Array(BoardComment),
  /** Whether the thread was sent the comments and asked to carry on. */
  told: Schema.Boolean,
});
export type BoardCardOutput = typeof BoardCardOutput.Type;

/** A card's mini pull request: its branch against the default branch. */
export const BoardBranchView = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  /** The default branch it is compared with, such as origin/main; null outside a repo. */
  base: Schema.NullOr(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  insertions: Schema.Number,
  deletions: Schema.Number,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, insertions: Schema.Number, deletions: Schema.Number }),
  ),
  commits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      subject: Schema.String,
      author: Schema.String,
      at: Schema.String,
    }),
  ),
  /** Changes not yet committed, when the branch is checked out in the thread's folder. */
  uncommitted: Schema.NullOr(
    Schema.Struct({ files: Schema.Number, insertions: Schema.Number, deletions: Schema.Number }),
  ),
});
export type BoardBranchView = typeof BoardBranchView.Type;

export const BoardBranchInput = Schema.Struct({ threadId: ThreadId });
export type BoardBranchInput = typeof BoardBranchInput.Type;

export const BoardChecksInput = Schema.Struct({ threadId: ThreadId });
export type BoardChecksInput = typeof BoardChecksInput.Type;

/** Each column's checks for a card, in board order, for columns that have any. */
export const BoardChecksOutput = Schema.Struct({
  columns: Schema.Array(
    Schema.Struct({ stage: BoardStage, results: Schema.Array(BoardCheckResult) }),
  ),
});
export type BoardChecksOutput = typeof BoardChecksOutput.Type;

/** A card added on the board: a new thread with this ticket as its first message. */
export const BoardAddCardInput = Schema.Struct({
  projectId: Schema.String,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(20_000)),
  stage: BoardStage,
  modelSelection: ModelSelection,
});
export type BoardAddCardInput = typeof BoardAddCardInput.Type;

export const BoardAddCardOutput = Schema.Struct({ threadId: ThreadId });
export type BoardAddCardOutput = typeof BoardAddCardOutput.Type;

export class BoardApiError extends Schema.TaggedError<BoardApiError>()("BoardApiError", {
  message: Schema.String,
}) {}
