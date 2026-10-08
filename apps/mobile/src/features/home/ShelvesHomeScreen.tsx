import type { HistoryMeetingSummary } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
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
import {
  GUTTER,
  GrCard,
  GrHeader,
  GrIconButton,
  GrPage,
  GrSectionLabel,
  GrTile,
  SERIF,
  SPACE,
} from "../../design/granola";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useMeetingsEnvironment } from "../meetings/use-meetings-environment";
import { useHomeThreadSelection } from "./home-thread-navigation";
import { HomeDock } from "./HomeDock";
import { tabsFootprint, type HomeTab } from "./HomeTabs";
import {
  buildShelves,
  SHELF_ORDER,
  shelfNeedsUser,
  shelfPreview,
  recentProjectKeys,
  shelfStateLabel,
  shelfStatusLine,
  type ShelfCard,
  type ShelfCardState,
  type ShelfKind,
} from "./shelves";
import { useTuiEnvironment } from "./use-tui-environment";

const CARD_WIDTH = 232;
const CARD_HEIGHT = 136;
const CARD_GAP = SPACE.md;

// A row is titled by its status, in the desktop's words.
const SHELF_TITLES: Record<ShelfKind, string> = Object.fromEntries(
  SHELF_ORDER.map((kind) => [kind, shelfStateLabel(kind)]),
) as Record<ShelfKind, string>;

/** Status colours, from the design system: see src/design/README.md. */
const STATE_TONE: Record<ShelfCardState, { text: string; dot: string }> = {
  "needs-approval": { text: "text-gr-attention", dot: "bg-gr-attention" },
  "needs-input": { text: "text-gr-attention", dot: "bg-gr-attention" },
  working: { text: "text-gr-accent", dot: "bg-gr-accent" },
  connecting: { text: "text-gr-accent", dot: "bg-gr-accent" },
  waiting: { text: "text-gr-ink-2", dot: "bg-gr-ink-2" },
  "plan-ready": { text: "text-gr-attention", dot: "bg-gr-attention" },
  completed: { text: "text-gr-accent", dot: "bg-gr-accent" },
  error: { text: "text-gr-danger", dot: "bg-gr-danger" },
  limited: { text: "text-gr-danger", dot: "bg-gr-danger" },
  stopped: { text: "text-gr-ink-3", dot: "bg-gr-ink-3" },
  done: { text: "text-gr-ink-3", dot: "bg-gr-ink-3" },
  new: { text: "text-gr-ink-3", dot: "bg-gr-ink-3" },
};

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

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
  readonly onShowAgents: () => void;
}) {
  const { card } = props;
  const quiet = card.state === "done" || card.state === "stopped" || card.state === "new";
  const preview = shelfPreview(card.thread);
  // Shells carry no message text today, so most cards say what is doing the work.
  const failure = card.state === "error" ? (card.thread.runtime?.lastError ?? null) : null;
  const detail =
    failure ??
    preview ??
    [formatModelSlugName(card.thread.modelSelection.model), card.thread.branch]
      .filter(Boolean)
      .join(" · ");
  const tone = STATE_TONE[card.state];
  return (
    <GrCard
      onPress={props.onPress}
      accessibilityLabel={`${card.unread ? "Unread, " : ""}${card.thread.title}, ${props.projectTitle}, ${shelfStateLabel(card.state)}`}
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.md,
        gap: SPACE.xs,
      }}
    >
      <View className="flex-row items-center gap-2">
        <GrTile name={props.projectTitle} size={20} />
        <Text className="flex-1 text-[12px] text-gr-ink-2" numberOfLines={1}>
          {props.projectTitle}
        </Text>
        {card.unread ? (
          <View accessibilityLabel="Unread" className="size-2 rounded-full bg-gr-accent" />
        ) : null}
      </View>
      <Text
        className={
          quiet
            ? "text-[15.5px] leading-[20px] text-gr-ink-2-strong"
            : "text-[15.5px] leading-[20px] text-gr-ink"
        }
        style={{ fontFamily: SERIF }}
        numberOfLines={2}
      >
        {card.thread.title}
      </Text>
      {detail ? (
        <Text
          className={
            failure
              ? "text-[12px] leading-[16px] text-gr-danger"
              : "text-[12px] leading-[16px] text-gr-ink-2"
          }
          numberOfLines={failure ? 2 : 1}
        >
          {detail}
        </Text>
      ) : null}
      <View className="mt-auto flex-row items-center justify-between">
        <View className="flex-row items-center gap-1.5">
          <PulseDot className={tone.dot} pulse={card.state === "working"} />
          <Text className={`font-t3-medium text-[12px] ${tone.text}`} numberOfLines={1}>
            {shelfStatusLine(card, props.now)}
          </Text>
        </View>
        {card.agentCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show the ${card.agentCount} agents under this thread`}
            hitSlop={10}
            onPress={props.onShowAgents}
            className="flex-row items-center gap-1 rounded-full border border-gr-hairline px-2 py-0.5 active:bg-gr-sunken"
          >
            <SymbolView name="sparkles" size={10} tintColorClassName="accent-gr-ink-2" />
            <Text className="text-[12px] text-gr-ink-2">
              {card.agentsWorking > 0
                ? `${card.agentsWorking}/${card.agentCount}`
                : `${card.agentCount}`}
            </Text>
            <SymbolView name="chevron.right" size={9} tintColorClassName="accent-gr-ink-3" />
          </Pressable>
        ) : null}
      </View>
    </GrCard>
  );
}

function LiveMeetingCard(props: {
  readonly meeting: HistoryMeetingSummary;
  readonly onPress: () => void;
}) {
  return (
    <GrCard
      onPress={props.onPress}
      accessibilityLabel={`${props.meeting.title}, being recorded`}
      className="bg-gr-danger-tint"
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.md,
        gap: SPACE.xs,
      }}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-[12px] text-gr-ink-2">Meeting</Text>
        <Text className="text-[12px] text-gr-ink-3">now</Text>
      </View>
      <Text
        className="text-[15.5px] leading-[20px] text-gr-ink"
        style={{ fontFamily: SERIF }}
        numberOfLines={2}
      >
        {props.meeting.title}
      </Text>
      <Text className="text-[12px] text-gr-ink-2" numberOfLines={1}>
        {props.meeting.people.length > 0
          ? props.meeting.people.join(", ")
          : "Notes update as it goes"}
      </Text>
      <View className="mt-auto flex-row items-center gap-1.5">
        <PulseDot className="bg-gr-danger" pulse />
        <Text className="font-t3-medium text-[12px] text-gr-danger">Recording on the Mac</Text>
      </View>
    </GrCard>
  );
}

/**
 * One capsule per project with something on Home, most recently active
 * first, after "All". Tapping one shows only that project's threads on every
 * row; tapping it again (or All) shows everything.
 */
function ProjectPills(props: {
  readonly keys: ReadonlyArray<string>;
  readonly titles: ReadonlyMap<string, string>;
  readonly selected: string | null;
  readonly onSelect: (key: string | null) => void;
}) {
  const pill = (key: string | null, label: string) => {
    const on = props.selected === key;
    return (
      <Pressable
        key={key ?? "all"}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        onPress={() => props.onSelect(on && key !== null ? null : key)}
        className={
          on
            ? "h-8 flex-row items-center gap-1.5 rounded-full bg-gr-button px-3"
            : "h-8 flex-row items-center gap-1.5 rounded-full border border-gr-hairline bg-gr-raised px-3 active:bg-gr-sunken"
        }
      >
        {key !== null ? <GrTile name={label} size={16} /> : null}
        <Text
          className={
            on
              ? "text-[13px] font-t3-medium text-gr-button-ink"
              : "text-[13px] text-gr-ink-2-strong"
          }
          numberOfLines={1}
        >
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentInsetAdjustmentBehavior="never"
      // The pills run to the screen edge, starting on the page margin.
      style={{ marginHorizontal: -GUTTER }}
      contentContainerStyle={{ paddingHorizontal: GUTTER, gap: SPACE.sm }}
    >
      {pill(null, "All")}
      {props.keys.map((key) => pill(key, props.titles.get(key) ?? "Project"))}
    </ScrollView>
  );
}

function Shelf(props: {
  readonly title: string;
  readonly count: number;
  readonly working?: boolean;
  readonly onSeeAll: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <View>
      <GrSectionLabel
        title={props.title}
        count={props.count}
        leading={props.working ? <PulseDot className="bg-gr-accent" pulse /> : undefined}
        action={{ label: "All", onPress: props.onSeeAll }}
      />
      <ScrollView
        horizontal
        contentInsetAdjustmentBehavior="never"
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={CARD_WIDTH + CARD_GAP}
        contentContainerStyle={{ paddingHorizontal: GUTTER, gap: CARD_GAP }}
      >
        {props.children}
      </ScrollView>
    </View>
  );
}

/**
 * What Home shows, read once by the pager: the shelves, the meeting being
 * recorded (if any), and the Mac tui is reached through.
 */
export function useHomeData() {
  const now = useMinuteClock();
  const threads = useThreadShells();
  const { environmentId, connected } = useTuiEnvironment();
  const shelves = useMemo(() => buildShelves(threads, now), [threads, now]);
  const meetingsEnvironmentId = useMeetingsEnvironment();
  const meetings =
    useEnvironmentQuery(
      meetingsEnvironmentId
        ? serverEnvironment.meetingList({
            environmentId: meetingsEnvironmentId,
            input: { limit: 10 },
          })
        : null,
    ).data?.meetings ?? [];
  const liveMeeting = meetings.find((meeting) => meeting.live) ?? null;
  const needsYou = SHELF_ORDER.some((kind) => shelfNeedsUser(kind) && shelves[kind].length > 0);
  return {
    now,
    shelves,
    environmentId,
    connected,
    meetingsEnvironmentId,
    liveMeeting,
    needsYou,
  };
}

export type HomeData = ReturnType<typeof useHomeData>;

/**
 * Home: a row per status — needs you, working, done, failed, stopped — under
 * a header that stays put, with a composer that sends to tui. It is the
 * middle page of the pager, between Meetings and Chats.
 */
export function ShelvesHomeScreen(props: {
  readonly data: HomeData;
  readonly onShowPage: (tab: HomeTab) => void;
  readonly onComposingChange: (composing: boolean) => void;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const openThread = useHomeThreadSelection();
  const {
    now,
    shelves: allShelves,
    environmentId,
    connected,
    meetingsEnvironmentId,
    liveMeeting,
  } = props.data;
  // Project pills: one project's threads on every row, or all of them.
  const threads = useThreadShells();
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const projectShelves = useMemo(
    () => (projectKey === null ? null : buildShelves(threads, now, projectKey)),
    [now, projectKey, threads],
  );
  const shelves = projectShelves ?? allShelves;
  const [composing, setComposing] = useState(false);

  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects as ReadonlyArray<EnvironmentProject>) {
      titles.set(`${project.environmentId}:${project.id}`, project.title);
    }
    return titles;
  }, [projects]);

  const pillKeys = useMemo(
    () => recentProjectKeys(threads).filter((key) => projectTitles.has(key)),
    [projectTitles, threads],
  );

  const go = props.onShowPage;
  const openMeeting = (meeting: HistoryMeetingSummary) => {
    if (meetingsEnvironmentId)
      navigation.navigate("Meeting", {
        environmentId: meetingsEnvironmentId,
        meetingId: meeting.id,
      });
  };

  // One row per status; a status with nothing in it takes no room.
  const visibleShelves = SHELF_ORDER.filter(
    (kind) =>
      shelves[kind].length > 0 ||
      (kind === "working" && liveMeeting !== null && projectKey === null),
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
      onShowAgents={() =>
        navigation.navigate("OwnedThreads", {
          environmentId: card.thread.environmentId,
          threadId: card.thread.id,
        })
      }
    />
  );

  const header = (
    <GrHeader
      eyebrow={new Date(now).toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      })}
      title={greeting(new Date(now))}
      below={
        pillKeys.length > 1 ? (
          <ProjectPills
            keys={pillKeys}
            titles={projectTitles}
            selected={projectKey}
            onSelect={setProjectKey}
          />
        ) : undefined
      }
      note={
        !connected && environmentId ? (
          <Text className="text-[13px] text-gr-attention">
            Not connected to your Mac · showing what the phone last saw
          </Text>
        ) : undefined
      }
      actions={
        <>
          <GrIconButton
            icon="square.and.pencil"
            label="New task"
            onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          />
          <GrIconButton
            icon="ellipsis"
            label="Open settings"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "Settings" },
              })
            }
          />
        </>
      }
    />
  );

  return (
    <GrPage header={header}>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: tabsFootprint(insets.bottom) + 120 }}
        keyboardDismissMode="interactive"
      >
        {visibleShelves.length === 0 ? (
          <Text
            className="text-[15px] text-gr-ink-3"
            style={{ paddingHorizontal: GUTTER, paddingTop: SPACE.xl }}
          >
            Nothing yet. Say what you want done below.
          </Text>
        ) : null}
        {visibleShelves.map((kind) => (
          <Shelf
            key={kind}
            title={SHELF_TITLES[kind]}
            working={kind === "working"}
            count={
              shelves[kind].length +
              (kind === "working" && liveMeeting && projectKey === null ? 1 : 0)
            }
            onSeeAll={() => go("chats")}
          >
            {kind === "working" && liveMeeting && projectKey === null ? (
              <LiveMeetingCard meeting={liveMeeting} onPress={() => openMeeting(liveMeeting)} />
            ) : null}
            {shelves[kind].map(cardFor)}
          </Shelf>
        ))}
      </ScrollView>

      <KeyboardStickyView
        pointerEvents="box-none"
        style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        offset={{ closed: 0, opened: insets.bottom - SPACE.sm }}
      >
        <View
          // Page-coloured under the composer so cards never show between it and the tabs.
          className="bg-gr-surface"
          pointerEvents="box-none"
          style={{
            paddingTop: SPACE.sm,
            paddingBottom: composing ? SPACE.sm : tabsFootprint(insets.bottom),
          }}
        >
          <HomeDock
            liveMeeting={liveMeeting}
            onOpenMeeting={openMeeting}
            onFocusChange={(focused) => {
              setComposing(focused);
              props.onComposingChange(focused);
            }}
          />
        </View>
      </KeyboardStickyView>
    </GrPage>
  );
}
