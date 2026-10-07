import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { GrChip, SERIF } from "../../design/granola";
import { meetingDayLabel, meetingTime } from "./meeting-notes";
import { phoneMeetingStatus } from "./PhoneMeetingParts";
import { syncPhoneMeeting, usePhoneMeetingSending } from "./phone-meeting-sync";
import { useMeetingsEnvironment } from "./use-meetings-environment";
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
  const sending = usePhoneMeetingSending(route.params.id);
  const environmentId = useMeetingsEnvironment();

  if (!meeting) {
    return (
      <View className="flex-1 items-center justify-center bg-gr-surface">
        <Text className="text-sm text-gr-ink-2">This recording is no longer on the phone.</Text>
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
    <View className="flex-1 bg-gr-surface">
      <NativeStackScreenOptions options={{ title: "" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 40 }}
      >
        <Text className="mt-2 text-[28px] leading-[34px] text-gr-ink" style={{ fontFamily: SERIF }}>
          {meeting.title}
        </Text>
        <View className="mt-3 flex-row flex-wrap gap-1.5">
          {[
            `${meetingDayLabel(meeting.startedAt)} ${meetingTime(meeting.startedAt)}`,
            clockTime(meeting.durationSeconds),
            meeting.kind === "call" ? "Call on another device" : "In person",
          ].map((chip) => (
            <GrChip key={chip}>{chip}</GrChip>
          ))}
        </View>
        <View className="mt-3 flex-row items-center gap-3">
          <Text
            className={
              meeting.syncedAt ? "text-[13px] text-gr-accent" : "text-[13px] text-gr-attention"
            }
          >
            {phoneMeetingStatus(meeting, sending)}
          </Text>
          {!meeting.syncedAt && meeting.transcription !== "pending" && !sending && environmentId ? (
            <Pressable
              onPress={() => void syncPhoneMeeting(environmentId, meeting)}
              hitSlop={8}
              className="rounded-full border border-gr-hairline px-3 py-1"
            >
              <Text className="text-[13px] text-gr-ink">Send now</Text>
            </Pressable>
          ) : null}
        </View>
        {meeting.syncProblem && !meeting.syncedAt ? (
          <Text className="mt-1 text-[12px] text-gr-ink-2">{meeting.syncProblem}</Text>
        ) : null}
        {meeting.syncedAt ? (
          <Text className="mt-1 text-[12px] leading-[17px] text-gr-ink-2">
            tui transcribes it again on the Mac, writes the notes and files it; it then appears
            under your Mac's meetings.
          </Text>
        ) : null}

        <View className="mt-5 flex-row gap-1 self-start rounded-full bg-gr-sunken p-[3px]">
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
                  ? "rounded-full bg-gr-raised px-3 py-1.5"
                  : "rounded-full px-3 py-1.5"
              }
            >
              <Text
                className={view === option.key ? "font-t3-medium text-xs" : "text-xs text-gr-ink-2"}
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
              <Text className="text-sm text-gr-ink-2">No speech was heard.</Text>
            ) : null}
            {meeting.transcript.map((line) => (
              <View key={`${line.seconds}:${line.text.slice(0, 24)}`} className="flex-row gap-3">
                <Text className="w-11 pt-0.5 text-3xs text-gr-ink-3">{line.at}</Text>
                <Text selectable className="flex-1 text-[15px] leading-[22px] text-gr-ink-2-strong">
                  {line.text}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View className="mt-5 gap-3">
            <Text className="text-sm text-gr-ink-2">
              {meeting.transcription === "pending"
                ? "Transcribing on the phone…"
                : meeting.transcription === "unavailable"
                  ? "This phone cannot transcribe (it needs iOS 26). The Mac will, once it has the recording."
                  : "The phone could not transcribe this. The Mac will, once it has the recording."}
            </Text>
            {meeting.transcription === "failed" ? (
              <Pressable
                onPress={() => {
                  void updatePhoneMeeting(meeting.id, (m) => ({
                    ...m,
                    transcription: "pending",
                  })).then(() => transcribePhoneMeeting(meeting.id));
                }}
                className="self-start rounded-full bg-gr-sunken px-3 py-1.5"
              >
                <Text className="text-xs">Try again</Text>
              </Pressable>
            ) : null}
          </View>
        )}

        <Pressable onPress={remove} className="mt-10 self-start" hitSlop={8}>
          <Text className="text-xs text-gr-danger">Delete recording</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
