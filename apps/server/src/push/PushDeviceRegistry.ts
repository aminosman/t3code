/**
 * Registry of devices this environment pushes to.
 *
 * Registrations are per-environment, not per-account: a device tells the
 * environment it is paired with "notify this APNs token", so there is no
 * cloud identity to reconcile. The list lives in the secret store because a
 * device token is a bearer capability to notify that device, and because it
 * keeps the registry out of the settings file users hand-edit and share.
 */
import type { PushDeviceRegistration } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const REGISTRY_SECRET_NAME = "push-device-registry";

/** Devices that stop reporting in are dropped rather than pushed to forever. */
const REGISTRATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const RegisteredPushDevice = Schema.Struct({
  installationId: Schema.String,
  deviceToken: Schema.String,
  platform: Schema.Literals(["ios"]),
  pushEnvironment: Schema.Literals(["sandbox", "production"]),
  deviceName: Schema.optionalKey(Schema.String),
  registeredAt: Schema.Number,
});
export type RegisteredPushDevice = typeof RegisteredPushDevice.Type;

const PushDeviceRegistryFile = Schema.Struct({
  devices: Schema.Array(RegisteredPushDevice),
});

const decodeRegistry = Schema.decodeUnknownOption(Schema.fromJsonString(PushDeviceRegistryFile));
const encodeRegistry = Schema.encodeSync(Schema.fromJsonString(PushDeviceRegistryFile));

export class PushDeviceRegistry extends Context.Service<
  PushDeviceRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<RegisteredPushDevice>>;
    readonly register: (
      registration: PushDeviceRegistration,
    ) => Effect.Effect<ReadonlyArray<RegisteredPushDevice>>;
    readonly unregister: (installationId: string) => Effect.Effect<void>;
    /** Drops a token APNs reported as permanently gone. */
    readonly forget: (deviceToken: string) => Effect.Effect<void>;
  }
>()("t3/push/PushDeviceRegistry") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const readAll = Effect.gen(function* () {
    const stored = yield* secrets.get(REGISTRY_SECRET_NAME).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("push: failed to read device registry", { cause }).pipe(
          Effect.as(Option.none<Uint8Array>()),
        ),
      ),
    );
    if (Option.isNone(stored)) {
      return [] as ReadonlyArray<RegisteredPushDevice>;
    }
    const decoded = decodeRegistry(textDecoder.decode(stored.value));
    return Option.isSome(decoded) ? decoded.value.devices : [];
  });

  const writeAll = (devices: ReadonlyArray<RegisteredPushDevice>) =>
    secrets
      .set(REGISTRY_SECRET_NAME, textEncoder.encode(encodeRegistry({ devices })))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("push: failed to persist device registry", { cause }),
        ),
      );

  const live = (devices: ReadonlyArray<RegisteredPushDevice>, nowMs: number) =>
    devices.filter((device) => nowMs - device.registeredAt < REGISTRATION_TTL_MS);

  const list = Effect.gen(function* () {
    const [devices, nowMs] = yield* Effect.all([readAll, Clock.currentTimeMillis]);
    return live(devices, nowMs);
  });

  const register: PushDeviceRegistry["Service"]["register"] = (registration) =>
    Effect.gen(function* () {
      const [devices, nowMs] = yield* Effect.all([readAll, Clock.currentTimeMillis]);
      // Keyed by installation, so a token rotation replaces the old entry
      // instead of leaving a dead one behind to be pushed to forever.
      const next: ReadonlyArray<RegisteredPushDevice> = [
        ...live(devices, nowMs).filter(
          (device) => device.installationId !== registration.installationId,
        ),
        {
          installationId: registration.installationId,
          deviceToken: registration.deviceToken,
          platform: registration.platform,
          pushEnvironment: registration.pushEnvironment,
          ...(registration.deviceName ? { deviceName: registration.deviceName } : {}),
          registeredAt: nowMs,
        },
      ];
      yield* writeAll(next);
      return next;
    });

  const unregister: PushDeviceRegistry["Service"]["unregister"] = (installationId) =>
    Effect.gen(function* () {
      const devices = yield* readAll;
      const next = devices.filter((device) => device.installationId !== installationId);
      if (next.length !== devices.length) {
        yield* writeAll(next);
      }
    });

  const forget: PushDeviceRegistry["Service"]["forget"] = (deviceToken) =>
    Effect.gen(function* () {
      const devices = yield* readAll;
      const next = devices.filter((device) => device.deviceToken !== deviceToken);
      if (next.length !== devices.length) {
        yield* Effect.logInfo("push: dropping device token APNs reported as gone");
        yield* writeAll(next);
      }
    });

  return PushDeviceRegistry.of({ list, register, unregister, forget });
});

export const layer = Layer.effect(PushDeviceRegistry, make);
