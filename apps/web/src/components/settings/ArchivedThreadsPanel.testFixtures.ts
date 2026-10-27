import type { OrchestrationProjectShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";

import { makeThreadProjectionFixture } from "../../test-fixtures";

const projection = makeThreadProjectionFixture();
export const archivedThreadFixture: OrchestrationV2ThreadShell = {
  ...projection.thread,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
};
export const archiveProjectFixture: OrchestrationProjectShell = {
  id: archivedThreadFixture.projectId,
  title: "Project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
