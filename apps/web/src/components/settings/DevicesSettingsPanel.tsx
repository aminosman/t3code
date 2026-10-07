import type { EnvironmentId, PushDevice } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { SmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function DeviceRow({
  device,
  environmentId,
  onRemoved,
}: {
  device: PushDevice;
  environmentId: EnvironmentId;
  onRemoved: () => void;
}) {
  const remove = useAtomCommand(serverEnvironment.removePushDevice, { reportFailure: false });
  const test = useAtomCommand(serverEnvironment.testPushDevice, { reportFailure: false });
  const [busy, setBusy] = useState<"test" | "remove" | null>(null);
  const name = device.deviceName ?? "iPhone";

  const sendTest = async () => {
    setBusy("test");
    const result = await test({
      environmentId,
      input: { installationId: device.installationId },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not notify ${name}`,
        description: String(squashAtomCommandFailure(result)),
      });
      return;
    }
    toastManager.add(
      result.value.delivered
        ? { type: "success", title: `Sent a test to ${name}` }
        : {
            type: "error",
            title: `Could not notify ${name}`,
            description: result.value.message ?? "",
          },
    );
    if (!result.value.delivered) onRemoved();
  };

  const removeDevice = async () => {
    setBusy("remove");
    const result = await remove({
      environmentId,
      input: { installationId: device.installationId },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not remove ${name}`,
        description: String(squashAtomCommandFailure(result)),
      });
      return;
    }
    onRemoved();
  };

  return (
    <li className="flex items-center gap-3 py-2.5">
      <SmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {device.pushEnvironment === "production" ? "App Store / TestFlight" : "Development build"}
          {" · registered "}
          {formatRelativeTimeLabel(new Date(device.registeredAt).toISOString())}
          {" · token …"}
          {device.tokenSuffix}
        </p>
      </div>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void sendTest()}>
        {busy === "test" ? "Sending…" : "Send test"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null}
        onClick={() => void removeDevice()}
      >
        {busy === "remove" ? "Removing…" : "Remove"}
      </Button>
    </li>
  );
}

export function DevicesSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const list = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.pushDevices({ environmentId, input: {} }),
  );
  const devices = list.data?.devices ?? [];

  return (
    <SettingsPageContainer>
      <SettingsSection title="Notified devices">
        <SettingsRow
          {...searchableSetting("push-devices")}
          description="Phones this environment sends notifications to. A phone registers itself when Server Notifications is turned on in the mobile app; remove one here to stop notifying it."
        >
          <div className="pt-2 pb-1">
            {environmentId === null ? (
              <p className="text-sm text-muted-foreground">Connect to an environment first.</p>
            ) : list.error ? (
              <p className="text-sm text-destructive">{list.error}</p>
            ) : list.data === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                {list.data.deliveryConfigured ? null : (
                  <p className="pb-2 text-sm text-muted-foreground">
                    Push is not set up, so nothing is sent yet. Add the APNs key under{" "}
                    <Link to="/settings/voice" className="underline">
                      Voice → Phone notifications
                    </Link>
                    .
                  </p>
                )}
                {devices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No devices. In the mobile app, open Settings → Notifications and turn on Server
                    Notifications.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {devices.map((device) => (
                      <DeviceRow
                        key={device.installationId}
                        device={device}
                        environmentId={environmentId}
                        onRemoved={list.refresh}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
