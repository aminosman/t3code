/**
 * Registers this device for notifications delivered by the environment itself.
 *
 * The relay path (`features/agent-awareness/remoteRegistration`) registers with
 * T3 Connect and lets the relay fan out. This registers with the environment
 * directly, which is what lets a self-hosted server notify its own phone with
 * no cloud account in between. The two are independent: a build can use either,
 * both, or neither.
 */
import { registerEnvironmentPushDevice } from "@t3tools/client-runtime/state/pushHttp";
import type { PushDeviceRegistration } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as Option from "effect/Option";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession } from "../../state/session";
import { resolveApsEnvironment } from "../agent-awareness/registrationPayload";

/**
 * True when this build carries the push entitlement. Free personal-team builds
 * cannot sign it, so asking iOS for a token there fails at runtime.
 */
export function supportsDirectPush(): boolean {
  return Constants.expoConfig?.extra?.iosPushEntitlement !== false;
}

/** Stable per-install id so re-registering replaces rather than duplicates. */
export function resolveInstallationId(): string {
  return Constants.sessionId;
}

export async function buildDirectPushRegistration(): Promise<PushDeviceRegistration | null> {
  if (!supportsDirectPush()) {
    return null;
  }
  const permission = await Notifications.getPermissionsAsync();
  const granted =
    permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
      ? true
      : (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) {
    return null;
  }

  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data !== "string" || token.data.length === 0) {
    return null;
  }

  const deviceName = Device.deviceName ?? undefined;
  return {
    deviceToken: token.data,
    platform: "ios",
    pushEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
    installationId: resolveInstallationId(),
    ...(deviceName ? { deviceName } : {}),
  };
}

/**
 * Best-effort: a device that cannot register still works, it just misses
 * notifications, so failures are reported rather than thrown at callers.
 */
export async function registerDeviceWithEnvironment(
  environmentId: EnvironmentId,
): Promise<{ readonly registered: boolean; readonly deliveryConfigured: boolean }> {
  const registration = await buildDirectPushRegistration();
  if (!registration) {
    return { registered: false, deliveryConfigured: false };
  }
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (!prepared) {
    return { registered: false, deliveryConfigured: false };
  }

  return runtime.runPromise(
    registerEnvironmentPushDevice({ prepared, signer: Option.none(), registration }),
  );
}

/**
 * Register with every environment the device has a live connection to. Each
 * environment notifies about its own threads, so a device that talks to three
 * servers registers with all three.
 */
export async function registerDeviceWithConnectedEnvironments(): Promise<{
  readonly registeredCount: number;
  readonly deliveryConfiguredCount: number;
}> {
  const registration = await buildDirectPushRegistration();
  if (!registration) {
    return { registeredCount: 0, deliveryConfiguredCount: 0 };
  }

  const environmentIds: ReadonlyArray<EnvironmentId> = [
    ...appAtomRegistry.get(environmentPresentations.presentationsAtom).keys(),
  ];
  let registeredCount = 0;
  let deliveryConfiguredCount = 0;
  for (const environmentId of environmentIds) {
    const prepared = Option.getOrNull(
      appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    if (!prepared) {
      continue;
    }
    // One unreachable environment must not stop the others from registering.
    const result = await runtime
      .runPromise(registerEnvironmentPushDevice({ prepared, signer: Option.none(), registration }))
      .catch(() => null);
    if (result?.registered) {
      registeredCount += 1;
      if (result.deliveryConfigured) {
        deliveryConfiguredCount += 1;
      }
    }
  }
  return { registeredCount, deliveryConfiguredCount };
}
