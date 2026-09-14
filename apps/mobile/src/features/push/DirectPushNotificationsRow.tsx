/**
 * Notification control for environments that deliver their own push.
 *
 * The relay's notification switch lives behind a T3 Connect account, which is
 * exactly what a self-hosted setup does not have. This row registers the device
 * with the environments it is already paired to, so notifications can be turned
 * on with no cloud account involved.
 */
import { unregisterEnvironmentPushDevice } from "@t3tools/client-runtime/state/pushHttp";
import * as Option from "effect/Option";
import { useCallback, useEffect, useState } from "react";
import { Alert, Platform } from "react-native";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession } from "../../state/session";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  registerDeviceWithConnectedEnvironments,
  resolveInstallationId,
  supportsDirectPush,
} from "./directPushRegistration";

type RowStatus = "checking" | "off" | "on" | "unsupported";

export function DirectPushNotificationsRow() {
  const [status, setStatus] = useState<RowStatus>("checking");

  useEffect(() => {
    setStatus(Platform.OS === "ios" && supportsDirectPush() ? "off" : "unsupported");
  }, []);

  const enable = useCallback(async () => {
    const result = await registerDeviceWithConnectedEnvironments().catch(() => null);
    if (!result || result.registeredCount === 0) {
      setStatus("off");
      Alert.alert(
        "Couldn't enable notifications",
        "This device could not register with a connected environment. Check that notification access is allowed and that an environment is connected.",
      );
      return;
    }
    setStatus("on");
    if (result.deliveryConfiguredCount === 0) {
      // Registering is only half of it: without an APNs key the server has
      // nothing to send with, and silently "succeeding" would be a lie.
      Alert.alert(
        "Registered, but not yet sending",
        "This device is registered, but no server has an APNs key configured. Add one in Settings → Voice → Phone notifications on the server.",
      );
    }
  }, []);

  const disable = useCallback(async () => {
    setStatus("off");
    const installationId = resolveInstallationId();
    const environmentIds = [
      ...appAtomRegistry.get(environmentPresentations.presentationsAtom).keys(),
    ];
    for (const environmentId of environmentIds) {
      const prepared = Option.getOrNull(
        appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (!prepared) continue;
      await runtime
        .runPromise(
          unregisterEnvironmentPushDevice({ prepared, signer: Option.none(), installationId }),
        )
        .catch(() => undefined);
    }
  }, []);

  return (
    <SettingsSwitchRow
      icon="bell.badge"
      label="Server Notifications"
      subtitle={
        status === "unsupported"
          ? "Only available on iOS builds signed for push."
          : "Let connected environments notify this device directly, without a T3 Connect account."
      }
      disabled={status === "checking" || status === "unsupported"}
      value={status === "on"}
      onValueChange={(next) => {
        void (next ? enable() : disable());
      }}
    />
  );
}
