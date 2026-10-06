import type { HistoryMeetingSummary } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useHomeThreadSelection } from "./home-thread-navigation";
import { HomeDock, SERIF_FONT } from "./HomeDock";
import { HomeTabs, type HomeTab } from "./HomeTabs";
import {
  buildShelves,
  shelfPreview,
  shelfStateLabel,
  shortAgo,
  type ShelfCard,
  type ShelfCardState,
} from "./shelves";
import { useTuiEnvironment } from "./use-tui-environment";

const CARD_WIDTH = 226;
const TILE_COLORS = ["#FBEFB8", "#E4E4DE", "#F8DDF0", "#D9ECF7", "#E2F0C9", "#F6E1CF"];

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function tileColor(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1)
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  return TILE_COLORS[Math.abs(hash) % TILE_COLORS.length]!;
}

const STATE_TEXT: Record<ShelfCardState, string> = {
  working: "text-adaptive-sky-600-400",
  connecting: "text-adaptive-sky-600-400",
  done: "text-foreground-tertiary",
  "needs-approval": "text-adaptive-amber-700-400",
  "needs-input": "text-adaptive-amber-700-400",
  "plan-ready": "text-adaptive-violet-600-400",
  error: "text-adaptive-red-700-300",
  stopped: "text-foreground-tertiary",
  new: "text-foreground-tertiary",
};

const STATE_DOT: Record<ShelfCardState, string> = {
  working: "bg-adaptive-sky-600-400",
  connecting: "bg-adaptive-sky-600-400",
  done: "bg-foreground-tertiary",
  "needs-approval": "bg-adaptive-amber-700-400",
  "needs-input": "bg-adaptive-amber-700-400",
  "plan-ready": "bg-adaptive-violet-600-400",
  error: "bg-adaptive-red-700-300",
  stopped: "bg-foreground-tertiary",
  new: "bg-foreground-tertiary",
};

/** Re-render once a minute so "4m" stays true. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function PulseDot(props: { readonly className: string; readonly pulse: boolean }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!props.pulse) {
      cancelAnimation(opacity);
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withTiming(0.25, { duration: 700, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(opacity);
  }, [opacity, props.pulse]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View className={`size-[7px] rounded-full ${props.className}`} style={style} />;
}

function ShelfCardView(props: {
  readonly card: ShelfCard;
  readonly projectTitle: string;
  readonly now: number;
  readonly onPress: () => void;
}) {
  const { card } = props;
  const done = card.state === "done";
  const preview = shelfPreview(card.thread);
  // Shells carry no message text today, so most cards say what is doing the work.
  const failure = card.state === "error" ? (card.thread.runtime?.lastError ?? null) : null;
  const detail =
    failure ??
    preview ??
    [formatModelSlugName(card.thread.modelSelection.model), card.thread.branch]
      .filter(Boolean)
      .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${card.thread.title}, ${props.projectTitle}, ${shelfStateLabel(card.state)}`}
      onPress={props.onPress}
      className={
        done
          ? "gap-1 overflow-hidden rounded-[18px] border border-border bg-subtle px-3 py-2.5"
          : "gap-1 overflow-hidden rounded-[18px] border border-border bg-card px-3 py-2.5"
      }
      style={{ width: CARD_WIDTH, height: 124 + (preview ? 14 : 0) }}
    >
      <View className="flex-row items-center gap-2">
        <View
          className="size-5 items-center justify-center rounded-md"
          style={{ backgroundColor: tileColor(props.projectTitle) }}
        >
          <Text className="text-3xs text-neutral-900" style={{ fontFamily: SERIF_FONT }}>
            {props.projectTitle.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <Text className="flex-1 text-3xs text-foreground-muted" numberOfLines={1}>
          {props.projectTitle}
        </Text>
        <Text className="text-3xs text-foreground-tertiary">
          {shortAgo(card.activityAt, props.now)}
        </Text>
      </View>
      <Text
        className={
          done
            ? "text-[15px] leading-[19px] text-foreground-secondary"
            : "text-[15.5px] leading-[19px]"
        }
        style={{ fontFamily: SERIF_FONT }}
        numberOfLines={2}
      >
        {card.thread.title}
      </Text>
      {detail ? (
        <Text
          className={
            failure ? "text-2xs text-adaptive-red-700-300" : "text-2xs text-foreground-muted"
          }
          numberOfLines={(preview || failure) && !done ? 2 : 1}
        >
          {detail}
        </Text>
      ) : null}
      <View className="mt-auto flex-row items-center justify-between">
        <View className="flex-row items-center gap-1.5">
          <PulseDot className={STATE_DOT[card.state]} pulse={card.state === "working"} />
          <Text className={`font-t3-medium text-3xs ${STATE_TEXT[card.state]}`}>
            {shelfStateLabel(card.state)}
          </Text>
        </View>
        {card.agentCount > 0 ? (
          <View className="flex-row items-center gap-1">
            <SymbolView name="sparkles" size={10} tintColorClassName="accent-icon-muted" />
            <Text className="text-3xs text-foreground-muted">
              {card.agentsWorking > 0
                ? `${card.agentsWorking} of ${card.agentCount} working`
                : `${card.agentCount} agent${card.agentCount === 1 ? "" : "s"}`}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function LiveMeetingCard(props: {
  readonly meeting: HistoryMeetingSummary;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.meeting.title}, being recorded`}
      onPress={props.onPress}
      className="gap-1 overflow-hidden rounded-[18px] border border-adaptive-red-200-800 bg-adaptive-red-50-950-a80 px-3 py-2.5"
      style={{ width: CARD_WIDTH, height: 124 }}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-3xs text-foreground-muted">Meeting</Text>
        <Text className="text-3xs text-foreground-tertiary">now</Text>
      </View>
      <Text
        className="text-[15.5px] leading-[19px]"
        style={{ fontFamily: SERIF_FONT }}
        numberOfLines={2}
      >
        {props.meeting.title}
      </Text>
      <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
        {props.meeting.people.length > 0
          ? props.meeting.people.join(", ")
          : "Notes update as it goes"}
      </Text>
      <View className="mt-auto flex-row items-center gap-1.5">
        <PulseDot className="bg-danger-foreground" pulse />
        <Text className="font-t3-medium text-3xs text-adaptive-red-700-300">
          Recording on the Mac
        </Text>
      </View>
    </Pressable>
  );
}

function Shelf(props: {
  readonly title: string;
  readonly count: number;
  readonly working?: boolean;
  readonly empty: string;
  readonly onSeeAll: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <View>
      <View className="flex-row items-center gap-2 px-5 pt-4 pb-2">
        {props.working ? (
          <PulseDot className="bg-adaptive-sky-600-400" pulse={props.count > 0} />
        ) : null}
        <Text className="font-t3-bold text-2xs uppercase tracking-[0.5px] text-foreground-muted">
          {props.title}
        </Text>
        <View className="rounded-full bg-subtle px-1.5">
          <Text className="font-t3-bold text-3xs text-foreground-muted">{props.count}</Text>
        </View>
        <View className="flex-1" />
        <Pressable onPress={props.onSeeAll} hitSlop={10} accessibilityRole="button">
          <Text className="text-2xs text-foreground-tertiary">All →</Text>
        </Pressable>
      </View>
      {props.count === 0 ? (
        <Text className="px-5 pb-1 text-xs text-foreground-tertiary">{props.empty}</Text>
      ) : (
        <ScrollView
          horizontal
          contentInsetAdjustmentBehavior="never"
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={CARD_WIDTH + 9}
          contentContainerStyle={{ paddingHorizontal: 14, gap: 9 }}
        >
          {props.children}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * Home: what is working, what is done, and everything else, each a row to
 * swipe through, under a composer that sends to tui. Swipe left for the full
 * thread list (Chats), right for Meetings.
 */
export function ShelvesHomeScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const now = useMinuteClock();
  const threads = useThreadShells();
  const projects = useProjects();
  const openThread = useHomeThreadSelection();
  const { environmentId, connected } = useTuiEnvironment();
  const [composing, setComposing] = useState(false);

  const shelves = useMemo(() => buildShelves(threads, now), [threads, now]);
  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects as ReadonlyArray<EnvironmentProject>) {
      titles.set(`${project.environmentId}:${project.id}`, project.title);
    }
    return titles;
  }, [projects]);

  const meetings =
    useEnvironmentQuery(
      environmentId ? serverEnvironment.meetingList({ environmentId, input: { limit: 10 } }) : null,
    ).data?.meetings ?? [];
  const liveMeeting = meetings.find((meeting) => meeting.live) ?? null;

  const go = (tab: HomeTab) => {
    if (tab === "chats") navigation.navigate("Chats", undefined);
    if (tab === "meetings") navigation.navigate("Meetings", undefined);
  };
  const openMeeting = (meeting: HistoryMeetingSummary) => {
    if (environmentId) navigation.navigate("Meeting", { environmentId, meetingId: meeting.id });
  };

  // Swipe across the page (not along a shelf) to move between the three.
  const swipe = Gesture.Pan()
    .activeOffsetX([-30, 30])
    .failOffsetY([-14, 14])
    .runOnJS(true)
    .onEnd((event) => {
      if (event.translationX < -70) go("chats");
      else if (event.translationX > 70) go("meetings");
    });

  const needsYou = shelves.other.some(
    (card) => card.state === "needs-input" || card.state === "needs-approval",
  );
  const cardFor = (card: ShelfCard) => (
    <ShelfCardView
      key={`${card.thread.environmentId}:${card.thread.id}`}
      card={card}
      now={now}
      projectTitle={
        projectTitles.get(`${card.thread.environmentId}:${card.thread.projectId}`) ?? "Thread"
      }
      onPress={() => openThread(card.thread)}
    />
  );

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <GestureDetector gesture={swipe}>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: insets.bottom + 190 }}
          keyboardDismissMode="interactive"
        >
          <View className="flex-row items-start px-5">
            <View className="flex-1">
              <Text className="text-xs text-foreground-muted">
                {new Date(now).toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </Text>
              <Text
                className="mt-0.5 text-[28px] leading-[34px]"
                style={{ fontFamily: SERIF_FONT }}
              >
                {greeting(new Date(now))}
              </Text>
              {!connected && environmentId ? (
                <Pressable
                  onPress={() =>
                    navigation.navigate("SettingsSheet", {
                      screen: "SettingsContent",
                      params: { screen: "SettingsEnvironments" },
                    })
                  }
                >
                  <Text className="mt-1 text-2xs text-adaptive-amber-700-400">
                    Not connected to your Mac · showing what the phone last saw
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <View className="flex-row gap-2 pt-1">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="New task"
                onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
                className="size-9 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView name="square.and.pencil" size={16} tintColorClassName="accent-icon" />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open settings"
                onPress={() =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "Settings" },
                  })
                }
                className="size-9 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView name="ellipsis.circle" size={17} tintColorClassName="accent-icon" />
              </Pressable>
            </View>
          </View>

          <Shelf
            title="Working"
            working
            count={shelves.working.length + (liveMeeting ? 1 : 0)}
            empty="Nothing running right now."
            onSeeAll={() => go("chats")}
          >
            {liveMeeting ? (
              <LiveMeetingCard meeting={liveMeeting} onPress={() => openMeeting(liveMeeting)} />
            ) : null}
            {shelves.working.map(cardFor)}
          </Shelf>
          <Shelf
            title="Done"
            count={shelves.done.length}
            empty="Nothing finished in the last three days."
            onSeeAll={() => go("chats")}
          >
            {shelves.done.map(cardFor)}
          </Shelf>
          <Shelf
            title="Everything else"
            count={shelves.other.length}
            empty="Nothing waiting on you."
            onSeeAll={() => go("chats")}
          >
            {shelves.other.map(cardFor)}
          </Shelf>
        </ScrollView>
      </GestureDetector>

      <KeyboardStickyView
        pointerEvents="box-none"
        style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        offset={{ closed: 0, opened: insets.bottom - 8 }}
      >
        <View pointerEvents="box-none" style={{ paddingBottom: composing ? 8 : insets.bottom + 4 }}>
          <HomeDock
            liveMeeting={liveMeeting}
            onOpenMeeting={openMeeting}
            onFocusChange={setComposing}
          />
          {composing ? null : (
            <View className="items-center pt-2.5" pointerEvents="box-none">
              <HomeTabs
                active="home"
                badges={{
                  ...(liveMeeting ? { meetings: "live" as const } : {}),
                  ...(needsYou ? { chats: "attention" as const } : {}),
                }}
                onSelect={go}
              />
            </View>
          )}
        </View>
      </KeyboardStickyView>
    </View>
  );
}
