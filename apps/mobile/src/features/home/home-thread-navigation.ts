import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

export function useHomeThreadSelection() {
  const selectDetail = useSelectWorkspaceDetail();
  return (thread: EnvironmentThreadShell) =>
    selectDetail({
      name: "Thread",
      params: {
        environmentId: String(thread.environmentId),
        threadId: String(thread.id),
      },
    });
}
