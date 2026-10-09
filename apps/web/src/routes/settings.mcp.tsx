import { createFileRoute } from "@tanstack/react-router";

import { McpConnectionsSettingsPanel } from "../components/settings/McpConnectionsSettings";

export const Route = createFileRoute("/settings/mcp")({
  component: McpConnectionsSettingsPanel,
});
