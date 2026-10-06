import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// ── history (Roost) ──────────────────────────────────────────────────
//
// The search agents reach as `t3_history_search` — threads and the meetings
// recorded on this Mac, matched by words and by meaning — and the readers
// beside it, offered to clients as well: tui's meetings page searches and
// reads through these, so there is one index and one ranking, never a copy.

export const HistorySource = Schema.Literals(["threads", "meetings"]);
export type HistorySource = typeof HistorySource.Type;

/** Where in a meeting a passage came from. */
export const HistoryMeetingPart = Schema.Literals([
  "notes",
  "action",
  "decision",
  "transcript",
  "slides",
]);
export type HistoryMeetingPart = typeof HistoryMeetingPart.Type;

export const HistorySearchInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  /** Default both. */
  sources: Schema.optional(Schema.Array(HistorySource)),
  projectId: Schema.optional(Schema.String),
  /** Threads only: what the user wrote, or what agents wrote. */
  role: Schema.optional(Schema.Literals(["user", "assistant"])),
  /** Meetings only: just these parts — e.g. action items. */
  meetingParts: Schema.optional(Schema.Array(HistoryMeetingPart)),
  /** ISO timestamp; only what was written or recorded at or after it. */
  since: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});
export type HistorySearchInput = typeof HistorySearchInput.Type;

export const HistorySearchHit = Schema.Struct({
  matchedBy: Schema.Literals(["words", "meaning"]),
  messageId: Schema.NullOr(Schema.String),
  /** Meeting transcript hits: m:ss into the recording. */
  at: Schema.NullOr(Schema.String),
  /** user, assistant, title — or for a meeting, a HistoryMeetingPart. */
  role: Schema.String,
  createdAt: Schema.NullOr(Schema.String),
  /** Matched words are marked «…»; a meaning hit shows the passage's start. */
  snippet: Schema.String,
});
export type HistorySearchHit = typeof HistorySearchHit.Type;

export const HistorySearchResult = Schema.Struct({
  kind: Schema.Literals(["thread", "meeting"]),
  /** A thread id, or a meeting id (its folder name, e.g. 2026.09.21-1330). */
  id: Schema.String,
  title: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  date: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  score: Schema.Number,
  matchedBy: Schema.Literals(["words", "meaning", "both"]),
  matchedTerms: Schema.Number,
  hitCount: Schema.Number,
  hits: Schema.Array(HistorySearchHit),
});
export type HistorySearchResult = typeof HistorySearchResult.Type;

export const HistorySearchOutput = Schema.Struct({
  searchId: Schema.NullOr(Schema.Number),
  terms: Schema.Array(Schema.String),
  meaning: Schema.Struct({
    active: Schema.Boolean,
    embedded: Schema.Number,
    pending: Schema.Number,
    reason: Schema.NullOr(Schema.String),
  }),
  results: Schema.Array(HistorySearchResult),
});
export type HistorySearchOutput = typeof HistorySearchOutput.Type;

export const HistoryMeetingSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  durationMinutes: Schema.NullOr(Schema.Number),
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  people: Schema.Array(Schema.String),
});
export type HistoryMeetingSummary = typeof HistoryMeetingSummary.Type;

export const HistoryMeetingListInput = Schema.Struct({
  since: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});
export type HistoryMeetingListInput = typeof HistoryMeetingListInput.Type;

export const HistoryMeetingListOutput = Schema.Struct({
  meetings: Schema.Array(HistoryMeetingSummary),
});
export type HistoryMeetingListOutput = typeof HistoryMeetingListOutput.Type;

export const HistoryMeetingReadInput = Schema.Struct({
  meetingId: TrimmedNonEmptyString,
  /** m:ss or h:mm:ss into the recording; omit for the notes. */
  around: Schema.optional(Schema.String),
  /** Minutes of transcript either side of `around`. Default 2. */
  minutes: Schema.optional(Schema.Number),
  /** The notes and the whole transcript at once — for a meeting's page. */
  whole: Schema.optional(Schema.Boolean),
});
export type HistoryMeetingReadInput = typeof HistoryMeetingReadInput.Type;

export const HistoryTranscriptLine = Schema.Struct({
  at: Schema.String,
  seconds: Schema.Number,
  speaker: Schema.String,
  text: Schema.String,
});

export const HistoryMeetingReadOutput = Schema.Struct({
  meeting: HistoryMeetingSummary,
  notes: Schema.NullOr(Schema.String),
  /** What the user typed during the meeting (notes.md); null when nothing. */
  myNotes: Schema.NullOr(Schema.String),
  lines: Schema.Array(HistoryTranscriptLine),
  hasEarlier: Schema.Boolean,
  hasLater: Schema.Boolean,
  notesPath: Schema.String,
  transcriptPath: Schema.String,
});
export type HistoryMeetingReadOutput = typeof HistoryMeetingReadOutput.Type;

export const HistoryThreadMessagesInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  aroundMessageId: Schema.optional(Schema.String),
  before: Schema.optional(Schema.Number),
  after: Schema.optional(Schema.Number),
});
export type HistoryThreadMessagesInput = typeof HistoryThreadMessagesInput.Type;

export const HistoryThreadMessagesOutput = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    title: Schema.String,
    branch: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
    archivedAt: Schema.NullOr(Schema.String),
  }),
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      text: Schema.String,
      createdAt: Schema.String,
      streaming: Schema.Boolean,
    }),
  ),
  hasOlder: Schema.Boolean,
  hasNewer: Schema.Boolean,
});
export type HistoryThreadMessagesOutput = typeof HistoryThreadMessagesOutput.Type;

/** The user's own notes for a meeting, typed on its page. */
export const HistoryMeetingNotesWriteInput = Schema.Struct({
  meetingId: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type HistoryMeetingNotesWriteInput = typeof HistoryMeetingNotesWriteInput.Type;

/** The project questions about meetings are asked in, made on first use. */
export const HistoryMeetingsProject = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type HistoryMeetingsProject = typeof HistoryMeetingsProject.Type;

/** A question about meetings: a thread in the Meetings project, already sent. */
export const HistoryAskMeetingsInput = Schema.Struct({
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  /** Ask about this one meeting. */
  meetingId: Schema.optional(Schema.String),
});
export type HistoryAskMeetingsInput = typeof HistoryAskMeetingsInput.Type;

export const HistoryAskMeetingsResult = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
});
export type HistoryAskMeetingsResult = typeof HistoryAskMeetingsResult.Type;

export class HistoryApiError extends Schema.TaggedError<HistoryApiError>()("HistoryApiError", {
  message: Schema.String,
}) {}
