import { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";

/** The environment last talked to, so tui is reached on the same Mac. */
let lastEnvironmentId: string | null = null;

/**
 * The Mac tui is reached through from home: the one talked to last if it is
 * still saved, else the first connected one, else any saved one.
 */
export function useTuiEnvironment(): {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
} {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { environments } = useWorkspaceState();
  const pick = useMemo(() => {
    const state = new Map(environments.map((env) => [env.environmentId, env.connectionState]));
    const saved = Object.values(savedConnectionsById)
      .map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connected: state.get(connection.environmentId) === "connected",
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return (
      saved.find((env) => env.environmentId === lastEnvironmentId) ??
      saved.find((env) => env.connected) ??
      saved[0] ??
      null
    );
  }, [environments, savedConnectionsById]);

  useEffect(() => {
    if (pick) lastEnvironmentId = pick.environmentId;
  }, [pick]);

  return {
    environmentId: pick ? EnvironmentId.make(pick.environmentId) : null,
    connected: pick?.connected ?? false,
  };
}
