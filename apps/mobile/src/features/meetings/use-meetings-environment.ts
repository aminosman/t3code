import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useServerConfigs } from "../../state/entities";
import { useTuiEnvironment } from "../home/use-tui-environment";

/**
 * The Mac whose Roost records meetings (it reports a meetings folder),
 * preferring the one tui is reached through. Null when none does.
 */
export function useMeetingsEnvironment(): EnvironmentId | null {
  const configs = useServerConfigs();
  const { environmentId: tuiEnvironmentId } = useTuiEnvironment();
  return useMemo(() => {
    const offering = [...configs.entries()]
      .filter(([, config]) => Boolean(config.meetingsWorkspaceRoot))
      .map(([environmentId]) => environmentId);
    return offering.find((id) => id === tuiEnvironmentId) ?? offering[0] ?? null;
  }, [configs, tuiEnvironmentId]);
}
