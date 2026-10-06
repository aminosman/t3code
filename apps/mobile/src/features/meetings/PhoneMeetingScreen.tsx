import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SERIF_FONT } from "../home/HomeDock";
import { meetingDayLabel, meetingTime } from "./meeting-notes";
import { phoneMeetingStatus } from "./PhoneMeetingParts";
import {
  clockTime,
  deletePhoneMeeting,
  transcribePhoneMeeting,
  updatePhoneMeeting,
  usePhoneMeeting,
} from "./phone-meetings";

type PhoneMeetingScreenProps = StaticScreenProps<{ readonly id: string }>;

/**
 * A meeting recorded on the phone: what the user typed, and the transcript
 * made on the device. It reaches the Mac (and gets Granola-style notes there)
 * once it has synced.
 */
export function PhoneMeetingScreen({ route }: PhoneMeetingScreenProps) {
  const meeting = usePhoneMeeting(route.params.id);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<"transcript" | "mine">("transcript");

  if (!meeting) {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <Text className="text-sm text-foreground-muted">
          This recording is no longer on the phone.
        </Text>
      </View>
    );
  }

  const remove = () =>
    Alert.alert(
      "Delete this recording?",
      "The audio, transcript and your notes are deleted from the phone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void deletePhoneMeeting(meeting.id).then(() => navigation.goBack()),
        },
      ],
    );

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: "" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 40 }}
      >
        <Text className="mt-2 text-[28px] leading-[34px]" style={{ fontFamily: SERIF_FONT }}>
          {meeting.title}
        </Text>
        <View className="mt-3 flex-row flex-wrap gap-1.5">
          {[
            `${meetingDayLabel(meeting.startedAt)} ${meetingTime(meeting.startedAt)}`,
            clockTime(meeting.durationSeconds),
            meeting.kind === "call" ? "Call on speaker" : "In person",
          ].map((chip) => (
            <View key={chip} className="rounded-full border border-border px-2.5 py-1">
              <Text className="text-2xs text-foreground-secondary">{chip}</Text>
            </View>
          ))}
        </View>
        <Text className="mt-2 text-2xs text-adaptive-amber-700-400">
          {phoneMeetingStatus(meeting)}
        </Text>

        <View className="mt-5 flex-row gap-1 self-start rounded-full bg-subtle p-[3px]">
          {(
            [
              { key: "transcript", label: "Transcript" },
              { key: "mine", label: "My notes" },
            ] as const
          ).map((option) => (
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
                  view === option.key ? "font-t3-medium text-xs" : "text-xs text-foreground-muted"
                }
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {view === "mine" ? (
          <Text selectable className="mt-5 text-[15px] leading-[22px]">
            {meeting.myNotes.trim() || "Nothing was typed during this meeting."}
          </Text>
        ) : meeting.transcription === "done" ? (
          <View className="mt-5 gap-3">
            {meeting.transcript.length === 0 ? (
              <Text className="text-sm text-foreground-muted">No speech was heard.</Text>
            ) : null}
            {meeting.transcript.map((line) => (
              <View key={`${line.seconds}:${line.text.slice(0, 24)}`} className="flex-row gap-3">
                <Text className="w-11 pt-0.5 text-3xs text-foreground-tertiary">{line.at}</Text>
                <Text
                  selectable
                  className="flex-1 text-[15px] leading-[22px] text-foreground-secondary"
                >
                  {line.text}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View className="mt-5 gap-3">
            <Text className="text-sm text-foreground-muted">{phoneMeetingStatus(meeting)}</Text>
            {meeting.transcription === "failed" ? (
              <Pressable
                onPress={() => {
                  void updatePhoneMeeting(meeting.id, (m) => ({
                    ...m,
                    transcription: "pending",
                  })).then(() => transcribePhoneMeeting(meeting.id));
                }}
                className="self-start rounded-full bg-subtle px-3 py-1.5"
              >
                <Text className="text-xs">Try again</Text>
              </Pressable>
            ) : null}
          </View>
        )}

        <Pressable onPress={remove} className="mt-10 self-start" hitSlop={8}>
          <Text className="text-xs text-danger-foreground">Delete recording</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
