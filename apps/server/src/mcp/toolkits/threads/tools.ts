/**
 * The `threads` toolkit — the agent's window onto the rest of Roost.
 *
 * A thread is not alone: the same server holds every project the user works
 * in and every thread inside them. These tools let an agent look across that
 * boundary — list the projects, list a project's threads, read a thread's
 * messages — and take two writes: create a thread and archive one. There is
 * deliberately no delete, no send, no interrupt. Archiving is reversible from
 * the archive page; deletion is not, so an agent never holds it.
 *
 * The calling thread is never a parameter. It comes off the invocation scope,
 * so "my project" and "my thread" always mean the session that made the call.
 *
 * @module mcp/toolkits/threads/tools
 */
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class ThreadToolError extends Schema.TaggedError<ThreadToolError>()("ThreadToolError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const IsoDateTime = Schema.String;

export const ProjectSummary = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  threadCount: Schema.Number.annotate({ description: "Active (unarchived) threads." }),
  current: Schema.Boolean.annotate({ description: "True for the project this thread belongs to." }),
});

export const ThreadSummary = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  turnState: Schema.NullOr(Schema.String).annotate({
    description:
      "State of the latest turn: running, completed, interrupted, error; null if never run.",
  }),
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  current: Schema.Boolean.annotate({ description: "True for the thread making this call." }),
});

export const MessageSummary = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  text: Schema.String,
  createdAt: IsoDateTime,
  streaming: Schema.Boolean,
});

// An empty struct no longer serializes as an object schema (Effect rc.115
// emits `not: {type: null}`), and the MCP server refuses to register a tool
// whose input schema has no `type` — which took the whole server down at
// startup. One optional key keeps it an object, as device_list does.
export const ProjectListInput = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean).annotate({
    description: "Count archived threads too. Default false.",
  }),
});

export const ProjectListOutput = Schema.Struct({
  projects: Schema.Array(ProjectSummary),
});

export const ThreadListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId).annotate({
    description: "Project to list. Omit for the project this thread belongs to.",
  }),
  includeArchived: Schema.optional(Schema.Boolean).annotate({
    description: "Also return archived threads. Default false.",
  }),
});

export const ThreadListOutput = Schema.Struct({
  threads: Schema.Array(ThreadSummary),
});

export const ThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  turnLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "How many of the most recent turns to return. Default 10.",
  }),
  beforeCursor: Schema.optional(Schema.String).annotate({
    description: "Opaque cursor from a previous read; returns the older page before it.",
  }),
});

export const ThreadReadOutput = Schema.Struct({
  thread: ThreadSummary,
  messages: Schema.Array(MessageSummary).annotate({
    description: "Oldest first within the returned window.",
  }),
  beforeCursor: Schema.NullOr(Schema.String).annotate({
    description: "Pass back as beforeCursor to read older turns; null when fully loaded.",
  }),
});

export const ThreadCreateInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Title of the new thread.",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description: "Project to create it in. Omit for the project this thread belongs to.",
  }),
});

export const ThreadCreateOutput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
});

export const ThreadArchiveInput = Schema.Struct({
  threadId: ThreadId,
});

export const ThreadArchiveOutput = Schema.Struct({
  threadId: ThreadId,
  archived: Schema.Literal(true),
});

const failure = ThreadToolError;
const dependencies = [McpInvocationContext.McpInvocationContext];

export const ProjectListTool = Tool.make("t3_project_list", {
  description:
    "List every project in this Roost, with how many active threads each has. " +
    "The project this thread belongs to is marked current.",
  parameters: ProjectListInput,
  success: ProjectListOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadListTool = Tool.make("t3_thread_list", {
  description:
    "List the threads of a project — by default the project this thread belongs to. " +
    "Each entry carries the latest turn's state, so you can see what is running. " +
    "Archived threads are left out unless includeArchived is set.",
  parameters: ThreadListInput,
  success: ThreadListOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read a thread's messages in any project: the user's prompts and the agent's replies, " +
    "most recent turns first by window, oldest first within it. Page back with beforeCursor.",
  parameters: ThreadReadInput,
  success: ThreadReadOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Read a thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadCreateTool = Tool.make("t3_thread_create", {
  description:
    "Create a new, empty thread in a project — by default the project this thread belongs to. " +
    "It takes the project's default model, or this thread's, and the same runtime mode as this " +
    "thread. Nothing is sent to it; the user picks it up from the sidebar.",
  parameters: ThreadCreateInput,
  success: ThreadCreateOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Create a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const ThreadArchiveTool = Tool.make("t3_thread_archive", {
  description:
    "Archive a thread. It leaves the sidebar and can be restored from the archive page; " +
    "nothing is deleted. A thread cannot archive itself.",
  parameters: ThreadArchiveInput,
  success: ThreadArchiveOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Archive a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadsToolkit = Toolkit.make(
  ProjectListTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadCreateTool,
  ThreadArchiveTool,
);
