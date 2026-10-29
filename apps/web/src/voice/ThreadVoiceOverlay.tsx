import {
  deriveLatestThreadRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ComponentProps } from "react";

import { useThreadProjection, useThreadShell } from "~/state/entities";
import { VoiceOverlay } from "./VoiceOverlay";
import { voiceOracleThreadView } from "./voiceOracle";

// Subscribe to streaming text only while voice is open, outside the quiet chat view.
export function ThreadVoiceOverlay({
  threadRef,
  threadTitle,
  projectName,
  ...props
}: Omit<ComponentProps<typeof VoiceOverlay>, "view"> & {
  threadRef: ScopedThreadRef | null;
  threadTitle: string;
  projectName: string | null;
}) {
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const shell = useThreadShell(threadRef);
  return (
    <VoiceOverlay
      {...props}
      view={voiceOracleThreadView({
        threadTitle,
        projectName,
        projection,
        shell: projection
          ? {
              runtime: deriveThreadRuntime(projection),
              latestRun: deriveLatestThreadRun(projection),
            }
          : shell,
      })}
    />
  );
}
