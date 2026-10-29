import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { nextGroupDisplayState, DEFAULT_GROUP_DISPLAY_STATE } from "../home/homeListItems";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  buildLegacyThreadList,
  toggleCollapsedGroup,
  type LegacyListItem,
} from "./legacyThreadList";
import type { ThreadListV2ListItem } from "./threadListV2";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

function project(environmentId: EnvironmentId, id: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as EnvironmentProject;
}

function scope(key: string, projects: EnvironmentProject[]): HomeProjectScope {
  return {
    key,
    title: key,
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((p) => ({ environmentId: p.environmentId, projectId: p.id })),
  };
}

function row(
  id: string,
  owner: EnvironmentProject,
  input: {
    readonly updatedAt?: string;
    readonly ownedDepth?: number;
    readonly timeLabel?: string;
  } = {},
): ThreadListV2ListItem {
  const thread: EnvironmentThreadShell = makeThreadShellFixture({
    environmentId: owner.environmentId,
    projectId: owner.id,
    id: ThreadId.make(id),
    title: id,
    updatedAt: input.updatedAt ?? "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
  });
  return {
    type: "v2-thread",
    key: id,
    item: {
      thread,
      ownedDepth: input.ownedDepth,
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: null,
      isLast: false,
    },
    snoozeWakeLabelText: undefined,
    timeLabel: input.timeLabel ?? "1m",
    snoozePresetMinute: undefined,
    showTrailingDivider: true,
    hasQueuedMessages: false,
    canMoveUp: false,
    canMoveDown: false,
  };
}

function shape(items: ReadonlyArray<LegacyListItem>) {
  return items.map((item) => {
    switch (item.type) {
      case "legacy-group":
        return `# ${item.title} (${item.threadCount})${item.collapsed ? " collapsed" : ""}${item.newThreadTarget ? " +" : ""}`;
      case "legacy-show-more":
        return `more ${item.hiddenCount}${item.canShowLess ? " less" : ""}`;
      case "v2-thread":
        return `${item.key}${item.showTrailingDivider ? "" : " ."}`;
      default:
        return item.type;
    }
  });
}

const web = project(local, "web");
const repoLocal = project(local, "repo");
const repoRemote = project(remote, "repo");
const scopes = [scope("web", [web]), scope("repo", [repoLocal, repoRemote])];

describe("buildLegacyThreadList", () => {
  it("groups rows under project headers, newest group first, with owned threads kept under their owner", () => {
    const items = buildLegacyThreadList({
      items: [
        row("web-1", web),
        row("repo-local", repoLocal, { updatedAt: "2026-10-05T00:00:00.000Z" }),
        // Owned threads follow their owner even when started in another project.
        row("owned-in-web", web, { ownedDepth: 1 }),
        row("repo-remote", repoRemote),
        row("orphan", project(local, "not-loaded")),
      ],
      scopes,
      displayStateByGroupKey: {},
      collapsedGroupKeys: new Set(),
      searching: false,
      projectSortOrder: "updated_at",
    });
    expect(shape(items)).toEqual([
      "# repo (3)",
      "repo-local",
      "owned-in-web",
      "repo-remote .",
      "# web (1) +",
      "web-1 .",
      "orphan .",
    ]);
  });

  it("collapses and pages each group by top-level rows, and a search lists every match", () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(`web-${index}`, web));
    const shown = nextGroupDisplayState(DEFAULT_GROUP_DISPLAY_STATE, "show-more");
    const build = (state: typeof shown, searching = false, collapsed: string[] = []) =>
      shape(
        buildLegacyThreadList({
          items: rows,
          scopes,
          displayStateByGroupKey: { web: state },
          collapsedGroupKeys: new Set(collapsed),
          searching,
          projectSortOrder: "updated_at",
        }),
      );
    expect(build(DEFAULT_GROUP_DISPLAY_STATE)).toEqual([
      "# web (8) +",
      ...rows.slice(0, 5).map((item) => item.key),
      "web-5 .",
      "more 2",
    ]);
    expect(build(shown).at(-1)).toBe("more 0 less");
    const saved = toggleCollapsedGroup(["repo"], "web");
    expect(saved).toEqual(["repo", "web"]);
    expect(build(shown, false, saved)).toEqual(["# web (8) collapsed +"]);
    expect(build(shown, true, saved)).toHaveLength(9);
    expect(toggleCollapsedGroup(saved, "web")).toEqual(["repo"]);
  });

  it("shows the thread's time where the current list leaves it blank for a status", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T03:00:00.000Z"));
    const items = buildLegacyThreadList({
      items: [row("running", web, { timeLabel: "" }), row("ready", web, { timeLabel: "5m" })],
      scopes,
      displayStateByGroupKey: {},
      collapsedGroupKeys: new Set(),
      searching: false,
      projectSortOrder: "updated_at",
    });
    expect(items.flatMap((item) => (item.type === "v2-thread" ? [item.timeLabel] : []))).toEqual([
      "3h",
      "5m",
    ]);
  });
});
