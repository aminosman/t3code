import { createFileRoute } from "@tanstack/react-router";

import { DevicesSettingsPanel } from "../components/settings/DevicesSettingsPanel";

function SettingsDevicesRoute() {
  return <DevicesSettingsPanel />;
}

export const Route = createFileRoute("/settings/devices")({
  component: SettingsDevicesRoute,
});
