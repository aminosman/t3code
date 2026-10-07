/**
 * The device list settings show: who this environment notifies, without the
 * tokens themselves (a token is a capability to notify that device).
 */
import type { PushDevice, PushDeviceList } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readDeliveryConfigured } from "./http.ts";
import * as PushDeviceRegistry from "./PushDeviceRegistry.ts";

export function publicPushDevice(device: PushDeviceRegistry.RegisteredPushDevice): PushDevice {
  return {
    installationId: device.installationId,
    platform: device.platform,
    pushEnvironment: device.pushEnvironment,
    ...(device.deviceName ? { deviceName: device.deviceName } : {}),
    tokenSuffix: device.deviceToken.slice(-6),
    registeredAt: device.registeredAt,
  };
}

export const listPushDevices = Effect.gen(function* () {
  const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
  const devices = yield* registry.list;
  return {
    devices: [...devices]
      .sort((left, right) => right.registeredAt - left.registeredAt)
      .map(publicPushDevice),
    deliveryConfigured: yield* readDeliveryConfigured,
  } satisfies PushDeviceList;
});

export const removePushDevice = (installationId: string) =>
  Effect.gen(function* () {
    const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
    yield* registry.unregister(installationId);
    yield* Effect.logInfo("push: device removed from settings", { installationId });
    return yield* listPushDevices;
  });
