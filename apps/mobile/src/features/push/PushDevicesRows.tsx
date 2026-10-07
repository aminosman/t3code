/**
 * The phones each paired environment notifies, under Server Notifications.
 *
 * The same list as the desktop's Settings → Devices, so a duplicate or a
 * phone that is gone can be removed from either side. A tap offers a test
 * notification or removal.
 */
import type { EnvironmentId, PushDevice } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "../settings/components/SettingsRow";
import { resolveInstallationId } from "./directPushRegistration";

function registeredLabel(device: PushDevice): string {
  const days = Math.floor((Date.now() - device.registeredAt) / 86_400_000);
  const when = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `Registered ${when} · token …${device.tokenSuffix}`;
}

function EnvironmentPushDevices(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly showEnvironment: boolean;
  readonly thisInstallationId: string | null;
}) {
  const list = useEnvironmentQuery(
    serverEnvironment.pushDevices({ environmentId: props.environmentId, input: {} }),
  );
  const remove = useAtomCommand(serverEnvironment.removePushDevice, { reportFailure: false });
  const test = useAtomCommand(serverEnvironment.testPushDevice, { reportFailure: false });

  const act = (device: PushDevice, name: string) => {
    const input = {
      environmentId: props.environmentId,
      input: { installationId: device.installationId },
    };
    Alert.alert(name, registeredLabel(device), [
      {
        text: "Send test notification",
        onPress: () =>
          void test(input).then((result) => {
            if (result._tag === "Failure") {
              Alert.alert("Not sent", String(squashAtomCommandFailure(result)));
            } else if (!result.value.delivered) {
              Alert.alert("Not sent", result.value.message ?? "");
              list.refresh();
            }
          }),
      },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void remove(input).then((result) => {
            if (result._tag === "Failure") {
              Alert.alert("Not removed", String(squashAtomCommandFailure(result)));
            }
            list.refresh();
          }),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (list.data?.devices ?? []).map((device) => {
    const mine = device.installationId === props.thisInstallationId;
    const name = `${device.deviceName ?? "iPhone"}${mine ? " (this device)" : ""}`;
    return (
      <SettingsRow
        key={`${props.environmentId}:${device.installationId}`}
        icon={{ ios: "iphone", android: "smartphone" }}
        label={props.showEnvironment ? `${name} · ${props.environmentLabel}` : name}
        value={registeredLabel(device)}
        onPress={() => act(device, name)}
      />
    );
  });
}

export function PushDevicesRows() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = Object.values(savedConnectionsById);
  const [thisInstallationId, setThisInstallationId] = useState<string | null>(null);
  useEffect(() => {
    void resolveInstallationId().then(setThisInstallationId);
  }, []);

  return connections.map((connection) => (
    <EnvironmentPushDevices
      key={connection.environmentId}
      environmentId={connection.environmentId}
      environmentLabel={connection.environmentLabel}
      showEnvironment={connections.length > 1}
      thisInstallationId={thisInstallationId}
    />
  ));
}
