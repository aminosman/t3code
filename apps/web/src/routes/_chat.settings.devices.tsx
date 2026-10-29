import { createFileRoute } from "@tanstack/react-router";
import { DevicesSettingsPanel } from "../components/settings/IntegrationsSettings";

import { DevicesSettingsPanel as PushDevicesSettingsPanel } from "../components/settings/DevicesSettingsPanel";

export const Route = createFileRoute("/_chat/settings/devices")({
  component: () => (
    <>
      <DevicesSettingsPanel />
      <PushDevicesSettingsPanel />
    </>
  ),
});
