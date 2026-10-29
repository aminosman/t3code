import { registerEnvironmentPushDevice } from "@t3tools/client-runtime/state/pushHttp";
import { readEnvironmentHttpAuthServices } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { PushDeviceRegistration } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as Option from "effect/Option";

import { uuidv4 } from "../../lib/uuid";
import { runtime } from "../../lib/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
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

const INSTALLATION_ID_KEY = "t3code.push.installation-id";
let installationId: Promise<string> | null = null;

/**
 * Stable id for this install, so re-registering replaces rather than
 * duplicates. It was `Constants.sessionId` until Oct 2026, which is new on
 * every launch: each launch registered the same phone again, and it was
 * notified once per copy. Kept in the keychain, so it outlives a reinstall.
 */
export function resolveInstallationId(): Promise<string> {
  installationId ??= (async () => {
    const stored = await SecureStore.getItemAsync(INSTALLATION_ID_KEY).catch(() => null);
    if (stored) return stored;
    const created = uuidv4();
    await SecureStore.setItemAsync(INSTALLATION_ID_KEY, created).catch(() => undefined);
    return created;
  })();
  return installationId;
}

export async function buildDirectPushRegistration(): Promise<PushDeviceRegistration | null> {
  if (!supportsDirectPush()) {
    return null;
  }
  const permission = await Notifications.getPermissionsAsync();
  const granted =
    permission.granted ||
    permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
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
    installationId: await resolveInstallationId(),
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
    registerEnvironmentPushDevice({
      prepared,
      ...readEnvironmentHttpAuthServices(connectionAtomRuntime, appAtomRegistry),
      registration,
    }),
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
      .runPromise(
        registerEnvironmentPushDevice({
          prepared,
          ...readEnvironmentHttpAuthServices(connectionAtomRuntime, appAtomRegistry),
          registration,
        }),
      )
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
