import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useAtomSet } from "@effect/atom-react";
import { useProjects, useThreadShells } from "../../state/entities";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { groupedThreadSortOrder, useThreadSortOrder } from "../threads/use-thread-sort-order";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { GrPage, GrSurfaceScope } from "../../design/granola";
import { ChatsPaneHeader } from "./ChatsPaneHeader";
import { useHomeListOptions } from "./home-list-options";
import { useHomeThreadSelection } from "./home-thread-navigation";
import { buildHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";

/**
 * Chats: every thread, grouped by project. On a phone it is the right-hand
 * page of the home pager (`embedded`), with its own header; in split layouts
 * it is Home's empty detail pane beside the sidebar.
 */
export function ChatsRouteScreen(props: { readonly embedded?: boolean } = {}) {
  const { width: windowWidth } = useWindowDimensions();
  const { layout, panes } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  // Every thread, owned ones included: both layouts nest them under their
  // owner, as the desktop sidebar does.
  const allThreads = useThreadShells();
  const threads = useMemo(
    () => allThreads.filter((thread) => thread.archivedAt === null),
    [allThreads],
  );
  const [sortOrder, setSortOrder] = useThreadSortOrder();
  const groupedSort = groupedThreadSortOrder(sortOrder);
  const flatLayout = useThreadListV2Enabled();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const handleSelectThread = useHomeThreadSelection();
  const handleNewThreadOnBranch = useCallback(
    (thread: EnvironmentThreadShell) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(thread.environmentId),
          projectId: String(thread.projectId),
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      });
    },
    [navigation],
  );

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    unsettleThread,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(() => {
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById).map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionState:
          connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
      })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [savedConnectionsById, workspaceEnvironments]);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options: listOptions, setSelectedEnvironmentId } =
    useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : { title: "", headerTitle: "", unstable_headerLeftItems: () => [] }
          }
        />
        {Platform.OS === "ios" ? (
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          </NativeHeaderToolbar>
        ) : null}
        {Platform.OS === "android" ? <AndroidScreenHeader title="Threads" /> : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections
              ? () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironmentNew" },
                  })
              : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible
              ? undefined
              : () => navigation.navigate("NewTaskSheet", { screen: "NewTask" })
          }
        />
      </>
    );
  }

  const renderList = () => (
    <HomeScreen
      catalogState={catalogState}
      environments={environments}
      onAddConnection={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsEnvironmentNew" },
        })
      }
      onArchiveThread={archiveThread}
      onDeleteThread={confirmDeleteThread}
      onSettleThread={settleThread}
      onSnoozeThread={snoozeThread}
      onUnsnoozeThread={unsnoozeThread}
      onUnsettleThread={unsettleThread}
      onPinThread={pinThread}
      onUnpinThread={unpinThread}
      onSetThreadAutoSettle={setThreadAutoSettle}
      onMoveThread={moveThread}
      onRenameThread={renameThread}
      onRegenerateThreadTitle={regenerateThreadTitle}
      onEnvironmentChange={setSelectedEnvironmentId}
      onProjectChange={setSelectedProjectKey}
      onOpenSettings={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "Settings" },
        })
      }
      onProjectSortOrderChange={setSortOrder}
      onSearchQueryChange={setSearchQuery}
      onSelectThread={handleSelectThread}
      onSelectPendingTask={openPendingTask}
      onDeletePendingTask={confirmDeletePendingTask}
      onNewThreadOnBranch={handleNewThreadOnBranch}
      onNewThreadInProject={(project) => {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        });
      }}
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
      onThreadSortOrderChange={setSortOrder}
      pendingTasks={pendingTasks}
      projectGroupingMode={listOptions.projectGroupingMode}
      projects={projects}
      projectSortOrder={groupedSort}
      savedConnectionsById={savedConnectionsById}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      selectedProjectKey={selectedProjectKey}
      threads={threads}
      v2SortOrder={sortOrder}
      threadSortOrder={groupedSort}
    />
  );

  const openSettings = () =>
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "Settings" },
    });
  const startNewTask = () => navigation.navigate("NewTaskSheet", { screen: "NewTask" });

  if (props.embedded) {
    return (
      <GrSurfaceScope>
        <GrPage
          header={
            <ChatsPaneHeader
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              onStartNewTask={startNewTask}
              onOpenSettings={openSettings}
              layout={flatLayout ? "recent" : "projects"}
              onLayoutChange={(layout) =>
                savePreferences({ legacyThreadListEnabled: layout === "projects" })
              }
              sortOrder={sortOrder}
              onSortOrderChange={setSortOrder}
            />
          }
        >
          {/* The list already leaves room at its foot for iOS's bottom toolbar,
              which the pager does not show; the capsule sits in that room. */}
          {renderList()}
        </GrPage>
      </GrSurfaceScope>
    );
  }

  return (
    <AndroidHomeFabLayout
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
    >
      <>
        {/* Restore the header after leaving split view; screen options are
            shallow-merged. The brand slot also doubles as the connection
            status surface while an environment reconnects. */}
        <NativeStackScreenOptions
          optionsVersion={windowWidth}
          options={{
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: windowWidth,
              onOpenEnvironments: () =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsEnvironments" },
                }),
            }),
            headerShown: true,
          }}
        />
        <HomeHeader
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          projectSortOrder={groupedSort}
          threadSortOrder={groupedSort}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironments" },
            })
          }
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          onProjectSortOrderChange={setSortOrder}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          onOpenTui={() => navigation.navigate("TuiInbox", undefined)}
          onThreadSortOrderChange={setSortOrder}
        />

        {renderList()}
      </>
    </AndroidHomeFabLayout>
  );
}
