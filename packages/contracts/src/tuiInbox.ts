import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// ── tui inbox ────────────────────────────────────────────────────────
//
// tui is the Mac's voice assistant: one decider classifies every utterance
// and acts (opens threads, hands work off, drives the Mac). It runs beside
// this server and holds a long-lived `tuiInbox.connect` stream. A phone
// sends it text or a voice note from the home screen with `tuiInbox.send`;
// tui hears it through the same front door as push-to-talk, and posts back
// what it heard, said, showed and asks (`tuiInbox.post`). The phone follows
// along on `tuiInbox.subscribe` and answers a prompt, or stops a running
// hands run, with `tuiInbox.control`. A prompt also goes out as a push
// notification with Allow / Decline actions.

/** A voice note is capped so one RPC frame carries it. */
export const TUI_INBOX_MAX_AUDIO_BASE64 = 8 * 1024 * 1024;
export const TUI_INBOX_MAX_TEXT = 4000;
/** The push category the phone registers with Allow / Decline actions. */
export const TUI_INBOX_PROMPT_CATEGORY = "TUI_PROMPT";
export const TUI_INBOX_PROMPT_ALLOW_ACTION = "TUI_ALLOW";
export const TUI_INBOX_PROMPT_DECLINE_ACTION = "TUI_DECLINE";

const InboxText = Schema.String.check(Schema.isMaxLength(TUI_INBOX_MAX_TEXT));

export const TuiInboxVoiceNote = Schema.Struct({
  base64: Schema.String.check(Schema.isNonEmpty()).check(
    Schema.isMaxLength(TUI_INBOX_MAX_AUDIO_BASE64),
  ),
  /** e.g. audio/mp4 (AAC in .m4a), audio/wav. */
  mimeType: TrimmedNonEmptyString,
  durationMs: Schema.optional(Schema.Number),
});
export type TuiInboxVoiceNote = typeof TuiInboxVoiceNote.Type;

/** What the phone sends: text, a voice note, or both (a typed note on a clip). */
export const TuiInboxSendInput = Schema.Struct({
  /** Client-made id, so a resend after a dropped socket is not heard twice. */
  clientMessageId: TrimmedNonEmptyString,
  text: Schema.optional(InboxText),
  voice: Schema.optional(TuiInboxVoiceNote),
});
export type TuiInboxSendInput = typeof TuiInboxSendInput.Type;

export const TuiInboxSendResult = Schema.Struct({
  utteranceId: TrimmedNonEmptyString,
  /** False when tui is not connected; the utterance waits for it. */
  delivered: Schema.Boolean,
});
export type TuiInboxSendResult = typeof TuiInboxSendResult.Type;

export const TuiInboxVerdict = Schema.Literals(["up", "down"]);
export type TuiInboxVerdict = typeof TuiInboxVerdict.Type;

/** The phone answering a prompt, or stopping what tui is running. */
export const TuiInboxControlInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("verdict"),
    promptId: TrimmedNonEmptyString,
    verdict: TuiInboxVerdict,
  }),
  Schema.Struct({ type: Schema.Literal("stop") }),
]);
export type TuiInboxControlInput = typeof TuiInboxControlInput.Type;

/** tui registering its stream. */
export const TuiInboxHost = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  version: Schema.optional(Schema.String),
});
export type TuiInboxHost = typeof TuiInboxHost.Type;

export const TuiInboxUtterance = Schema.Struct({
  id: TrimmedNonEmptyString,
  sentAt: Schema.String,
  text: Schema.optional(Schema.String),
  voice: Schema.optional(TuiInboxVoiceNote),
});
export type TuiInboxUtterance = typeof TuiInboxUtterance.Type;

/** What tui receives on its stream. */
export const TuiInboxHostEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("utterance"), utterance: TuiInboxUtterance }),
  Schema.Struct({
    type: Schema.Literal("verdict"),
    promptId: Schema.String,
    verdict: TuiInboxVerdict,
  }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  /** Another tui took the stream; this one should not reconnect on its own. */
  Schema.Struct({ type: Schema.Literal("superseded") }),
]);
export type TuiInboxHostEvent = typeof TuiInboxHostEvent.Type;

/** What tui posts back about a turn. */
export const TuiInboxPost = Schema.Union([
  /** The words tui heard in a voice note, after its own name corrections. */
  Schema.Struct({
    type: Schema.Literal("heard"),
    utteranceId: Schema.String,
    text: InboxText,
  }),
  /** Spoken aloud at the Mac (a reply, an ask, a promise). */
  Schema.Struct({
    type: Schema.Literal("say"),
    text: InboxText,
    utteranceId: Schema.optional(Schema.String),
  }),
  /** Shown in the notch without being spoken. */
  Schema.Struct({
    type: Schema.Literal("show"),
    text: InboxText,
    utteranceId: Schema.optional(Schema.String),
  }),
  /** A card waiting for ↑ / ↓ before tui acts. */
  Schema.Struct({
    type: Schema.Literal("prompt"),
    promptId: TrimmedNonEmptyString,
    text: InboxText,
    /** `confirm` waits for ↑ before acting and is pushed; `rate` asks
     * whether what was done was right and is only shown in the app. */
    kind: Schema.optional(Schema.Literals(["confirm", "rate"])),
    utteranceId: Schema.optional(Schema.String),
    /** How long tui waits before giving up, in ms. */
    expiresInMs: Schema.optional(Schema.Number),
  }),
  /** The card settled, from any device or by the clock. */
  Schema.Struct({
    type: Schema.Literal("settled"),
    promptId: TrimmedNonEmptyString,
    outcome: Schema.Literals(["up", "down", "expired"]),
  }),
  /** A hands run on the Mac: started, a step, or ended. */
  Schema.Struct({
    type: Schema.Literal("hands"),
    phase: Schema.Literals(["start", "step", "end"]),
    text: InboxText,
    ok: Schema.optional(Schema.Boolean),
  }),
  /** tui finished with an utterance. */
  Schema.Struct({ type: Schema.Literal("done"), utteranceId: Schema.String }),
]);
export type TuiInboxPost = typeof TuiInboxPost.Type;

/** One line of the conversation the phone shows. */
export const TuiInboxEntry = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  from: Schema.Literals(["me", "tui"]),
  /** For `me`: the utterance; for `tui`: one post. */
  utterance: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      text: Schema.optional(Schema.String),
      voice: Schema.Boolean,
      durationMs: Schema.optional(Schema.Number),
    }),
  ),
  post: Schema.optional(TuiInboxPost),
});
export type TuiInboxEntry = typeof TuiInboxEntry.Type;

/** What the phone receives on its stream. */
export const TuiInboxEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    hostConnected: Schema.Boolean,
    entries: Schema.Array(TuiInboxEntry),
  }),
  Schema.Struct({ type: Schema.Literal("entry"), entry: TuiInboxEntry }),
  Schema.Struct({ type: Schema.Literal("host"), connected: Schema.Boolean }),
]);
export type TuiInboxEvent = typeof TuiInboxEvent.Type;

export class TuiInboxError extends Schema.TaggedError<TuiInboxError>()("TuiInboxError", {
  message: Schema.String,
}) {}
