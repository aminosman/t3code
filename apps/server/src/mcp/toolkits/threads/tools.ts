/**
 * The `threads` toolkit — the agent's window onto the rest of Roost.
 *
 * A thread is not alone: the same server holds every project the user works
 * in and every thread inside them. These tools let an agent look across that
 * boundary — search everything that was ever said, in threads and in recorded
 * meetings, list the projects, list a project's threads, read a thread's
 * messages, read a meeting, see which models the user has set up — and take
 * two writes: create a
 * thread and archive one. Search comes first on purpose: an agent that wants
 * to know how something was done before should ask for it by what it is, get
 * back the handful of threads that hold it, and read only those. There is
 * deliberately no delete, no interrupt, and no sending into a thread that already
 * exists: the one message an agent may send is the first one of a thread it
 * creates, which is how it asks for a fresh pair of eyes (a review by another
 * model, from another provider, with none of this thread's context). Archiving is reversible from
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
      "what holds more of them ranks higher. It is also matched by meaning, so describe the " +
      "thing the way you would to a person: 'the assistant texted someone without permission' " +
      "finds the thread where the user said it sent a message it should only have drafted. " +
      "Misspelled and mis-transcribed words are widened to the near-spellings the index " +
      "knows. Identifiers and paths work as written " +
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
  matchedBy: Schema.Literals(["words", "meaning"]).annotate({
    description:
      "words: the snippet shows the match in «…». meaning: no shared words were needed; the " +
      "snippet is how the passage opens, so read around it to see why it matched.",
  }),
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
  score: Schema.Number.annotate({
    description: "Out of 100, which is first by words and first by meaning.",
  }),
  matchedBy: Schema.Literals(["words", "meaning", "both"]),
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
  meaning: Schema.Struct({
    active: Schema.Boolean,
    embedded: Schema.Number,
    pending: Schema.Number,
    reason: Schema.NullOr(Schema.String),
  }).annotate({
    description:
      "Whether this search was also matched by meaning. When active is false, or pending is " +
      "large, it was (partly) by words alone: add synonyms to the query — 'billing invoice " +
      "charges payment' — because any word may match.",
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

export const ModelChoice = Schema.Struct({
  instanceId: Schema.String.annotate({
    description: "The provider instance, as t3_model_list gives it (e.g. claudeAgent, codex).",
  }),
  model: Schema.String.annotate({ description: "The model's slug, as t3_model_list gives it." }),
  options: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
  ).annotate({
    description:
      "Option id to value, from the model's options in t3_model_list — typically reasoning " +
      'effort, e.g. {"effort": "high"}. Omit for the model\'s defaults.',
  }),
});

export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["select", "boolean"]),
  choices: Schema.Array(Schema.String).annotate({
    description: "Values a select option takes; empty for a boolean.",
  }),
  default: Schema.NullOr(Schema.Union([Schema.String, Schema.Boolean])),
});

export const ModelSummary = Schema.Struct({
  model: Schema.String.annotate({ description: "The slug to pass as model." }),
  name: Schema.String,
  isDefault: Schema.Boolean,
  isNew: Schema.Boolean,
  current: Schema.Boolean.annotate({ description: "True for the model this thread runs on." }),
  options: Schema.Array(ModelOption),
});

export const UsageWindow = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
});

export const ProviderSummary = Schema.Struct({
  instanceId: Schema.String.annotate({ description: "Pass as instanceId." }),
  provider: Schema.String.annotate({
    description: "Who makes the agent behind it (claudeAgent, codex, cursor, grok, …).",
  }),
  name: Schema.String,
  account: Schema.NullOr(Schema.String),
  usable: Schema.Boolean.annotate({
    description: "Enabled, installed, signed in and ready. Only usable providers can be picked.",
  }),
  unusableBecause: Schema.NullOr(Schema.String),
  current: Schema.Boolean.annotate({ description: "True for the provider this thread runs on." }),
  usage: Schema.Array(UsageWindow).annotate({
    description:
      "How much of the account's allowance is spent, when the provider reports it. A provider " +
      "near 100% will stall a thread started on it.",
  }),
  models: Schema.Array(ModelSummary),
});

export const ModelListInput = Schema.Struct({
  includeUnusable: Schema.optional(Schema.Boolean).annotate({
    description:
      "Also list providers that are disabled, not installed or signed out. Default false.",
  }),
});

export const ModelListOutput = Schema.Struct({
  providers: Schema.Array(ProviderSummary),
});

export const ThreadCreateInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Title of the new thread. Say what it is for: 'Review: history search index'.",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description: "Project to create it in. Omit for the project this thread belongs to.",
  }),
  prompt: Schema.optional(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "The first message. With it the new thread starts working at once; without it the thread " +
      "is created empty for the user to pick up. The agent there starts with NONE of this " +
      "thread's context — that is the point — so write everything it needs: what to look at " +
      "(paths, commits, branch), what to judge or do, what you want back, and what not to " +
      "touch. For a review, do not tell it your conclusions; tell it what to examine.",
  }),
  model: Schema.optional(ModelChoice).annotate({
    description:
      "The model for the new thread, from t3_model_list. Omit for the project's default, or " +
      "this thread's. For an independent or adversarial review, pick a different provider " +
      "than the one this thread runs on, and a strong model.",
  }),
});

export const ThreadCreateOutput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  started: Schema.Boolean.annotate({
    description:
      "True when a prompt was sent and the thread is working. Follow it with t3_thread_wait.",
  }),
  model: Schema.Struct({ instanceId: Schema.String, model: Schema.String }),
});

export const ThreadWaitInput = Schema.Struct({
  threadId: ThreadId,
  timeoutSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description:
      "How long to wait for the turn to end. Default 300, at most 900. If it runs out the " +
      "thread is still working; call again, or carry on and come back.",
  }),
});

export const ThreadWaitOutput = Schema.Struct({
  thread: ThreadSummary,
  state: Schema.Literals(["done", "running", "needs-user", "interrupted", "error"]).annotate({
    description:
      "done: the turn ended and reply holds its answer. running: still working when the wait " +
      "ran out. needs-user: it stopped for an approval or a question only the user can " +
      "answer in its own thread. interrupted / error: it did not finish.",
  }),
  reply: Schema.NullOr(Schema.String).annotate({
    description: "The thread's last assistant message, cut to 12000 characters.",
  }),
  waitedSeconds: Schema.Number,
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
    "misspellings are widened, and passages are also matched by meaning by a model on this " +
    "Mac, so a plain description works even when it shares no words with what was said. " +
    "The result's `meaning` says whether that was active; when it was not, add synonyms. " +
    "It costs a few KB however large the history is. Then " +
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

export const ModelListTool = Tool.make("t3_model_list", {
  description:
    "List the agent providers and models the user has set up in this Roost and that can be " +
    "used right now: provider instance, account, how much of its allowance is spent, and each " +
    "model with its options (reasoning effort and the like). The provider and model this " +
    "thread runs on are marked current. Call it before t3_thread_create when you want a " +
    "particular model — never guess a slug.",
  parameters: ModelListInput,
  success: ModelListOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadCreateTool = Tool.make("t3_thread_create", {
  description:
    "Create a new thread in a project — by default the project this thread belongs to — and, " +
    "with a prompt, start it working on a model you choose. The agent there is a separate " +
    "session with a clean context: it knows nothing of this conversation beyond what the " +
    "prompt says (it can search and read this thread like any other).\n\n" +
    "Use it when a fresh, independent mind is worth more than continuity: a review of work " +
    "you just did, an adversarial check of a plan or a diagnosis, a second opinion from a " +
    "different provider's model, or a separate piece of work the user asked to have its own " +
    "thread. Pick the model with t3_model_list: for a review, a different provider than this " +
    "thread's and a strong model. Do NOT use it to split up ordinary work, to get around a " +
    "failing approach, or for anything the user would expect to see happen here — a new " +
    "thread spends the user's allowance and lands in their sidebar. Tell the user when you " +
    "start one and why. It runs in the project's own checkout with this thread's runtime " +
    "mode, so say in the prompt whether it may edit files; for a review, say read-only.\n\n" +
    "Then t3_thread_wait for its answer, read it critically, and report what it found — " +
    "including where it disagrees with you. Without a prompt, the thread is created empty and " +
    "the user picks it up from the sidebar.",
  parameters: ThreadCreateInput,
  success: ThreadCreateOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Create a thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const ThreadWaitTool = Tool.make("t3_thread_wait", {
  description:
    "Wait for another thread's current turn to end and return its answer: the way to collect " +
    "the result of a thread started with t3_thread_create. Returns early with needs-user if " +
    "the thread stops for an approval or a question, and with running if the wait runs out. " +
    "For more than the last message, use t3_thread_read.",
  parameters: ThreadWaitInput,
  success: ThreadWaitOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Wait for a thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

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
  ModelListTool,
  ThreadCreateTool,
  ThreadWaitTool,
  ThreadArchiveTool,
);
