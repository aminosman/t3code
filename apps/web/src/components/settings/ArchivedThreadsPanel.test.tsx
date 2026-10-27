import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
  useSettingsScope: () => ({ scope: { kind: "all", environmentIds: [] } }),
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
import { ArchivedThreadsPanel } from "./SettingsPanels";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function visibleTitles() {
  return renderer!.root
    .findAllByType("h3")
    .map((heading) => heading.findAllByType("span").at(-1)!.children.join(""));
}

function toggle(label: string) {
  return renderer!.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === label,
  );
}

it("expands and collapses archived children independently across environments", async () => {
  await act(() => {
    renderer = create(<ArchivedThreadsPanel />);
  });
  expect(visibleTitles()).toEqual(["Parent", "Parent"]);

  await act(() => toggle("Show 1 owned threads for Parent")[0]!.props.onClick());
  expect(visibleTitles()).toEqual(["Parent", "Child", "Parent"]);

  const childRow = renderer!.root.findAllByType(SettingsRow)[1]!;
  await act(async () => {
    childRow.findByType("button").props.onClick();
  });
  expect(state.unarchiveThread).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("first-environment"),
    threadId: ThreadId.make("child"),
  });
  expect(state.refresh).toHaveBeenCalledOnce();

  await act(() => toggle("Hide 1 owned threads for Parent")[0]!.props.onClick());
  expect(visibleTitles()).toEqual(["Parent", "Parent"]);
});
