import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GUTTER, SERIF, SPACE } from "../../design/granola";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadShells } from "../../state/entities";
import { ownedThreadRows } from "./owned-thread-rows";
import {
  activityAt,
  shelfCardState,
  shelfStatusLine,
  shortAgo,
  type ShelfCardState,
} from "./shelves";

type OwnedThreadsSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const DOT: Record<ShelfCardState, string> = {
  "needs-approval": "bg-gr-attention",
  "needs-input": "bg-gr-attention",
  "plan-ready": "bg-gr-attention",
  working: "bg-gr-accent",
  connecting: "bg-gr-accent",
  completed: "bg-gr-accent",
  waiting: "bg-gr-ink-2",
  error: "bg-gr-danger",
  limited: "bg-gr-danger",
  stopped: "bg-gr-ink-3",
  done: "bg-gr-ink-3",
  new: "bg-gr-ink-3",
};

/**
 * The agents a thread started, opened from its card on Home: each with its
 * status and how long ago, nested as they started one another. Tap one to
 * open it.
 */
export function OwnedThreadsSheet({ route }: OwnedThreadsSheetProps) {
  const { environmentId, threadId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const threads = useThreadShells();
  const owner = threads.find(
    (thread) => thread.environmentId === environmentId && thread.id === threadId,
  );
  const rows = useMemo(
    () => ownedThreadRows(threads, environmentId, threadId),
    [environmentId, threadId, threads],
  );
  const now = Date.now();

  const open = (thread: EnvironmentThreadShell) => {
    navigation.goBack();
    navigation.navigate("Thread", {
      environmentId: thread.environmentId,
      threadId: thread.id,
    } as never);
  };

  return (
    // A form sheet needs a real (uncollapsed) root view to lay its content in.
    <View collapsable={false} className="flex-1 bg-gr-surface">
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: SPACE.xl,
          paddingBottom: insets.bottom + SPACE.xl,
        }}
      >
        <View style={{ paddingHorizontal: GUTTER, gap: SPACE.xs, paddingBottom: SPACE.md }}>
          <Text className="text-[13px] text-gr-ink-2">
            {rows.length} {rows.length === 1 ? "agent" : "agents"}
          </Text>
          <Text
            className="text-[22px] leading-[28px] text-gr-ink"
            style={{ fontFamily: SERIF }}
            numberOfLines={2}
          >
            {owner?.title ?? "Thread"}
          </Text>
          {owner ? (
            <Pressable onPress={() => open(owner)} hitSlop={8} className="self-start pt-1">
              <Text className="text-[13px] text-gr-accent">Open this thread</Text>
            </Pressable>
          ) : null}
        </View>
        {rows.length === 0 ? (
          <Text className="text-[14px] text-gr-ink-3" style={{ paddingHorizontal: GUTTER }}>
            No agents under this thread right now.
          </Text>
        ) : null}
        {rows.map(({ thread, depth }) => {
          const state = shelfCardState(thread);
          // Agents a provider started run inside their owner's turn and keep no
          // turns of their own, so "Not started" would be wrong: say when they
          // were last active instead.
          const lastActive = shortAgo(thread.updatedAt, now);
          const line =
            state === "new"
              ? `Last active · ${lastActive === "now" ? "just now" : `${lastActive} ago`}`
              : shelfStatusLine(
                  {
                    thread,
                    state,
                    agentCount: 0,
                    agentsWorking: 0,
                    activityAt: activityAt(thread),
                  },
                  now,
                );
          return (
            <Pressable
              key={`${thread.environmentId}:${thread.id}`}
              accessibilityRole="button"
              onPress={() => open(thread)}
              className="flex-row items-center gap-3 active:bg-gr-hover"
              style={{
                paddingLeft: GUTTER + depth * 18,
                paddingRight: GUTTER,
                paddingVertical: SPACE.sm + 2,
              }}
            >
              <View className={`size-2 rounded-full ${DOT[state]}`} />
              <View className="flex-1">
                <Text className="text-[15px] leading-[20px] text-gr-ink" numberOfLines={2}>
                  {thread.title}
                </Text>
                <Text className="text-[12px] text-gr-ink-2">{line}</Text>
              </View>
              <SymbolView name="chevron.right" size={12} tintColorClassName="accent-gr-ink-3" />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
