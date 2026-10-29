import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import { memo, useState, type ComponentProps } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  DEFAULT_GROUP_DISPLAY_STATE,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
} from "../home/homeListItems";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  buildLegacyThreadList,
  toggleCollapsedGroup,
  type LegacyGroupListItem,
  type LegacyListItem,
  type LegacyShowMoreListItem,
} from "./legacyThreadList";
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListShowMoreRow,
} from "./thread-list-items";
import type { ThreadListV2PendingRow, ThreadListV2Row } from "./thread-list-v2-items";
import type { ThreadListV2ListItem } from "./threadListV2";
import { groupedThreadSortOrder, useThreadSortOrder } from "./use-thread-sort-order";

/** The current list's rows, regrouped under project headers when the device chose the grouped list. */
export function useLegacyThreadList(input: {
  readonly enabled: boolean;
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly searchQuery: string;
}): {
  readonly items: ReadonlyArray<LegacyListItem>;
  readonly onGroupAction: (groupKey: string, action: HomeGroupDisplayAction) => void;
} {
  const [displayStateByGroupKey, setDisplayStateByGroupKey] = useState<
    Readonly<Record<string, HomeGroupDisplayState>>
  >({});
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [threadSortOrder] = useThreadSortOrder();
  const collapsedGroupKeys = AsyncResult.isSuccess(preferences)
    ? preferences.value.collapsedProjectGroups
    : undefined;
  const onGroupAction = (groupKey: string, action: HomeGroupDisplayAction) => {
    if (action === "toggle-collapsed") {
      savePreferences({
        transform: (current) => ({
          collapsedProjectGroups: toggleCollapsedGroup(current.collapsedProjectGroups, groupKey),
        }),
      });
      return;
    }
    setDisplayStateByGroupKey((current) => ({
      ...current,
      [groupKey]: nextGroupDisplayState(current[groupKey] ?? DEFAULT_GROUP_DISPLAY_STATE, action),
    }));
  };
  return {
    items: input.enabled
      ? buildLegacyThreadList({
          items: input.items,
          scopes: input.scopes,
          displayStateByGroupKey,
          collapsedGroupKeys: new Set(collapsedGroupKeys),
          searching: input.searchQuery.trim().length > 0,
          projectSortOrder: groupedThreadSortOrder(threadSortOrder),
        })
      : input.items,
    onGroupAction,
  };
}

/** The grouped list's thread row, fed the current row's props. */
export const LegacyThreadRow = memo(function LegacyThreadRow(
  props: ComponentProps<typeof ThreadListV2Row>,
) {
  return (
    <ThreadListRow
      variant={props.pane === "sidebar" ? "sidebar" : "compact"}
      thread={props.thread}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      hasQueuedMessages={props.hasQueuedMessages}
      searchMatch={props.searchMatch}
      searchQuery={props.searchQuery}
      isLast={props.showTrailingDivider !== true}
      timeLabel={props.timeLabel}
      selected={props.selected}
      fullSwipeWidth={props.fullSwipeWidth}
      onSelectThread={props.onSelectThread}
      onOpenThreadPullRequests={props.onOpenThreadPullRequests}
      onArchiveThread={props.onArchiveThread}
      onDeleteThread={props.onDeleteThread}
      onNewThreadOnBranch={props.onNewThreadOnBranch}
      onRenameThread={props.onRenameThread}
      onRegenerateThreadTitle={props.onRegenerateThreadTitle}
      titleRegenerationSupported={props.titleRegenerationSupported}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      onSwipeableClose={props.onSwipeableClose}
      simultaneousSwipeGesture={props.simultaneousSwipeGesture}
      activationKey={props.activationKey}
      ownedDepth={props.ownedDepth}
      ownedChildCount={props.ownedChildCount}
      ownedExpanded={props.ownedExpanded}
      onToggleOwnedThreads={props.onToggleOwnedThreads}
    />
  );
});

/** The grouped list's unsent-work row, fed the current row's props. */
export const LegacyPendingRow = memo(function LegacyPendingRow(
  props: ComponentProps<typeof ThreadListV2PendingRow>,
) {
  return (
    <PendingTaskListRow
      variant={props.pane === "sidebar" ? "sidebar" : "compact"}
      pendingTask={props.pendingTask}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      isLast={props.showTrailingDivider !== true}
      selected={props.selected}
      onSelectPendingTask={props.onSelectPendingTask}
      onDeletePendingTask={props.onDeletePendingTask}
    />
  );
});

export function LegacyListDecoration(props: {
  readonly item: LegacyGroupListItem | LegacyShowMoreListItem;
  readonly pane: "screen" | "sidebar";
  readonly onGroupAction: (groupKey: string, action: HomeGroupDisplayAction) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const { item } = props;
  const variant = props.pane === "sidebar" ? "sidebar" : "compact";
  if (item.type === "legacy-show-more") {
    return (
      <ThreadListShowMoreRow
        variant={variant}
        hiddenCount={item.hiddenCount}
        canShowLess={item.canShowLess}
        groupKey={item.groupKey}
        onGroupAction={props.onGroupAction}
      />
    );
  }
  return (
    <ThreadListGroupHeader
      variant={variant}
      project={item.representative}
      title={item.title}
      threadCount={item.threadCount}
      collapsed={item.collapsed}
      isFirst={item.isFirst}
      groupKey={item.groupKey}
      onGroupAction={props.onGroupAction}
      newThreadTarget={item.newThreadTarget}
      onNewThread={props.onNewThread}
    />
  );
}
