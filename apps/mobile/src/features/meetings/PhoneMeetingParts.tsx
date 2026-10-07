import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { GrButton, GrCard, GUTTER, SERIF, SPACE } from "../../design/granola";
import { meetingDayLabel, meetingTime } from "./meeting-notes";
import { MeetingDayLabel, MeetingRowView } from "./meeting-rows";
import { usePhoneMeetingSending } from "./phone-meeting-sync";
import {
  clockTime,
  resumePendingTranscriptions,
  usePhoneMeetings,
  type PhoneMeeting,
} from "./phone-meetings";

/** Where a phone recording is: being transcribed, on its way, or on the Mac. */
export function phoneMeetingStatus(meeting: PhoneMeeting, sending: boolean): string {
  if (meeting.syncedAt) return "On your Mac";
  if (meeting.transcription === "pending") return "Transcribing on the phone…";
  if (sending) return "Sending to your Mac…";
  return "Sends when your Mac is reachable";
}

function PhoneMeetingRow(props: { readonly meeting: PhoneMeeting; readonly onPress: () => void }) {
  const { meeting } = props;
  const sending = usePhoneMeetingSending(meeting.id);
  return (
    <MeetingRowView
      title={meeting.title}
      details={`${meetingDayLabel(meeting.startedAt)} ${meetingTime(meeting.startedAt)} · ${clockTime(meeting.durationSeconds)}`}
      status={{
        text: phoneMeetingStatus(meeting, sending),
        tone: meeting.syncedAt ? "quiet" : "attention",
      }}
      onPress={props.onPress}
    />
  );
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
              Recorded and transcribed on this phone, even offline, then sent to your Mac.
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
              label="Call on another device"
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
            <PhoneMeetingRow
              key={meeting.id}
              meeting={meeting}
              onPress={() => navigation.navigate("PhoneMeeting", { id: meeting.id })}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}
