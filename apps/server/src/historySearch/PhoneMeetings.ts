/**
 * Meetings recorded on the phone, put on the Mac.
 *
 * The phone records and transcribes on its own, so a meeting is never lost
 * offline. When the Mac is reachable it hands the meeting over in two steps:
 *
 * 1. The audio, streamed to a signed URL into `~/Meetings/<id>/phone.m4a`.
 * 2. The rest: `transcript.md` (the phone's own transcript, so the meeting
 *    reads at once), `notes.md` (what the user typed) and, last, `meta.json`.
 *
 * `meta.json` is the sign tui reads as "this recording is finished": it then
 * transcribes `phone.m4a` itself (Parakeet, with room diarization), writes the
 * notes and files the meeting into a project, exactly as for a meeting it
 * recorded. Nothing here runs tui; the folder is the interface, as for the
 * reader in Meetings.ts.
 *
 * @module historySearch/PhoneMeetings
 */
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import type {
  HistoryPhoneMeetingImportInput,
  HistoryPhoneMeetingImportOutput,
  HistoryPhoneMeetingUploadUrlInput,
  HistoryPhoneMeetingUploadUrlOutput,
} from "@t3tools/contracts";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Meetings from "./Meetings.ts";

export const PHONE_MEETING_AUDIO_ROUTE_PREFIX = "/api/meetings/phone-audio";
export const PHONE_MEETING_AUDIO_FILE = "phone.m4a";
/** A day of speech-quality audio is far under this; it stops a runaway upload. */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOAD_URL_TTL_MS = 30 * 60_000;
const SIGNING_SECRET_NAME = "phone-meeting-upload-signing-key";

export class PhoneMeetingError extends Schema.TaggedError<PhoneMeetingError>()(
  "PhoneMeetingError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(UnknownFromJsonString);

const Claims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("phone-meeting-audio"),
  meetingId: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
type Claims = typeof Claims.Type;
const claimsJson = Schema.fromJsonString(Claims);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);
const encodeClaims = Schema.encodeSync(claimsJson);

const signingSecret = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return yield* secrets.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

const folderOf = (meetingsDir: string, meetingId: string) =>
  Effect.gen(function* () {
    if (!Meetings.isMeetingId(meetingId)) {
      return yield* new PhoneMeetingError({ reason: `not a meeting name: ${meetingId}` });
    }
    const path = yield* Path.Path;
    return path.join(meetingsDir, meetingId);
  });

const fileSize = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(file).pipe(Effect.option);
    return info._tag === "Some" && info.value.type === "File" ? Number(info.value.size) : null;
  });

/** Signs a URL for the audio, or says it is already on the Mac (a retry). */
export const issueAudioUploadUrl = Effect.fn("PhoneMeetings.issueAudioUploadUrl")(function* (
  meetingsDir: string,
  input: HistoryPhoneMeetingUploadUrlInput,
) {
  if (
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > MAX_AUDIO_BYTES
  ) {
    return yield* new PhoneMeetingError({ reason: "the recording's size is out of range" });
  }
  const path = yield* Path.Path;
  const folder = yield* folderOf(meetingsDir, input.meetingId);
  const existing = yield* fileSize(path.join(folder, PHONE_MEETING_AUDIO_FILE));
  if (existing === input.sizeBytes) {
    return { relativeUrl: null } satisfies HistoryPhoneMeetingUploadUrlOutput;
  }
  const secret = yield* signingSecret.pipe(
    Effect.mapError(() => new PhoneMeetingError({ reason: "could not sign the upload" })),
  );
  const payload = base64UrlEncode(
    encodeClaims({
      version: 1,
      kind: "phone-meeting-audio",
      meetingId: input.meetingId,
      sizeBytes: input.sizeBytes,
      expiresAt: (yield* Clock.currentTimeMillis) + UPLOAD_URL_TTL_MS,
    }),
  );
  return {
    relativeUrl: `${PHONE_MEETING_AUDIO_ROUTE_PREFIX}/${payload}.${signPayload(payload, secret)}`,
  } satisfies HistoryPhoneMeetingUploadUrlOutput;
});

export const validateAudioUploadToken = Effect.fn("PhoneMeetings.validateToken")(function* (
  token: string,
) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const secret = yield* signingSecret.pipe(Effect.orElseSucceed(() => null));
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return null;
  const decoded = yield* Effect.try(() => base64UrlDecodeUtf8(payload)).pipe(Effect.option);
  const claims = Option.isSome(decoded) ? Option.getOrNull(decodeClaims(decoded.value)) : null;
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});

export type StoreAudioResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly detail: string };

/** Streams the audio into the meeting's folder, via a .part file renamed when whole. */
export const storeAudioUpload = Effect.fn("PhoneMeetings.storeAudio")(function* (
  meetingsDir: string,
  claims: Claims,
  body: HttpServerRequest.HttpServerRequest["stream"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* folderOf(meetingsDir, claims.meetingId).pipe(Effect.option);
  if (folder._tag === "None") {
    return { ok: false, status: 400, detail: "Not a meeting name." } satisfies StoreAudioResult;
  }
  const finalPath = path.join(folder.value, PHONE_MEETING_AUDIO_FILE);
  const partPath = `${finalPath}.${NodeCrypto.randomUUID()}.part`;
  let received = 0;
  return yield* Effect.gen(function* () {
    yield* fs.makeDirectory(folder.value, { recursive: true });
    yield* Stream.run(
      body.pipe(
        Stream.takeWhile((chunk) => {
          received += chunk.byteLength;
          return received <= claims.sizeBytes;
        }),
      ),
      fs.sink(partPath),
    );
    if (received !== claims.sizeBytes) {
      return {
        ok: false,
        status: 400,
        detail: `Body was ${received} bytes, expected ${claims.sizeBytes}.`,
      } satisfies StoreAudioResult;
    }
    yield* fs.rename(partPath, finalPath);
    return { ok: true } satisfies StoreAudioResult;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to store a phone meeting's audio.", {
        meetingId: claims.meetingId,
        cause,
      }).pipe(
        Effect.as({
          ok: false,
          status: 500,
          detail: "Failed to store the audio.",
        } satisfies StoreAudioResult),
      ),
    ),
    Effect.ensuring(
      fs.remove(partPath, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );
});

/** m:ss, or h:mm:ss past an hour — the transcript's own way of writing time. */
const clock = (totalSeconds: number) => {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

export const phoneTranscriptMarkdown = (
  meetingId: string,
  lines: HistoryPhoneMeetingImportInput["transcript"],
): string =>
  [
    `# ${meetingId}`,
    "",
    "engine: apple-speech (on the iPhone; tui transcribes the audio again on the Mac)",
    "speakers: room",
    "",
    ...lines
      .filter((line) => line.text.trim().length > 0)
      .map((line) => `**[${clock(line.seconds)}] room:** ${line.text.trim().replace(/\s+/g, " ")}`),
    "",
  ].join("\n");

/** tui reads these with a plain ISO 8601 parser: whole seconds, no fraction. */
const isoSeconds = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Math.floor(millis / 1000) * 1000)).replace(
    /\.\d{3}Z$/,
    "Z",
  );

export const phoneMetaJson = (input: HistoryPhoneMeetingImportInput) => {
  const startedMs = DateTime.toEpochMillis(DateTime.makeUnsafe(input.startedAt));
  return {
    started: isoSeconds(startedMs),
    ended: isoSeconds(startedMs + Math.max(0, input.durationSeconds) * 1000),
    duration_seconds: Math.round(input.durationSeconds),
    // tui's room mode: one track, diarized into voices.
    mode: "room",
    in_person: input.kind === "room",
    files: { mic: PHONE_MEETING_AUDIO_FILE },
    start_offset_ms: { mic: 0 },
    context: { app: "iPhone", title: input.title },
    source: "phone",
    phone: { kind: input.kind },
  };
};

/**
 * Writes the phone's meeting beside its audio. A retry finds meta.json and
 * leaves the folder alone, since tui may already have replaced the phone's
 * transcript with its own.
 */
export const importPhoneMeeting = Effect.fn("PhoneMeetings.import")(function* (
  meetingsDir: string,
  input: HistoryPhoneMeetingImportInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* folderOf(meetingsDir, input.meetingId);
  const write = (name: string, text: string) =>
    fs
      .writeFileString(path.join(folder, name), text)
      .pipe(Effect.mapError(() => new PhoneMeetingError({ reason: `could not write ${name}` })));

  if (yield* fs.exists(path.join(folder, "meta.json")).pipe(Effect.orElseSucceed(() => false))) {
    return {
      meetingId: input.meetingId,
      status: "already",
    } satisfies HistoryPhoneMeetingImportOutput;
  }
  if ((yield* fileSize(path.join(folder, PHONE_MEETING_AUDIO_FILE))) === null) {
    return yield* new PhoneMeetingError({ reason: "the audio has not arrived yet" });
  }
  yield* write("transcript.md", phoneTranscriptMarkdown(input.meetingId, input.transcript));
  if (input.myNotes.trim().length > 0) yield* write("notes.md", input.myNotes);
  // Last: tui treats a folder with meta.json as a finished recording.
  yield* write("meta.json", `${encodeJson(phoneMetaJson(input))}\n`);
  return {
    meetingId: input.meetingId,
    status: "imported",
  } satisfies HistoryPhoneMeetingImportOutput;
});
