/**
 * The `threads` toolkit — the agent's window onto the rest of Roost.
 *
 * A thread is not alone: the same server holds every project the user works
 * in and every thread inside them. These tools let an agent look across that
 * boundary — search everything that was ever said, in threads and in recorded
 * meetings, list the projects, list a project's threads, read a thread's
 * messages, read a meeting — and take two writes: create a
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

export const HistorySearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "What you are looking for, in plain words: the feature, the bug, the file, the error " +
      "text, the decision, the thing someone said. A sentence is fine — filler words are " +
      "dropped, words are stemmed (sending = send = sends), any of the words may match, and " +
      "what holds more of them ranks higher. Because any word may match, add the likely " +
      "synonyms: 'billing invoice charges payment'. Misspelled and mis-transcribed words are " +
      "widened to the near-spellings the index knows. Identifiers and paths work as written " +
      '(kea_ask, Updater.swift). Put an exact phrase in "double quotes".',
  }),
  sources: Schema.optional(Schema.Array(Schema.Literals(["threads", "meetings"]))).annotate({
    description: "Where to look. Omit for both, which is usually what you want.",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description:
      "One project only: its threads, and the meetings filed under it. Omit to search " +
      "everything, which is usually what you want — many meetings are not filed at all.",
  }),
  role: Schema.optional(Schema.Literals(["user", "assistant"])).annotate({
    description:
      "Threads only: just what the user wrote (what was asked for, corrections, decisions) or " +
      "just what agents wrote (what was found and done). Omit for both.",
  }),
  since: Schema.optional(IsoDateTime).annotate({
    description: "ISO date or timestamp; only what was written or recorded at or after it.",
  }),
  includeCurrent: Schema.optional(Schema.Boolean).annotate({
    description: "Also return the thread making this call. Default false.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "How many threads and meetings to return. Default 8, at most 25.",
  }),
});

export const HistorySearchHit = Schema.Struct({
  messageId: Schema.NullOr(Schema.String).annotate({
    description:
      "Thread hits: pass to t3_thread_read as aroundMessageId to read the exchange around it. " +
      "Null for a title match and for meetings.",
  }),
  at: Schema.NullOr(Schema.String).annotate({
    description:
      "Meeting transcript hits: where in the recording (m:ss). Pass to t3_meeting_read as " +
      "around to read the conversation there. Null for notes and slides.",
  }),
  role: Schema.String.annotate({
    description: "user, assistant or title; for a meeting: notes, transcript or slides.",
  }),
  createdAt: Schema.NullOr(IsoDateTime),
  snippet: Schema.String.annotate({ description: "The matching passage; matches sit in «…»." }),
});

export const HistorySearchResult = Schema.Struct({
  kind: Schema.Literals(["thread", "meeting"]),
  id: Schema.String.annotate({
    description: "A thread id (for t3_thread_read) or a meeting id (for t3_meeting_read).",
  }),
  title: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  date: Schema.NullOr(IsoDateTime).annotate({
    description: "A thread's last update; a meeting's start.",
  }),
  archivedAt: Schema.NullOr(IsoDateTime),
  score: Schema.Number,
  matchedTerms: Schema.Number.annotate({
    description: "How many of the query's terms appear somewhere in it.",
  }),
  hitCount: Schema.Number,
  hits: Schema.Array(HistorySearchHit).annotate({ description: "The best few, strongest first." }),
});

export const HistorySearchOutput = Schema.Struct({
  terms: Schema.Array(Schema.String).annotate({
    description:
      "How the query was read; '~' shows what a word was widened to. Reword and search again " +
      "if they miss.",
  }),
  results: Schema.Array(HistorySearchResult).annotate({ description: "Best first." }),
});

export const MeetingSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  startedAt: Schema.NullOr(IsoDateTime),
  durationMinutes: Schema.NullOr(Schema.Number),
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  people: Schema.Array(Schema.String),
});

export const MeetingListInput = Schema.Struct({
  since: Schema.optional(IsoDateTime).annotate({
    description: "ISO date or timestamp; only meetings that started at or after it.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "How many to return, newest first. Default 20.",
  }),
});

export const MeetingListOutput = Schema.Struct({
  meetings: Schema.Array(MeetingSummary),
});

export const MeetingReadInput = Schema.Struct({
  meetingId: Schema.String.annotate({
    description: "A meeting id from t3_history_search or t3_meeting_list, e.g. 2026.09.21-1330.",
  }),
  around: Schema.optional(Schema.String).annotate({
    description:
      "A time into the recording (m:ss), as a transcript hit gives it. Returns who said what " +
      "around then. Omit for the meeting's notes: summary, decisions, action items.",
  }),
  minutes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "With around: minutes of transcript either side. Default 2, at most 30.",
  }),
});

export const MeetingReadOutput = Schema.Struct({
  meeting: MeetingSummary,
  notes: Schema.NullOr(Schema.String).annotate({
    description:
      "The written notes, generated by a small local model from the transcript: a guide to " +
      "what was discussed, not a record of it. Null when reading around a time.",
  }),
  lines: Schema.Array(
    Schema.Struct({ at: Schema.String, speaker: Schema.String, text: Schema.String }),
  ).annotate({
    description:
      "The transcript around the time asked for. 'me' is the user; speaker names and words " +
      "are as the recogniser heard them and can be wrong.",
  }),
  hasEarlier: Schema.Boolean,
  hasLater: Schema.Boolean,
  notesPath: Schema.String,
  transcriptPath: Schema.String.annotate({
    description: "The whole transcript on disk, if a window is not enough.",
  }),
});

export const ThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  aroundMessageId: Schema.optional(Schema.String).annotate({
    description:
      "A messageId from t3_history_search. Returns that message with the few before and after " +
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

export const HistorySearchTool = Tool.make("t3_history_search", {
  description:
    "Search what has been said: every message in every thread on this server (all projects, " +
    "archived threads included) and every meeting recorded on this Mac (notes, transcripts, " +
    "slides). Returns the threads and meetings that match, best first, each with the passages " +
    "that matched. Use it BEFORE starting work that may have a history: to see whether this " +
    "was already done or tried, how something like it was done before, what the user decided " +
    "or corrected last time, what was said about it on a call, and what else has been worked " +
    "on around it. It is also the way to find a thread at all: thread titles are " +
    "auto-generated and often say nothing about the work inside, so do not hunt through " +
    "t3_thread_list.\n\n" +
    "Loose on purpose: words are stemmed, any of them may match, more of them ranks higher, " +
    "and misspellings are widened. It does not match by meaning, so name the thing the way " +
    "the user would and add synonyms. It costs a few KB however large the history is. Then " +
    "read only what earned it: t3_thread_read with a hit's messageId as aroundMessageId, or " +
    "t3_meeting_read with a hit's at as around. If the first wording misses, search again " +
    "with other words, a file name, or the error text.",
  parameters: HistorySearchInput,
  success: HistorySearchOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Search threads and meetings")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MeetingListTool = Tool.make("t3_meeting_list", {
  description:
    "List the meetings recorded on this Mac, newest first: when, how long, who was named, and " +
    "the project each was filed under, if any. To find a meeting by what was said in it, use " +
    "t3_history_search instead.",
  parameters: MeetingListInput,
  success: MeetingListOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List meetings")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MeetingReadTool = Tool.make("t3_meeting_read", {
  description:
    "Read a meeting. Without around: its notes (summary, key points, decisions, action items). " +
    "With around (the at of a transcript hit from t3_history_search): who said what in the " +
    "minutes either side of that moment. The notes are a local model's summary and can be " +
    "wrong; when it matters what was actually said, read the transcript around it.",
  parameters: MeetingReadInput,
  success: MeetingReadOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Read a meeting")
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
    "With aroundMessageId (a hit from t3_history_search) it returns that message and the few " +
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
  HistorySearchTool,
  MeetingListTool,
  MeetingReadTool,
  ProjectListTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadCreateTool,
  ThreadArchiveTool,
);
