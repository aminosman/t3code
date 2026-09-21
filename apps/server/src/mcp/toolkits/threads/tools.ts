/**
 * The `threads` toolkit — the agent's window onto the rest of Roost.
 *
 * A thread is not alone: the same server holds every project the user works
 * in and every thread inside them. These tools let an agent look across that
 * boundary — search everything that was ever said, list the projects, list a
 * project's threads, read a thread's messages — and take two writes: create a
 * thread and archive one. Search comes first on purpose: an agent that wants
 * to know how something was done before should ask for it by what it is, get
 * back the handful of threads that hold it, and read only those. There is
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

export const ThreadSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "What you are looking for, in plain words: the feature, the bug, the file, the error " +
      "text, the decision. A sentence is fine — filler words are dropped, words are stemmed " +
      "(sending = send = sends), any of the words may match and threads holding more of them " +
      "rank higher. Identifiers and paths work as written (kea_ask, Updater.swift). Put an " +
      'exact phrase in "double quotes".',
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description:
      "Search one project only. Omit to search every project, which is usually what you want.",
  }),
  role: Schema.optional(Schema.Literals(["user", "assistant"])).annotate({
    description:
      "Only what the user wrote (what was asked for, corrections, decisions) or only what " +
      "agents wrote (what was found and done). Omit for both.",
  }),
  since: Schema.optional(IsoDateTime).annotate({
    description: "ISO date or timestamp; only messages written at or after it.",
  }),
  includeCurrent: Schema.optional(Schema.Boolean).annotate({
    description: "Also return the thread making this call. Default false.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "How many threads to return. Default 8, at most 25.",
  }),
});

export const ThreadSearchHit = Schema.Struct({
  messageId: Schema.NullOr(Schema.String).annotate({
    description:
      "Pass to t3_thread_read as aroundMessageId to read the exchange around it. Null when " +
      "the match is the thread's title (role: title).",
  }),
  role: Schema.String,
  createdAt: Schema.NullOr(IsoDateTime),
  snippet: Schema.String.annotate({ description: "The matching passage; matches sit in «…»." }),
});

export const ThreadSearchResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  score: Schema.Number,
  matchedTerms: Schema.Number.annotate({
    description: "How many of the query's terms appear somewhere in this thread.",
  }),
  hitCount: Schema.Number,
  hits: Schema.Array(ThreadSearchHit).annotate({ description: "The best few, strongest first." }),
});

export const ThreadSearchOutput = Schema.Struct({
  terms: Schema.Array(Schema.String).annotate({
    description: "The terms the query was read as. Reword and search again if they miss.",
  }),
  results: Schema.Array(ThreadSearchResult).annotate({ description: "Best thread first." }),
});

export const ThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  aroundMessageId: Schema.optional(Schema.String).annotate({
    description:
      "A messageId from t3_thread_search. Returns that message with the few before and after " +
      "it instead of the thread's latest turns. Works on archived threads.",
  }),
  before: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "With aroundMessageId: messages to include before it. Default 4.",
  }),
  after: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "With aroundMessageId: messages to include after it. Default 4.",
  }),
  maxCharsPerMessage: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description:
      "Longer messages are cut to this many characters, keeping the start and the end, where " +
      "the request and the conclusion are. Default 6000.",
  }),
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
  hasOlder: Schema.Boolean.annotate({
    description: "There are messages before this window; raise `before` to see them.",
  }),
  hasNewer: Schema.Boolean.annotate({
    description: "There are messages after this window; raise `after` to see them.",
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

export const ThreadSearchTool = Tool.make("t3_thread_search", {
  description:
    "Search everything said in every thread on this server — all projects, archived threads " +
    "included — and get back the threads that match, best first, each with the passages that " +
    "matched. Use it BEFORE starting work that may have a history: to see whether this was " +
    "already done or tried, how something like it was done before, what the user decided or " +
    "corrected last time, and what else has been worked on around it. It is also the way to " +
    "find a thread at all: thread titles are auto-generated and often say nothing about the " +
    "work inside, so do not hunt through t3_thread_list.\n\n" +
    "Full-text and linguistic, not exact: words are stemmed, any of them may match, threads " +
    "holding more of them rank higher. It costs a few KB however large the history is. Then " +
    "read only what earned it: t3_thread_read with the hit's messageId as aroundMessageId. " +
    "If the first wording misses, search again with the user's likely words, a file name, or " +
    "the error text.",
  parameters: ThreadSearchInput,
  success: ThreadSearchOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Search threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

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
    "Read a thread's messages in any project: the user's prompts and the agent's replies. " +
    "With aroundMessageId (a hit from t3_thread_search) it returns that message and the few " +
    "around it, from active and archived threads alike. Without it, the most recent turns, " +
    "oldest first within the window; page back with beforeCursor. Long messages are cut to " +
    "maxCharsPerMessage.",
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
  ThreadSearchTool,
  ProjectListTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadCreateTool,
  ThreadArchiveTool,
);
