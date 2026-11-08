// Roost's card wall, as a tool every agent has: t3_card_update keeps the
// thread's own card current. Registered beside upstream's toolkits with one
// line in McpHttpServer.ts.
import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { ThreadToolError } from "../../mcp/toolkits/threads/tools.ts";

export const CardUpdateInput = Schema.Struct({
  stage: Schema.optional(Schema.String).annotate({
    description: "The column the work now belongs in, by id or title. Omit to keep it.",
  }),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(400))).annotate({
    description: "One or two plain sentences: what the work is and where it stands now.",
  }),
  next: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description:
      'Who acts next and on what ("You: approve the migration", "Agent: rerun tests"); "" when nothing is pending.',
  }),
  reviewedBy: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))).annotate({
    description:
      "Who independently reviewed the current code changes (a reviewer's model, a person who approved the PR); [] when code changed and nobody has; null when no code changed.",
  }),
  assignee: Schema.optional(Schema.Literals(["agent", "user"])).annotate({
    description:
      '"user" hands the card to the user when you need them to act; say what in comment. "agent" takes it back.',
  }),
  tests: Schema.optional(
    Schema.Array(
      Schema.Struct({
        case: Schema.String,
        result: Schema.Literals(["pass", "fail", "skip"]),
        note: Schema.optional(Schema.String),
      }),
    ),
  ).annotate({
    description:
      "The end-to-end test matrix: every case and permutation that matters for this change, each with its result. Replaces the last one.",
  }),
  regression: Schema.optional(
    Schema.Struct({ passed: Schema.Boolean, command: Schema.String, summary: Schema.String }),
  ).annotate({
    description:
      "The last regression run of the project's existing suites: what ran and whether it passed.",
  }),
  branch: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))).annotate({
    description:
      "The git branch the work lives on, when it is not the thread's own; the card shows it as a pull request into the default branch. null clears it.",
  }),
  comment: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))).annotate({
    description: "A comment on the card, shown to the user: what you need from them, step by step.",
  }),
  threadId: Schema.optional(ThreadId).annotate({
    description: "Omit for your own thread's card.",
  }),
});

const CardColumnInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  archives: Schema.Boolean,
  requiresApproval: Schema.Boolean,
  /** Facts Roost checks before the card may move in. */
  checks: Schema.Array(Schema.String),
});

export const CardUpdateOutput = Schema.Struct({
  threadId: ThreadId,
  stage: Schema.String,
  summary: Schema.String,
  next: Schema.String,
  reviewedBy: Schema.NullOr(Schema.Array(Schema.String)),
  reviewsWanted: Schema.Number,
  columns: Schema.Array(CardColumnInfo),
  /** The checks this call ran for the column asked for, when it has any. */
  checks: Schema.Array(
    Schema.Struct({ kind: Schema.String, ok: Schema.Boolean, detail: Schema.String }),
  ),
  /** What to do when the card did not move. */
  instruction: Schema.String,
  approval: Schema.NullOr(
    Schema.Struct({ stage: Schema.String, status: Schema.String, instruction: Schema.String }),
  ),
  assignee: Schema.Literals(["agent", "user"]),
  /** The card's latest comments, oldest first. */
  comments: Schema.Array(
    Schema.Struct({ author: Schema.String, body: Schema.String, createdAt: Schema.String }),
  ),
});

const CardUpdateTool = Tool.make("t3_card_update", {
  description:
    "Read or update this thread's card on the user's card wall, a Trello-style board of " +
    "threads. Send only the fields that changed; with no arguments it changes nothing and " +
    "returns the card, its latest comments and the board's columns, each with the requirement " +
    "for being in it. Moving into a column marked requiresApproval files an approval request " +
    "instead, and a message arrives in this thread when the user decides. A column's checks " +
    "(reviews, a pushed branch, merged, tests passing) are confirmed by Roost; a refused move " +
    "says what is missing. When a reviews check fails on code changes, Roost starts two " +
    "read-only reviewers on other models and their findings arrive in this thread. Never " +
    "archives the thread.",
  parameters: CardUpdateInput,
  success: CardUpdateOutput,
  failure: Schema.Union([ThreadToolError, OrchestratorMcpFailure]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Update your card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const BoardToolkit = Toolkit.make(CardUpdateTool);
