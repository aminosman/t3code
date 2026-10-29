import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { ComponentProps, ReactNode } from "react";
import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

import {
  archiveProjectFixture as v2Project,
  archivedThreadFixture as v2ThreadShell,
} from "./ArchivedThreadsPanel.testFixtures";

const state = vi.hoisted(() => ({
  snapshots: [] as ArchivedSnapshotEntry[],
  unarchiveThread: vi.fn().mockResolvedValue({ _tag: "Success" }),
  refresh: vi.fn(),
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: state.snapshots,
    error: null,
    isLoading: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    unarchiveThread: state.unarchiveThread,
    confirmAndDeleteThread: vi.fn(),
  }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    groups: [],
    environments: [],
  }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
// Keep settings providers out of this archive interaction test.
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ title, description, control, ...props }: ComponentProps<typeof SettingsRow>) => (
    <div {...props}>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  ),
}));

import { SettingsRow } from "./settingsLayout";
import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

it("expands owned archived threads independently across environments", async () => {
  vi.clearAllMocks();
  state.snapshots = ["first-environment", "second-environment"].map((id) => ({
    environmentId: EnvironmentId.make(id),
    snapshot: {
      schemaVersion: 1,
      snapshotSequence: 1,
      projects: [v2Project],
      threads: [
        {
          ...v2ThreadShell,
          id: ThreadId.make("parent"),
          title: "Parent",
          archivedAt: v2ThreadShell.createdAt,
        },
        {
          ...v2ThreadShell,
          id: ThreadId.make("child"),
          title: "Child",
          archivedAt: v2ThreadShell.createdAt,
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      ],
    },
  }));
  await using screen = await render(<ArchivedThreadsPanel />);
  const toggles = screen.getByRole("button", { name: "Show 1 owned threads for Parent" });
  await toggles.nth(0).click();
  await expect.element(screen.getByRole("heading", { name: "Child" })).toBeVisible();
  await screen.getByRole("button", { name: "Unarchive" }).nth(1).click();
  expect(state.unarchiveThread).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("first-environment"),
    threadId: ThreadId.make("child"),
  });
  expect(state.refresh).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "Hide 1 owned threads for Parent" }).click();
  await expect.element(screen.getByRole("heading", { name: "Child" })).not.toBeInTheDocument();
});
