import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PushDeviceRegistry from "./PushDeviceRegistry.ts";

/**
 * In-memory stand-in so the registry's own behavior is what is under test.
 * Built per test: registrations persist, so a shared store would let one case
 * see another's devices.
 */
const makeTestLayer = () =>
  PushDeviceRegistry.layer.pipe(
    Layer.provide(
      Layer.sync(ServerSecretStore.ServerSecretStore, () => {
        const values = new Map<string, Uint8Array>();
        return ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.succeed(Option.fromNullishOr(values.get(name))),
          set: (name, value) => Effect.sync(() => void values.set(name, value)),
          create: (name, value) => Effect.sync(() => void values.set(name, value)),
          getOrCreateRandom: (name) =>
            Effect.sync(() => {
              const existing = values.get(name);
              if (existing) return existing;
              const created = new Uint8Array([1, 2, 3]);
              values.set(name, created);
              return created;
            }),
          remove: (name) => Effect.sync(() => void values.delete(name)),
        });
      }),
    ),
  );

const registration = (overrides?: { installationId?: string; deviceToken?: string }) =>
  ({
    installationId: overrides?.installationId ?? "install-1",
    deviceToken: overrides?.deviceToken ?? "token-1",
    platform: "ios",
    pushEnvironment: "production",
  }) as const;

describe("PushDeviceRegistry", () => {
  it.effect("keeps one entry per installation when a token rotates", () =>
    Effect.gen(function* () {
      const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
      yield* registry.register(registration({ deviceToken: "old-token" }));
      yield* registry.register(registration({ deviceToken: "new-token" }));

      assert.deepEqual(
        (yield* registry.list).map((device) => device.deviceToken),
        ["new-token"],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("keeps separate installations side by side", () =>
    Effect.gen(function* () {
      const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
      yield* registry.register(registration({ installationId: "phone", deviceToken: "a" }));
      yield* registry.register(registration({ installationId: "tablet", deviceToken: "b" }));

      assert.lengthOf(yield* registry.list, 2);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("drops a token APNs reported as gone", () =>
    Effect.gen(function* () {
      const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
      yield* registry.register(registration({ installationId: "phone", deviceToken: "dead" }));
      yield* registry.register(registration({ installationId: "tablet", deviceToken: "live" }));

      yield* registry.forget("dead");

      assert.deepEqual(
        (yield* registry.list).map((device) => device.deviceToken),
        ["live"],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("unregisters by installation", () =>
    Effect.gen(function* () {
      const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
      yield* registry.register(registration({ installationId: "phone" }));
      yield* registry.unregister("phone");

      assert.isEmpty(yield* registry.list);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("forgets devices that stopped reporting in", () =>
    Effect.gen(function* () {
      const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
      yield* registry.register(registration());
      yield* TestClock.adjust("91 days");

      assert.isEmpty(yield* registry.list);
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
