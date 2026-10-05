import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import type * as ApnsClient from "./ApnsClient.ts";

/**
 * The environment's APNs credentials, or null when push is off or incomplete.
 *
 * Null used to be silent: Roost lost its push block between Sep 9 and Sep 27
 * 2026 and skipped every notification for weeks with nothing in the log. A
 * caller that has devices to notify now says so, once per process.
 */
let warnedMissing = false;

export const readApnsCredentials = (options?: { readonly devicesWaiting?: number }) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchTag("ServerSettingsError", (cause) =>
        Effect.logWarning("push: failed to read settings", { cause }).pipe(Effect.as(undefined)),
      ),
    );
    const push = settings?.push;
    if (
      !push?.enabled ||
      push.authKey.length === 0 ||
      push.keyId.length === 0 ||
      push.teamId.length === 0 ||
      push.bundleId.length === 0
    ) {
      if (!warnedMissing && (options?.devicesWaiting ?? 0) > 0) {
        warnedMissing = true;
        yield* Effect.logWarning(
          "push: devices are registered but push is not configured; notifications are skipped",
          {
            devices: options?.devicesWaiting,
            enabled: push?.enabled ?? false,
            hasKey: (push?.authKey.length ?? 0) > 0,
          },
        );
      }
      return null;
    }
    warnedMissing = false;
    return {
      teamId: push.teamId,
      keyId: push.keyId,
      privateKey: push.authKey,
      bundleId: push.bundleId,
    } satisfies ApnsClient.ApnsCredentials;
  });
