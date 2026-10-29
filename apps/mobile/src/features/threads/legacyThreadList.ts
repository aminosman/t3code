import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import {
  DEFAULT_GROUP_DISPLAY_STATE,
  HOME_INITIAL_VISIBLE_THREADS,
  type HomeGroupDisplayState,
} from "../home/homeListItems";
import {
  sortHomeProjectScopes,
  type HomeProjectScope,
  type HomeProjectSortOrder,
} from "../home/homeThreadList";
import {
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
  type ThreadListV2PendingListItem,
  type ThreadListV2ThreadListItem,
} from "./threadListV2";

export interface LegacyGroupListItem {
  readonly type: "legacy-group";
  readonly key: string;
  readonly groupKey: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  /** A group of one project takes a quick new thread; a repository spanning machines has no single target. */
  readonly newThreadTarget: EnvironmentProject | null;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
}

export interface LegacyShowMoreListItem {
  readonly type: "legacy-show-more";
  readonly key: string;
  readonly groupKey: string;
  readonly hiddenCount: number;
  readonly canShowLess: boolean;
}

export type LegacyListItem = ThreadListV2ListItem | LegacyGroupListItem | LegacyShowMoreListItem;

type LegacyRow = ThreadListV2ThreadListItem | ThreadListV2PendingListItem;

/**
 * The grouped list regroups the current list's rows under project headers. A block is a top-level
 * row with the owned threads drawn under it, which stay with their owner even across projects.
 * Rows whose project is not loaded yet trail the groups rather than disappearing.
 */
export function buildLegacyThreadList(input: {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  /** Paging per group; whether a group is collapsed is saved on the device instead. */
  readonly displayStateByGroupKey: Readonly<Record<string, HomeGroupDisplayState>>;
  readonly collapsedGroupKeys: ReadonlySet<string>;
  readonly searching: boolean;
  readonly projectSortOrder: HomeProjectSortOrder;
}): LegacyListItem[] {
  const scopeByProjectKey = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (ref) => [scopedProjectKey(ref.environmentId, ref.projectId), scope] as const,
      ),
    ),
  );
  const blocksByScopeKey = new Map<string, LegacyRow[][]>();
  const unscopedBlocks: LegacyRow[][] = [];
  let ownerBlock: LegacyRow[] | null = null;
  for (const item of input.items) {
    if (item.type !== "v2-thread" && item.type !== "v2-pending") continue;
    if (item.type === "v2-thread" && (item.item.ownedDepth ?? 0) > 0 && ownerBlock !== null) {
      ownerBlock.push(item);
      continue;
    }
    const entity = item.type === "v2-thread" ? item.item.thread : item.pendingTask;
    const scope = scopeByProjectKey.get(scopedProjectKey(entity.environmentId, entity.projectId));
    const block: LegacyRow[] = [item];
    if (scope === undefined) {
      unscopedBlocks.push(block);
    } else {
      const blocks = blocksByScopeKey.get(scope.key);
      if (blocks === undefined) blocksByScopeKey.set(scope.key, [block]);
      else blocks.push(block);
    }
    ownerBlock = item.type === "v2-thread" ? block : null;
  }

  // The current list blanks the time where its status says more; the grouped row shows the time.
  const rows = (blocks: ReadonlyArray<LegacyRow>) =>
    blocks.map((row, index): LegacyRow => ({
      ...row,
      showTrailingDivider: index < blocks.length - 1,
      ...(row.type === "v2-thread" && row.timeLabel === ""
        ? {
            timeLabel: relativeTime(
              row.item.thread.latestUserMessageAt ??
                row.item.thread.updatedAt ??
                row.item.thread.createdAt,
            ),
          }
        : {}),
    }));
  const listedRows = [...blocksByScopeKey.values()].flat(2);
  const sortedScopes = sortHomeProjectScopes({
    scopes: input.scopes.filter((scope) => blocksByScopeKey.has(scope.key)),
    threads: listedRows.flatMap((row) => (row.type === "v2-thread" ? [row.item.thread] : [])),
    pendingTasks: listedRows.flatMap((row) => (row.type === "v2-pending" ? [row.pendingTask] : [])),
    projectSortOrder: input.projectSortOrder,
  });
  const items: LegacyListItem[] = [];
  for (const scope of sortedScopes) {
    const blocks = blocksByScopeKey.get(scope.key) ?? [];
    const display = input.displayStateByGroupKey[scope.key] ?? DEFAULT_GROUP_DISPLAY_STATE;
    const collapsed = !input.searching && input.collapsedGroupKeys.has(scope.key);
    const visibleCount = input.searching ? blocks.length : display.visibleCount;
    items.push({
      type: "legacy-group",
      key: `legacy-group:${scope.key}`,
      groupKey: scope.key,
      title: scope.title,
      representative: scope.representative,
      newThreadTarget: scope.projects.length === 1 ? scope.representative : null,
      threadCount: blocks.reduce((count, block) => count + block.length, 0),
      collapsed,
      isFirst: items.length === 0,
    });
    if (collapsed) continue;
    items.push(...rows(blocks.slice(0, visibleCount).flat()));
    const hiddenCount = Math.max(0, blocks.length - visibleCount);
    const canShowLess =
      !input.searching &&
      visibleCount > HOME_INITIAL_VISIBLE_THREADS &&
      blocks.length > HOME_INITIAL_VISIBLE_THREADS;
    if (hiddenCount > 0 || canShowLess) {
      items.push({
        type: "legacy-show-more",
        key: `legacy-show-more:${scope.key}`,
        groupKey: scope.key,
        hiddenCount,
        canShowLess,
      });
    }
  }
  items.push(...rows(unscopedBlocks.flat()));
  return items;
}

/** The saved collapsed groups after the user opens or closes one. */
export function toggleCollapsedGroup(
  collapsedGroupKeys: ReadonlyArray<string> | undefined,
  groupKey: string,
): string[] {
  const keys = collapsedGroupKeys ?? [];
  return keys.includes(groupKey) ? keys.filter((key) => key !== groupKey) : [...keys, groupKey];
}

export function legacyListItemsAreEqual(previous: LegacyListItem, item: LegacyListItem): boolean {
  if (previous.type === "legacy-group" && item.type === "legacy-group") {
    return (
      previous.key === item.key &&
      previous.title === item.title &&
      previous.representative === item.representative &&
      previous.newThreadTarget === item.newThreadTarget &&
      previous.threadCount === item.threadCount &&
      previous.collapsed === item.collapsed &&
      previous.isFirst === item.isFirst
    );
  }
  if (previous.type === "legacy-show-more" && item.type === "legacy-show-more") {
    return (
      previous.key === item.key &&
      previous.hiddenCount === item.hiddenCount &&
      previous.canShowLess === item.canShowLess
    );
  }
  if (
    previous.type === "legacy-group" ||
    previous.type === "legacy-show-more" ||
    item.type === "legacy-group" ||
    item.type === "legacy-show-more"
  ) {
    return false;
  }
  return threadListV2ListItemsAreEqual(previous, item);
}
