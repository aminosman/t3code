import * as Schema from "effect/Schema";

// ── Voice oracle (realtime speech session) ────────────────────────────
//
// The voice oracle is a browser-side realtime speech agent that helps the
// user direct the coding agent on a thread. The server's only involvement
// is minting short-lived OpenAI Realtime client secrets from the API key
// stored in server settings; audio flows browser ↔ OpenAI directly over
// WebRTC and never touches the T3 server.

export const VOICE_REALTIME_SESSION_PATH = "/api/voice/realtime-session";

export const DEFAULT_VOICE_REALTIME_MODEL = "gpt-realtime";
export const DEFAULT_VOICE_REALTIME_VOICE = "marin";

/** Success payload for `POST /api/voice/realtime-session`. */
export const VoiceRealtimeSessionResponse = Schema.Struct({
  /** Ephemeral OpenAI client secret (`ek_…`), safe to hand to the browser. */
  clientSecret: Schema.String,
  /** Unix epoch seconds when the client secret expires, when known. */
  expiresAt: Schema.NullOr(Schema.Number),
  model: Schema.String,
  voice: Schema.String,
});
export type VoiceRealtimeSessionResponse = typeof VoiceRealtimeSessionResponse.Type;

export const VoiceRealtimeSessionErrorCode = Schema.Literals(["not-configured", "upstream-error"]);
export type VoiceRealtimeSessionErrorCode = typeof VoiceRealtimeSessionErrorCode.Type;

/** Error payload for `POST /api/voice/realtime-session` (non-2xx). */
export const VoiceRealtimeSessionErrorResponse = Schema.Struct({
  error: VoiceRealtimeSessionErrorCode,
  message: Schema.String,
});
export type VoiceRealtimeSessionErrorResponse = typeof VoiceRealtimeSessionErrorResponse.Type;
