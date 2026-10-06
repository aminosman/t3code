import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SERIF_FONT } from "../home/HomeDock";
import {
  clockTime,
  resumePendingTranscriptions,
  usePhoneMeetings,
  type PhoneMeeting,
} from "./phone-meetings";
import { meetingDayLabel, meetingTime } from "./meeting-notes";

export function phoneMeetingStatus(meeting: PhoneMeeting): string {
  switch (meeting.transcription) {
    case "pending":
      return "Transcribing on the phone…";
    case "done":
      return meeting.syncedAt ? "On your Mac" : "Transcribed · not on your Mac yet";
    case "unavailable":
      return "Saved · transcribing needs iOS 26";
    case "failed":
      return "Saved · could not transcribe";
  }
}

/**
 * The top of Meetings: start a recording on the phone (in the room, or a call
 * on speaker), and the meetings recorded here so far.
 */
export function PhoneMeetingsHeader() {
  const navigation = useNavigation();
  const meetings = usePhoneMeetings();
  useEffect(() => {
    void resumePendingTranscriptions();
  }, []);

  return (
    <View>
      <View className="mx-4 mt-3 gap-3 rounded-[18px] border border-border bg-card p-4">
        <View className="gap-0.5">
          <Text className="text-[17px]" style={{ fontFamily: SERIF_FONT }}>
            Record a meeting
          </Text>
          <Text className="text-2xs text-foreground-muted">
            Recorded and transcribed on this phone, even with no connection.
          </Text>
        </View>
        <View className="flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("MeetingRecord", { kind: "room" })}
            className="flex-1 flex-row items-center justify-center gap-2 rounded-full bg-foreground py-2.5"
          >
            <View className="size-2 rounded-full bg-danger-foreground" />
            <Text className="font-t3-medium text-sm text-screen">In person</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("MeetingRecord", { kind: "call" })}
            className="flex-1 flex-row items-center justify-center gap-2 rounded-full border border-border bg-card py-2.5"
          >
            <View className="size-2 rounded-full bg-danger-foreground" />
            <Text className="font-t3-medium text-sm">Call on speaker</Text>
          </Pressable>
        </View>
      </View>

      {meetings.length > 0 ? (
        <>
          <Text className="px-5 pt-5 pb-1.5 font-t3-bold text-2xs uppercase tracking-[0.5px] text-foreground-muted">
            On this phone
          </Text>
          {meetings.map((meeting) => (
            <Pressable
              key={meeting.id}
              accessibilityRole="button"
              onPress={() => navigation.navigate("PhoneMeeting", { id: meeting.id })}
              className="flex-row items-center gap-3 px-5 py-2.5 active:bg-row-hover"
            >
              <View className="size-9 items-center justify-center rounded-[10px] bg-adaptive-emerald-500-a12-a16">
                <Text className="text-[17px]" style={{ fontFamily: SERIF_FONT }}>
                  {meeting.title.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View className="flex-1">
                <Text className="font-t3-medium text-[15px]" numberOfLines={1}>
                  {meeting.title}
                </Text>
                <Text className="mt-0.5 text-2xs text-foreground-muted" numberOfLines={1}>
                  {meetingDayLabel(meeting.startedAt)} {meetingTime(meeting.startedAt)} ·{" "}
                  {clockTime(meeting.durationSeconds)} ·{" "}
                  <Text
                    className={
                      meeting.syncedAt
                        ? "text-2xs text-foreground-muted"
                        : "text-2xs text-adaptive-amber-700-400"
                    }
                  >
                    {phoneMeetingStatus(meeting)}
                  </Text>
                </Text>
              </View>
            </Pressable>
          ))}
        </>
      ) : null}
    </View>
  );
}
