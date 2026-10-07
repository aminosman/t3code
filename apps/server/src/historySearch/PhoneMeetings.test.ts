import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

import * as Meetings from "./Meetings.ts";
import * as PhoneMeetings from "./PhoneMeetings.ts";

const meeting = {
  meetingId: "2026.10.07-0830-ab12",
  title: "Coffee with Jordan",
  kind: "room" as const,
  startedAt: "2026-10-07T08:30:12.345Z",
  durationSeconds: 1805.4,
  myNotes: "ship the list first",
  transcript: [
    { seconds: 0.4, text: "Can we look at the phone first?" },
    { seconds: 3725, text: "Swipe   left for chats." },
    { seconds: 3800, text: "   " },
  ],
};

const tempMeetingsDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "phone-meetings-"));

it("writes the phone's transcript in the reader's own line format", () => {
  const markdown = PhoneMeetings.phoneTranscriptMarkdown(meeting.meetingId, meeting.transcript);
  const lines = Meetings.parseTranscript(markdown);
  assert.deepStrictEqual(lines, [
    { at: "0:00", seconds: 0, speaker: "room", text: "Can we look at the phone first?" },
    { at: "1:02:05", seconds: 3725, speaker: "room", text: "Swipe left for chats." },
  ]);
});

it("describes the recording the way tui reads a room recording, in whole seconds", () => {
  const meta = PhoneMeetings.phoneMetaJson(meeting);
  assert.strictEqual(meta.started, "2026-10-07T08:30:12Z");
  assert.strictEqual(meta.ended, "2026-10-07T09:00:17Z");
  assert.strictEqual(meta.duration_seconds, 1805);
  assert.strictEqual(meta.mode, "room");
  assert.deepStrictEqual(meta.files, { mic: PhoneMeetings.PHONE_MEETING_AUDIO_FILE });
  assert.strictEqual(meta.context.title, "Coffee with Jordan");
});

it.effect("waits for the audio, then writes meta.json last and leaves a retry alone", () =>
  Effect.gen(function* () {
    const dir = tempMeetingsDir();
    const folder = NodePath.join(dir, meeting.meetingId);

    const early = yield* PhoneMeetings.importPhoneMeeting(dir, meeting).pipe(Effect.flip);
    assert.strictEqual(early.reason, "the audio has not arrived yet");
    assert.isFalse(NodeFS.existsSync(NodePath.join(folder, "meta.json")));

    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(folder, PhoneMeetings.PHONE_MEETING_AUDIO_FILE), "aac");
    const first = yield* PhoneMeetings.importPhoneMeeting(dir, meeting);
    assert.strictEqual(first.status, "imported");
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(folder, "notes.md"), "utf8"),
      "ship the list first",
    );
    const meta = JSON.parse(NodeFS.readFileSync(NodePath.join(folder, "meta.json"), "utf8"));
    assert.strictEqual(meta.source, "phone");

    // tui has since replaced the phone's transcript with its own.
    NodeFS.writeFileSync(NodePath.join(folder, "transcript.md"), "tui's");
    const retry = yield* PhoneMeetings.importPhoneMeeting(dir, meeting);
    assert.strictEqual(retry.status, "already");
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(folder, "transcript.md"), "utf8"),
      "tui's",
    );

    const loaded = yield* Meetings.load(dir, meeting.meetingId);
    assert.strictEqual(loaded?.title, "Coffee with Jordan");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses names that are not a meeting folder", () =>
  Effect.gen(function* () {
    const error = yield* PhoneMeetings.importPhoneMeeting(tempMeetingsDir(), {
      ...meeting,
      meetingId: "../escape",
    }).pipe(Effect.flip);
    assert.include(error.reason, "not a meeting name");
  }).pipe(Effect.provide(NodeServices.layer)),
);

const uploadLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-phone-meeting-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "signs an audio upload, streams it into the meeting folder, and skips one already there",
  () =>
    Effect.gen(function* () {
      const dir = tempMeetingsDir();
      const bytes = new TextEncoder().encode("phone-audio-bytes");
      const issued = yield* PhoneMeetings.issueAudioUploadUrl(dir, {
        meetingId: meeting.meetingId,
        sizeBytes: bytes.byteLength,
      });
      const relativeUrl = issued.relativeUrl ?? "";
      assert.isTrue(relativeUrl.startsWith(`${PhoneMeetings.PHONE_MEETING_AUDIO_ROUTE_PREFIX}/`));
      const token = relativeUrl.slice(PhoneMeetings.PHONE_MEETING_AUDIO_ROUTE_PREFIX.length + 1);

      const claims = yield* PhoneMeetings.validateAudioUploadToken(token);
      assert.strictEqual(claims?.meetingId, meeting.meetingId);
      assert.isNull(yield* PhoneMeetings.validateAudioUploadToken(`${token}x`));

      const short = yield* PhoneMeetings.storeAudioUpload(
        dir,
        claims!,
        Stream.make(bytes.slice(0, 4)),
      );
      assert.isFalse(short.ok);
      const stored = yield* PhoneMeetings.storeAudioUpload(dir, claims!, Stream.make(bytes));
      assert.isTrue(stored.ok);
      const file = NodePath.join(dir, meeting.meetingId, PhoneMeetings.PHONE_MEETING_AUDIO_FILE);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "phone-audio-bytes");
      assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(dir, meeting.meetingId)), [
        PhoneMeetings.PHONE_MEETING_AUDIO_FILE,
      ]);

      const again = yield* PhoneMeetings.issueAudioUploadUrl(dir, {
        meetingId: meeting.meetingId,
        sizeBytes: bytes.byteLength,
      });
      assert.isNull(again.relativeUrl);
    }).pipe(Effect.provide(uploadLayer)),
);
