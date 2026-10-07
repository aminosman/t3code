import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

// ── Direct push notifications ────────────────────────────────────────
//
// An environment delivers its own notifications: it holds an APNs auth key,
// signs a provider token, and posts to Apple when a turn finishes. Devices
// register their APNs token with the environment they care about, so there
// is no cloud account, relay, or shared identity in the path — the same
// shape as the voice key. Outbound-only, so an environment behind NAT still
// notifies fine.

export const PUSH_DEVICE_REGISTER_PATH = "/api/push/devices/register";
export const PUSH_DEVICE_UNREGISTER_PATH = "/api/push/devices/unregister";
/** Answers a thread from a notification: a typed reply, or approve / decline. */
export const PUSH_REPLY_PATH = "/api/push/reply";

// ── Notification categories ──────────────────────────────────────────
//
// The phone registers these with iOS so a thread's notification carries
// action buttons. The server picks one per phase; the phone answers through
// PUSH_REPLY_PATH without opening the app.

/** Finished, failed, or asked a question: a Reply text box. */
export const PUSH_THREAD_REPLY_CATEGORY = "THREAD_REPLY";
/** Waiting on an approval: Approve, Decline, and Reply. */
export const PUSH_THREAD_APPROVAL_CATEGORY = "THREAD_APPROVAL";
export const PUSH_REPLY_ACTION = "THREAD_REPLY";
export const PUSH_APPROVE_ACTION = "THREAD_APPROVE";
export const PUSH_DECLINE_ACTION = "THREAD_DECLINE";

/** Which APNs host a token belongs to; a sandbox token 400s on production. */
export const PushEnvironment = Schema.Literals(["sandbox", "production"]);
export type PushEnvironment = typeof PushEnvironment.Type;

export const PushPlatform = Schema.Literals(["ios"]);
export type PushPlatform = typeof PushPlatform.Type;

export const PushDeviceRegistration = Schema.Struct({
  /** Raw APNs device token, hex encoded. */
  deviceToken: TrimmedNonEmptyString,
  platform: PushPlatform,
  pushEnvironment: PushEnvironment,
  /** Stable per-install id so re-registration replaces rather than duplicates. */
  installationId: TrimmedNonEmptyString,
  /** Shown in settings so a stale device is recognizable. */
  deviceName: Schema.optionalKey(TrimmedString),
});
export type PushDeviceRegistration = typeof PushDeviceRegistration.Type;

export const PushDeviceUnregistration = Schema.Struct({
  installationId: TrimmedNonEmptyString,
});
export type PushDeviceUnregistration = typeof PushDeviceUnregistration.Type;

export const PushRegistrationResult = Schema.Struct({
  registered: Schema.Boolean,
  /** False when the environment has no APNs key configured yet. */
  deliveryConfigured: Schema.Boolean,
});
export type PushRegistrationResult = typeof PushRegistrationResult.Type;

/** A registered device as settings show it. The token itself never leaves the server. */
export const PushDevice = Schema.Struct({
  installationId: TrimmedNonEmptyString,
  platform: PushPlatform,
  pushEnvironment: PushEnvironment,
  deviceName: Schema.optionalKey(TrimmedString),
  /** Last characters of the APNs token, to tell two registrations apart. */
  tokenSuffix: Schema.String,
  /** Epoch ms of the latest registration. */
  registeredAt: Schema.Number,
});
export type PushDevice = typeof PushDevice.Type;

export const PushDeviceList = Schema.Struct({
  devices: Schema.Array(PushDevice),
  /** False when the environment has no APNs key configured yet. */
  deliveryConfigured: Schema.Boolean,
});
export type PushDeviceList = typeof PushDeviceList.Type;

export const PushDeviceRemoveInput = Schema.Struct({
  installationId: TrimmedNonEmptyString,
});
export type PushDeviceRemoveInput = typeof PushDeviceRemoveInput.Type;

export const PushDeviceTestInput = Schema.Struct({
  installationId: TrimmedNonEmptyString,
});
export type PushDeviceTestInput = typeof PushDeviceTestInput.Type;

export const PushDeviceTestResult = Schema.Struct({
  delivered: Schema.Boolean,
  /** Why it did not go, in words for settings. */
  message: Schema.optionalKey(Schema.String),
});
export type PushDeviceTestResult = typeof PushDeviceTestResult.Type;

export class PushDeviceError extends Schema.TaggedError<PushDeviceError>()("PushDeviceError", {
  message: Schema.String,
}) {}

/** What a notification action sends back to the thread it came from. */
export const PushReply = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["reply", "approve", "decline"]),
  /** The typed text, for "reply". */
  text: Schema.optionalKey(TrimmedNonEmptyString),
  /** The pending request the notification was about, when it was one. */
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Made on the phone, so a retried reply is applied once. */
  replyId: TrimmedNonEmptyString,
});
export type PushReply = typeof PushReply.Type;

export const PushReplyResult = Schema.Struct({
  /** How the reply landed. */
  delivery: Schema.Literals(["sent", "answered", "approved", "declined"]),
});
export type PushReplyResult = typeof PushReplyResult.Type;

/** Payload carried to the device so a tap can open the right thread. */
export const PushThreadPayload = Schema.Struct({
  threadId: ThreadId,
  environmentId: TrimmedNonEmptyString,
});
export type PushThreadPayload = typeof PushThreadPayload.Type;

export const PushDeliveryErrorCode = Schema.Literals([
  "not-configured",
  "invalid-key",
  "rejected",
  "unavailable",
]);
export type PushDeliveryErrorCode = typeof PushDeliveryErrorCode.Type;
