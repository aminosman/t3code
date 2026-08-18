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
