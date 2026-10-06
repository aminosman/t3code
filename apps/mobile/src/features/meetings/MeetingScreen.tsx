import type { EnvironmentId } from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SERIF_FONT } from "../home/HomeDock";
import { meetingDayLabel, meetingTime, parseMeetingNotes } from "./meeting-notes";

type MeetingScreenProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly meetingId: string;
}>;

type View_ = "notes" | "mine" | "transcript";

function Chip(props: { readonly children: string }) {
  return (
    <View className="rounded-full border border-border px-2.5 py-1">
      <Text className="text-2xs text-foreground-secondary">{props.children}</Text>
    </View>
  );
}

/**
 * One meeting: its notes as Granola draws them (a grey "#" before each
 * heading), what the user typed during it, and the transcript as bubbles —
 * the far side grey on the left, the user on the right. A meeting still
 * being recorded refreshes every ten seconds.
 */
export function MeetingScreen({ route }: MeetingScreenProps) {
  const { environmentId, meetingId } = route.params;
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<View_>("notes");
  const query = useEnvironmentQuery(
    serverEnvironment.meetingRead({ environmentId, input: { meetingId, whole: true } }),
  );
  const data = query.data;
  const live = data?.meeting.live === true;
  const { refresh } = query;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [live, refresh]);

  const parsed = data?.notes ? parseMeetingNotes(data.notes) : [];
  // Notes often open with the meeting's own title; the page already shows it.
  const first = parsed[0];
  const blocks =
    first?.kind === "heading" &&
    first.text.trim().toLowerCase() === data?.meeting.title.trim().toLowerCase()
      ? parsed.slice(1)
      : parsed;
  const meeting = data?.meeting;
  const chips = meeting
    ? [
        [meetingDayLabel(meeting.startedAt), meetingTime(meeting.startedAt)]
          .filter(Boolean)
          .join(" "),
        meeting.durationMinutes ? `${Math.round(meeting.durationMinutes)} min` : null,
        meeting.people.length > 0 ? meeting.people.join(", ") : null,
        meeting.projectTitle,
      ].filter((chip): chip is string => Boolean(chip))
    : [];

  const views: ReadonlyArray<{ key: View_; label: string }> = [
    { key: "notes", label: "Notes" },
    ...(data?.myNotes ? [{ key: "mine" as const, label: "My notes" }] : []),
    { key: "transcript", label: "Transcript" },
  ];

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: "" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 40 }}
      >
        {meeting ? (
          <>
            {live ? (
              <View className="mt-1 flex-row items-center gap-1.5">
                <View className="size-2 rounded-full bg-danger-foreground" />
                <Text className="text-2xs text-adaptive-red-700-300">Recording on the Mac</Text>
              </View>
            ) : null}
            <Text className="mt-2 text-[28px] leading-[34px]" style={{ fontFamily: SERIF_FONT }}>
              {meeting.title}
            </Text>
            <View className="mt-3 flex-row flex-wrap gap-1.5">
              {chips.map((chip) => (
                <Chip key={chip}>{chip}</Chip>
              ))}
            </View>
            <View className="mt-5 flex-row gap-1 self-start rounded-full bg-subtle p-[3px]">
              {views.map((option) => (
                <Pressable
                  key={option.key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: view === option.key }}
                  onPress={() => setView(option.key)}
                  className={
                    view === option.key
                      ? "rounded-full bg-card px-3 py-1.5"
                      : "rounded-full px-3 py-1.5"
                  }
                >
                  <Text
                    className={
                      view === option.key
                        ? "font-t3-medium text-xs"
                        : "text-xs text-foreground-muted"
                    }
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {view === "notes" ? (
              blocks.length === 0 ? (
                <Text className="mt-6 text-sm text-foreground-muted">
                  {live
                    ? "Notes appear as the meeting goes."
                    : "No notes were written for this meeting."}
                </Text>
              ) : (
                <View className="mt-5 gap-1.5">
                  {blocks.map((block) =>
                    block.kind === "heading" ? (
                      <View key={block.id} className="mt-4 flex-row gap-2">
                        <Text
                          className="text-[19px] text-foreground-tertiary"
                          style={{ fontFamily: SERIF_FONT }}
                        >
                          #
                        </Text>
                        <Text className="flex-1 text-[19px]" style={{ fontFamily: SERIF_FONT }}>
                          {block.text}
                        </Text>
                      </View>
                    ) : block.kind === "bullet" ? (
                      <View
                        key={block.id}
                        className="flex-row gap-2"
                        style={{ paddingLeft: 4 + block.depth * 16 }}
                      >
                        <Text className="text-[15px] leading-[22px] text-foreground-tertiary">
                          •
                        </Text>
                        <Text className="flex-1 text-[15px] leading-[22px] text-foreground-secondary">
                          {block.text}
                        </Text>
                      </View>
                    ) : (
                      <Text
                        key={block.id}
                        className="text-[15px] leading-[22px] text-foreground-secondary"
                      >
                        {block.text}
                      </Text>
                    ),
                  )}
                </View>
              )
            ) : view === "mine" ? (
              <Text selectable className="mt-5 text-[15px] leading-[22px]">
                {data?.myNotes}
              </Text>
            ) : (
              <View className="mt-5 gap-1.5">
                {(data?.lines ?? []).length === 0 ? (
                  <Text className="text-sm text-foreground-muted">No transcript was kept.</Text>
                ) : null}
                {(data?.lines ?? []).map((line, index, lines) => {
                  const mine = line.speaker === "me";
                  const turn = index === 0 || lines[index - 1]?.speaker !== line.speaker;
                  return (
                    <View
                      key={`${line.seconds}:${line.speaker}:${line.text.slice(0, 24)}`}
                      className={mine ? "items-end" : "items-start"}
                      style={{ marginTop: turn ? 8 : 0 }}
                    >
                      {turn ? (
                        <Text className="mb-0.5 px-1 text-3xs text-foreground-tertiary">
                          {mine ? "Me" : line.speaker === "them" ? "Them" : line.speaker} ·{" "}
                          {line.at}
                        </Text>
                      ) : null}
                      <View
                        className={
                          mine
                            ? "max-w-[86%] rounded-2xl bg-adaptive-emerald-500-a12-a16 px-3 py-2"
                            : "max-w-[86%] rounded-2xl bg-subtle px-3 py-2"
                        }
                      >
                        <Text className="text-sm leading-[20px]">{line.text}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        ) : (
          <Text className="mt-10 text-center text-sm text-foreground-muted">
            {query.error ? "Could not load this meeting from the Mac." : "Loading…"}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
