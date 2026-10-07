import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { GrButton, GrCard, GUTTER, SERIF, SPACE } from "../../design/granola";
import { meetingDayLabel, meetingTime } from "./meeting-notes";
import { MeetingDayLabel, MeetingRowView } from "./meeting-rows";
import {
  clockTime,
  resumePendingTranscriptions,
  usePhoneMeetings,
  type PhoneMeeting,
} from "./phone-meetings";

export function phoneMeetingStatus(meeting: PhoneMeeting): string {
  switch (meeting.transcription) {
    case "pending":
      return "Transcribing on the phone…";
    case "done":
      return meeting.syncedAt ? "On your Mac" : "Not on your Mac yet";
    case "unavailable":
      return "Transcribing needs iOS 26";
    case "failed":
      return "Could not transcribe";
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
      <View style={{ paddingHorizontal: GUTTER, paddingTop: SPACE.xs }}>
        <GrCard style={{ padding: SPACE.lg, gap: SPACE.md }}>
          <View style={{ gap: SPACE.xs }}>
            <Text className="text-[18px] leading-[22px] text-gr-ink" style={{ fontFamily: SERIF }}>
              Record a meeting
            </Text>
            <Text className="text-[13px] leading-[18px] text-gr-ink-2">
              Recorded and transcribed on this phone, even with no connection.
            </Text>
          </View>
          <View className="flex-row" style={{ gap: SPACE.sm }}>
            <GrButton
              grow
              label="In person"
              leading={<View className="size-2 rounded-full bg-gr-danger" />}
              onPress={() => navigation.navigate("MeetingRecord", { kind: "room" })}
            />
            <GrButton
              grow
              kind="secondary"
              label="Call on speaker"
              leading={<View className="size-2 rounded-full bg-gr-danger" />}
              onPress={() => navigation.navigate("MeetingRecord", { kind: "call" })}
            />
          </View>
        </GrCard>
      </View>

      {meetings.length > 0 ? (
        <>
          <MeetingDayLabel>On this phone</MeetingDayLabel>
          {meetings.map((meeting) => (
            <MeetingRowView
              key={meeting.id}
              title={meeting.title}
              details={`${meetingDayLabel(meeting.startedAt)} ${meetingTime(meeting.startedAt)} · ${clockTime(meeting.durationSeconds)}`}
              status={{
                text: phoneMeetingStatus(meeting),
                tone: meeting.syncedAt ? "quiet" : "attention",
              }}
              onPress={() => navigation.navigate("PhoneMeeting", { id: meeting.id })}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}
