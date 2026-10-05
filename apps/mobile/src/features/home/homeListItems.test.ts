import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  HOME_INITIAL_VISIBLE_THREADS,
  HOME_SHOW_MORE_STEP,
  nextGroupDisplayState,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "./homeListItems";
import type { HomeThreadGroup } from "./homeThreadList";
import { threadJumpTarget } from "../keyboard/threadKeyboardShortcuts";
import { makeThreadShellFixture } from "../../test-fixtures";

const environmentId = EnvironmentId.make("environment-1");

function makeProject(id: string, title: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function makeThread(id: string, projectId: ProjectId): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
}

function makeGroup(key: string, threadCount: number): HomeThreadGroup {
  const project = makeProject(key, key);
  const threads = Array.from({ length: threadCount }, (_, index) =>
    makeThread(`${key}-thread-${index}`, project.id),
  );
  return {
    key,
    title: key,
    representative: project,
    projects: [project],
    pendingTasks: [],
    threads,
    // All threads inside the recency window, so the baseline stays at the
    // initial page size and the pagination expectations below hold.
    recentThreads: threads,
    newThreadTarget: project,
  };
}

function itemTypes(items: ReadonlyArray<HomeListItem>): string[] {
  return items.map((item) => item.type);
}

function displayStates(
  entries: Record<string, HomeGroupDisplayState>,
): ReadonlyMap<string, HomeGroupDisplayState> {
  return new Map(Object.entries(entries));
}

describe("threadJumpTarget", () => {
  it("numbers only displayed threads across groups, skipping collapsed groups and pagination rows", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("collapsed", 3), makeGroup("alpha", 8), makeGroup("beta", 3)],
      displayStates: displayStates({ collapsed: { collapsed: true, visibleCount: 6 } }),
    });
    expect(threadJumpTarget(layout.items, "thread.jump.1")?.id).toBe("alpha-thread-0");
    expect(threadJumpTarget(layout.items, "thread.jump.7")?.id).toBe("beta-thread-0");
    expect(threadJumpTarget(layout.items, "thread.jump.9")?.id).toBe("beta-thread-2");
  });

  it("ignores missing positions and unrelated commands", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 1)],
      displayStates: displayStates({}),
    });
    expect(threadJumpTarget(layout.items, "thread.jump.2")).toBeNull();
    expect(threadJumpTarget([], "thread.jump.1")).toBeNull();
    expect(threadJumpTarget(layout.items, "commandPalette")).toBeNull();
  });
});

describe("buildHomeListLayout", () => {
  it("renders a header plus all threads for a small group without a show-more row", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 3)],
      displayStates: displayStates({}),
    });

    expect(itemTypes(layout.items)).toEqual(["header", "thread", "thread", "thread"]);
    expect(layout.stickyHeaderIndices).toEqual([0]);
    expect(layout.items.at(-1)).toMatchObject({ type: "thread", isLast: true });
  });

  it("limits large groups to the initial visible count with a show-more row", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 133)],
      displayStates: displayStates({}),
    });

    const threadItems = layout.items.filter((item) => item.type === "thread");
    expect(threadItems).toHaveLength(HOME_INITIAL_VISIBLE_THREADS);
    expect(layout.items.at(-1)).toMatchObject({
      type: "show-more",
      groupKey: "alpha",
      hiddenCount: 133 - HOME_INITIAL_VISIBLE_THREADS,
      canShowLess: false,
    });
    // The show-more row takes over the last slot, so no thread is marked last.
    expect(threadItems.every((item) => item.type === "thread" && !item.isLast)).toBe(true);
  });

  it("reveals more threads per show-more step and offers show-less when exhausted", () => {
    const group = makeGroup("alpha", 20);

    const expandedOnce = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
      }),
    });
    expect(expandedOnce.items.filter((item) => item.type === "thread")).toHaveLength(
      HOME_INITIAL_VISIBLE_THREADS + HOME_SHOW_MORE_STEP,
    );
    expect(expandedOnce.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 4,
      canShowLess: true,
    });

    const fullyExpanded = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(
          nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
          "show-more",
        ),
      }),
    });
    expect(fullyExpanded.items.filter((item) => item.type === "thread")).toHaveLength(20);
    expect(fullyExpanded.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 0,
      canShowLess: true,
    });

    const reset = nextGroupDisplayState(
      nextGroupDisplayState(
        nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
        "show-more",
      ),
      "show-less",
    );
    expect(reset.visibleCount).toBe(HOME_INITIAL_VISIBLE_THREADS);
  });

  it("offers show-less after expanding a stale group whose baseline is below the page size", () => {
    // Stale project: 10 threads total but only 3 within the recency window.
    const project = makeProject("stale", "stale");
    const threads = Array.from({ length: 10 }, (_, index) =>
      makeThread(`stale-thread-${index}`, project.id),
    );
    const group: HomeThreadGroup = {
      key: "stale",
      title: "stale",
      representative: project,
      projects: [project],
      pendingTasks: [],
      threads,
      recentThreads: threads.slice(0, 3),
      newThreadTarget: project,
    };

    const collapsedToRecent = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({}),
    });
    expect(collapsedToRecent.items.filter((item) => item.type === "thread")).toHaveLength(3);
    expect(collapsedToRecent.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 7,
      canShowLess: false,
    });

    const expanded = buildHomeListLayout({
      groups: [group],
      displayStates: displayStates({
        stale: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more"),
      }),
    });
    expect(expanded.items.filter((item) => item.type === "thread")).toHaveLength(10);
    expect(expanded.items.at(-1)).toMatchObject({
      type: "show-more",
      hiddenCount: 0,
      canShowLess: true,
    });
  });

  it("hides threads and the show-more row for collapsed groups", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 12), makeGroup("beta", 2)],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "toggle-collapsed"),
      }),
    });

    expect(itemTypes(layout.items)).toEqual(["header", "header", "thread", "thread"]);
    expect(layout.items[0]).toMatchObject({ type: "header", collapsed: true, isFirst: true });
    expect(layout.items[1]).toMatchObject({ type: "header", collapsed: false, isFirst: false });
    expect(layout.stickyHeaderIndices).toEqual([0, 1]);
  });

  it("suspends collapse and pagination while searching", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 12)],
      displayStates: displayStates({
        alpha: nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "toggle-collapsed"),
      }),
      showAllThreads: true,
    });

    expect(layout.items.filter((item) => item.type === "thread")).toHaveLength(12);
    expect(layout.items.some((item) => item.type === "show-more")).toBe(false);
  });

  it("keeps sticky indices aligned across multiple expanded groups", () => {
    const layout = buildHomeListLayout({
      groups: [makeGroup("alpha", 8), makeGroup("beta", 1)],
      displayStates: displayStates({}),
    });

    // header + 6 threads + show-more = 8 items, so beta's header is index 8.
    expect(layout.stickyHeaderIndices).toEqual([0, 8]);
    expect(layout.items[8]).toMatchObject({ type: "header", isFirst: false });
  });
});

describe("owned threads in the grouped list", () => {
  // Roost: a thread another thread owns sits under it; paging counts the top.
  function ownedGroup(): HomeThreadGroup {
    const group = makeGroup("alpha", 8);
    const owner = group.threads[0]!;
    const own = (thread: EnvironmentThreadShell, status?: "running"): EnvironmentThreadShell => ({
      ...thread,
      lineage: {
        parentThreadId: owner.id,
        relationshipToParent: "subagent",
        rootThreadId: owner.id,
      },
      ...(status
        ? { runtime: { ...thread.runtime, status } as EnvironmentThreadShell["runtime"] }
        : {}),
    });
    const threads = [
      owner,
      own(group.threads[1]!),
      own(group.threads[2]!),
      ...group.threads.slice(3),
    ];
    return { ...group, threads, recentThreads: threads };
  }
  const rows = (items: ReadonlyArray<HomeListItem>) =>
    items.flatMap((item) =>
      item.type === "thread"
        ? [
            `${"  ".repeat(item.ownedDepth)}${item.thread.id}${item.ownedChildCount ? ` (${item.ownedChildCount}${item.ownedExpanded ? "" : ", closed"})` : ""}`,
          ]
        : [],
    );

  it("folds owned threads under their owner, closed, and pages only the top", () => {
    const layout = buildHomeListLayout({ groups: [ownedGroup()], displayStates: new Map() });
    expect(rows(layout.items)).toEqual([
      "alpha-thread-0 (2, closed)",
      "alpha-thread-3",
      "alpha-thread-4",
      "alpha-thread-5",
      "alpha-thread-6",
      "alpha-thread-7",
    ]);
    expect(itemTypes(layout.items).includes("show-more")).toBe(false);
  });

  it("opens an owner the user opened", () => {
    const group = ownedGroup();
    const layout = buildHomeListLayout({
      groups: [group],
      displayStates: new Map(),
      ownedExpandedByThreadId: { [group.threads[0]!.id]: true },
    });
    expect(rows(layout.items).slice(0, 4)).toEqual([
      "alpha-thread-0 (2)",
      "  alpha-thread-1",
      "  alpha-thread-2",
      "alpha-thread-3",
    ]);
  });
});
