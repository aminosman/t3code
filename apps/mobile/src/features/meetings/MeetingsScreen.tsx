import type { HistoryMeetingSummary } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SERIF_FONT } from "../home/HomeDock";
import { TABS_CLEARANCE } from "../home/HomeTabs";
import { meetingDayLabel, meetingTime } from "./meeting-notes";
import { useMeetingsEnvironment } from "./use-meetings-environment";

const TILE_COLORS = ["#FBEFB8", "#E4E4DE", "#F8DDF0", "#D9ECF7", "#E2F0C9", "#F6E1CF"];

function MeetingRow(props: {
  readonly meeting: HistoryMeetingSummary;
  readonly onPress: () => void;
}) {
  const { meeting } = props;
  const details = [
    meetingTime(meeting.startedAt),
    meeting.durationMinutes ? `${Math.round(meeting.durationMinutes)} min` : null,
    meeting.people.length > 0
      ? meeting.people.length > 2
        ? `${meeting.people.slice(0, 2).join(", ")} +${meeting.people.length - 2}`
        : meeting.people.join(", ")
      : null,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="flex-row items-center gap-3 px-5 py-2.5 active:bg-row-hover"
    >
      <View
        className="size-9 items-center justify-center rounded-[10px]"
        style={{ backgroundColor: TILE_COLORS[meeting.title.length % TILE_COLORS.length] }}
      >
        <Text className="text-[17px] text-neutral-900" style={{ fontFamily: SERIF_FONT }}>
          {meeting.title.slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="font-t3-medium text-[15px]" numberOfLines={1}>
          {meeting.title}
        </Text>
        <Text className="mt-0.5 text-2xs text-foreground-muted" numberOfLines={1}>
          {details.join(" · ")}
          {meeting.projectTitle ? ` · ${meeting.projectTitle}` : ""}
        </Text>
      </View>
      {meeting.live ? (
        <View className="flex-row items-center gap-1 rounded-full bg-adaptive-red-50-950-a80 px-2 py-0.5">
          <View className="size-1.5 rounded-full bg-danger-foreground" />
          <Text className="text-3xs text-adaptive-red-700-300">Live</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Meetings recorded by Roost on the Mac, by day, newest first, and a box to
 * ask about them (the answer is a thread in the Meetings project).
 */
export function MeetingsScreen(props: { readonly embedded?: boolean } = {}) {
  const embedded = props.embedded === true;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = useMeetingsEnvironment();
  const query = useEnvironmentQuery(
    environmentId ? serverEnvironment.meetingList({ environmentId, input: { limit: 200 } }) : null,
  );
  const ask = useAtomCommand(serverEnvironment.askMeetings, {
    label: "ask about meetings",
    reportFailure: false,
  });
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const sections = useMemo(() => {
    const byDay = new Map<string, HistoryMeetingSummary[]>();
    for (const meeting of query.data?.meetings ?? []) {
      const label = meeting.live ? "Now" : meetingDayLabel(meeting.startedAt);
      const list = byDay.get(label) ?? [];
      list.push(meeting);
      byDay.set(label, list);
    }
    return [...byDay.entries()].map(([title, data]) => ({ title, data }));
  }, [query.data]);

  const submit = async () => {
    const text = question.trim();
    if (!text || !environmentId || asking) return;
    setAsking(true);
    setProblem(null);
    const result = await ask({ environmentId, input: { question: text } });
    setAsking(false);
    if (result._tag === "Failure") {
      setProblem("Could not ask Roost on the Mac. Check the connection and try again.");
      return;
    }
    setQuestion("");
    navigation.navigate("Thread", {
      environmentId,
      threadId: result.value.threadId,
    } as never);
  };

  return (
    <View className="flex-1 bg-screen">
      {embedded ? null : (
        <NativeStackScreenOptions options={{ title: "Meetings", headerLargeTitle: true }} />
      )}
      <SectionList
        sections={sections}
        keyExtractor={(meeting) => meeting.id}
        contentInsetAdjustmentBehavior={embedded ? "never" : "automatic"}
        contentContainerStyle={{
          paddingTop: embedded ? insets.top + 6 : 0,
          paddingBottom: insets.bottom + 110 + (embedded ? TABS_CLEARANCE : 0),
        }}
        ListHeaderComponent={
          embedded ? (
            <View className="px-5 pb-1">
              <Text className="font-t3-bold text-2xs uppercase tracking-[0.5px] text-foreground-muted">
                Recorded on your Mac
              </Text>
              <Text
                className="mt-0.5 text-[32px] leading-[38px]"
                style={{ fontFamily: SERIF_FONT }}
              >
                Meetings
              </Text>
            </View>
          ) : undefined
        }
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={query.isPending && query.data !== null}
            onRefresh={query.refresh}
          />
        }
        renderSectionHeader={({ section }) => (
          <Text className="px-5 pt-5 pb-1.5 font-t3-bold text-2xs uppercase tracking-[0.5px] text-foreground-muted">
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => (
          <MeetingRow
            meeting={item}
            onPress={() =>
              environmentId && navigation.navigate("Meeting", { environmentId, meetingId: item.id })
            }
          />
        )}
        ListEmptyComponent={
          <View className="items-center px-8 pt-24">
            <Text className="text-center text-[22px]" style={{ fontFamily: SERIF_FONT }}>
              {environmentId ? "No meetings yet" : "Meetings live on your Mac"}
            </Text>
            <Text className="mt-2 text-center text-sm text-foreground-muted">
              {environmentId
                ? "Meetings tui records on the Mac show up here, with their notes and transcript."
                : "Connect to a Mac running Roost with tui recording meetings, and they show up here."}
            </Text>
          </View>
        }
      />
      {environmentId ? (
        <KeyboardStickyView
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          offset={{ closed: 0, opened: insets.bottom - 8 }}
        >
          <View
            // In the pager the strip under the box is page-coloured, so rows
            // do not show between it and the tabs.
            className={embedded ? "bg-screen pt-2" : undefined}
            style={{ paddingBottom: insets.bottom + 4 + (embedded ? TABS_CLEARANCE : 0) }}
            pointerEvents="box-none"
          >
            <GlassSurface
              className="mx-2.5 overflow-hidden rounded-[24px] border border-border"
              fallbackClassName="bg-card"
            >
              <View className="flex-row items-end gap-2 py-2 pr-2 pl-4">
                <TextInput
                  accessibilityLabel="Ask about your meetings"
                  className="max-h-32 flex-1 py-2 font-sans text-base text-foreground"
                  multiline
                  placeholder="Ask anything about your meetings"
                  placeholderTextColorClassName="accent-placeholder"
                  cursorColorClassName="accent-focus"
                  value={question}
                  onChangeText={setQuestion}
                  submitBehavior="blurAndSubmit"
                  returnKeyType="send"
                  onSubmitEditing={() => void submit()}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Ask"
                  disabled={!question.trim() || asking}
                  onPress={() => void submit()}
                  className="size-9 items-center justify-center rounded-full bg-primary"
                  style={{ opacity: !question.trim() || asking ? 0.4 : 1 }}
                >
                  <SymbolView
                    name="arrow.up"
                    size={16}
                    tintColorClassName="accent-primary-foreground"
                  />
                </Pressable>
              </View>
              {problem ? (
                <Text className="px-4 pb-2 text-2xs text-danger-foreground">{problem}</Text>
              ) : null}
            </GlassSurface>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}
