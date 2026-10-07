import type { HistoryMeetingSummary } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GUTTER, GrHeader, GrInputSurface, GrPage, SERIF, SPACE } from "../../design/granola";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { tabsFootprint } from "../home/HomeTabs";
import { meetingDayLabel, meetingTime } from "./meeting-notes";
import { MeetingDayLabel, MeetingRowView } from "./meeting-rows";
import { PhoneMeetingsHeader } from "./PhoneMeetingParts";
import { useMeetingsEnvironment } from "./use-meetings-environment";

function meetingDetails(meeting: HistoryMeetingSummary): string {
  return [
    meetingTime(meeting.startedAt),
    meeting.durationMinutes ? `${Math.round(meeting.durationMinutes)} min` : null,
    meeting.people.length > 0
      ? meeting.people.length > 2
        ? `${meeting.people.slice(0, 2).join(", ")} +${meeting.people.length - 2}`
        : meeting.people.join(", ")
      : null,
    meeting.projectTitle,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Meetings: start a recording on the phone, what was recorded here, and the
 * meetings Roost keeps on the Mac by day, under a header that stays put, with
 * a box to ask about them (the answer is a thread in the Meetings project).
 * `embedded` is the left page of the home pager; otherwise it is a pushed
 * screen with the native header (links, iPad).
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

  const footer = embedded ? tabsFootprint(insets.bottom) : insets.bottom + SPACE.sm;
  const canAsk = question.trim().length > 0 && !asking;

  const body = (
    <View className="flex-1">
      <SectionList
        sections={sections}
        keyExtractor={(meeting) => meeting.id}
        contentInsetAdjustmentBehavior={embedded ? "never" : "automatic"}
        contentContainerStyle={{ paddingBottom: footer + 80 }}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={query.isPending && query.data !== null}
            onRefresh={query.refresh}
          />
        }
        ListHeaderComponent={<PhoneMeetingsHeader />}
        renderSectionHeader={({ section }) =>
          environmentId ? <MeetingDayLabel>{section.title}</MeetingDayLabel> : null
        }
        renderItem={({ item }) => (
          <MeetingRowView
            title={item.title}
            details={meetingDetails(item)}
            status={item.live ? { text: "Recording on the Mac", tone: "live" } : undefined}
            onPress={() =>
              environmentId && navigation.navigate("Meeting", { environmentId, meetingId: item.id })
            }
          />
        )}
        ListEmptyComponent={
          <View style={{ paddingHorizontal: GUTTER, paddingTop: SPACE.xxxl }}>
            <Text className="text-[20px] text-gr-ink" style={{ fontFamily: SERIF }}>
              {environmentId ? "No meetings on the Mac yet" : "Your Mac's meetings show here"}
            </Text>
            <Text className="mt-1 text-[14px] leading-[20px] text-gr-ink-2">
              {environmentId
                ? "Meetings tui records on the Mac appear here with their notes and transcript."
                : "Connect to a Mac running Roost with tui recording meetings, and they appear here."}
            </Text>
          </View>
        }
      />
      {environmentId ? (
        <KeyboardStickyView
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          offset={{ closed: 0, opened: insets.bottom - SPACE.sm }}
        >
          <View
            // Page-coloured under the box, so rows do not show between it and the tabs.
            className="bg-gr-surface"
            style={{ paddingTop: SPACE.sm, paddingBottom: footer }}
            pointerEvents="box-none"
          >
            <GrInputSurface>
              <View
                className="flex-row items-center"
                style={{
                  paddingLeft: SPACE.lg,
                  paddingRight: SPACE.sm,
                  paddingVertical: SPACE.sm,
                  gap: SPACE.sm,
                }}
              >
                <TextInput
                  accessibilityLabel="Ask about your meetings"
                  className="max-h-32 flex-1 font-sans text-[16px] text-gr-ink"
                  // iOS pads a multiline field unevenly on its own; set both sides.
                  style={{ paddingTop: SPACE.sm, paddingBottom: SPACE.sm }}
                  multiline
                  placeholder="Ask anything about your meetings"
                  placeholderTextColorClassName="accent-gr-ink-3"
                  cursorColorClassName="accent-gr-accent"
                  value={question}
                  onChangeText={setQuestion}
                  submitBehavior="blurAndSubmit"
                  returnKeyType="send"
                  onSubmitEditing={() => void submit()}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Ask"
                  disabled={!canAsk}
                  onPress={() => void submit()}
                  className="size-9 items-center justify-center rounded-full bg-gr-button"
                  style={{ opacity: canAsk ? 1 : 0.3 }}
                >
                  <SymbolView name="arrow.up" size={16} tintColorClassName="accent-gr-button-ink" />
                </Pressable>
              </View>
              {problem ? (
                <Text
                  className="text-[12px] text-gr-danger"
                  style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}
                >
                  {problem}
                </Text>
              ) : null}
            </GrInputSurface>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );

  if (!embedded) {
    return (
      <View className="flex-1 bg-gr-surface">
        <NativeStackScreenOptions options={{ title: "Meetings", headerLargeTitle: true }} />
        {body}
      </View>
    );
  }
  return (
    <GrPage header={<GrHeader eyebrow="On this phone and your Mac" title="Meetings" />}>
      {body}
    </GrPage>
  );
}
