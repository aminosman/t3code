import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
} from "expo-audio";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { normalizeVoiceInputDecibels } from "../voice-input/voiceInputMetering";
import { GrChip, GUTTER, RADIUS, SERIF } from "../../design/granola";
import {
  clockTime,
  defaultMeetingTitle,
  newPhoneMeetingId,
  phoneMeetingAudioUri,
  savePhoneMeeting,
  transcribePhoneMeeting,
  type PhoneMeetingKind,
} from "./phone-meetings";

type RecordMeetingScreenProps = StaticScreenProps<{ readonly kind?: PhoneMeetingKind } | undefined>;

// Speech quality: mono at 24 kHz, about 20 MB an hour, so long meetings send
// quickly to the Mac; both transcribers resample to 16 kHz anyway.
const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 24_000,
  numberOfChannels: 1,
  bitRate: 48_000,
  isMeteringEnabled: true,
};
const BAR_COUNT = 9;
/** The bars are fixed positions in a row; they are keyed by position name. */
const BAR_KEYS = Array.from({ length: BAR_COUNT }, (_, slot) => `bar-${slot}`);

async function releaseAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    await setIsAudioActiveAsync(false);
  }
}

/**
 * Recording a meeting on the phone: everything stays on the device while it
 * runs — the audio, the user's typed notes — and is transcribed on the device
 * after Stop, so no connection is needed. The screen stays awake while it
 * records.
 */
export function RecordMeetingScreen({ route }: RecordMeetingScreenProps) {
  useKeepAwake();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const kind: PhoneMeetingKind = route.params?.kind === "call" ? "call" : "room";
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const [openedAt] = useState(() => new Date());
  const [id] = useState(() => newPhoneMeetingId(openedAt));
  // Set when the recorder actually starts, which may be a moment after opening.
  const startedAt = useRef(openedAt);
  const [title, setTitle] = useState(() => defaultMeetingTitle(kind, openedAt));
  const [notes, setNotes] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<ReadonlyArray<number>>(() => Array(BAR_COUNT).fill(0));
  const [phase, setPhase] = useState<"starting" | "recording" | "saving" | "failed">("starting");
  const [problem, setProblem] = useState<string | null>(null);
  const stopping = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setPhase("failed");
        setProblem(
          "Microphone access is off for Roost. Turn it on in Settings to record meetings.",
        );
        return;
      }
      try {
        await setAudioModeAsync({
          allowsRecording: true,
          interruptionMode: "doNotMix",
          playsInSilentMode: true,
          shouldPlayInBackground: false,
        });
        await setIsAudioActiveAsync(true);
        await recorder.prepareToRecordAsync();
        if (cancelled) return;
        recorder.record();
        startedAt.current = new Date();
        setPhase("recording");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (cause) {
        setPhase("failed");
        setProblem(cause instanceof Error ? cause.message : "Could not start recording.");
        await releaseAudio().catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recorder]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      const status = recorder.getStatus();
      setSeconds(Math.floor(status.durationMillis / 1000));
      const level = normalizeVoiceInputDecibels(status.metering);
      setLevels((previous) => [...previous.slice(1), level]);
    }, 120);
    return () => clearInterval(timer);
  }, [phase, recorder]);

  const stop = async () => {
    if (stopping.current || phase !== "recording") return;
    stopping.current = true;
    setPhase("saving");
    const durationSeconds = Math.round(recorder.getStatus().durationMillis / 1000);
    try {
      await recorder.stop();
      await releaseAudio().catch(() => undefined);
      const source = recorder.uri;
      if (!source) throw new Error("The recording was not saved.");
      const { File } = await import("expo-file-system");
      new File(source).move(new File(await phoneMeetingAudioUri(id)));
      await savePhoneMeeting({
        id: id,
        title: title.trim() || defaultMeetingTitle(kind, startedAt.current),
        kind,
        startedAt: startedAt.current.toISOString(),
        durationSeconds,
        myNotes: notes,
        transcription: "pending",
        transcript: [],
        syncedAt: null,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void transcribePhoneMeeting(id);
      navigation.goBack();
    } catch (cause) {
      stopping.current = false;
      setPhase("failed");
      setProblem(cause instanceof Error ? cause.message : "Could not save the recording.");
    }
  };

  const discard = () => {
    Alert.alert("Discard this recording?", "The audio and your notes are deleted.", [
      { text: "Keep recording", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          stopping.current = true;
          void recorder
            .stop()
            .catch(() => undefined)
            .then(() => releaseAudio().catch(() => undefined))
            .then(() => navigation.goBack());
        },
      },
    ]);
  };

  const chips = [
    openedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    kind === "call" ? "Call on another device" : "In person",
  ];

  return (
    <View className="flex-1 bg-gr-surface" style={{ paddingTop: insets.top + 8 }}>
      <NativeStackScreenOptions options={{ headerShown: false, gestureEnabled: false }} />
      <View className="flex-row items-center justify-between" style={{ paddingHorizontal: GUTTER }}>
        <Pressable
          accessibilityRole="button"
          onPress={phase === "failed" ? () => navigation.goBack() : discard}
          hitSlop={10}
          className="rounded-full bg-gr-sunken px-3 py-1.5"
        >
          <Text className="text-xs text-gr-ink-2-strong">
            {phase === "failed" ? "Close" : "Discard"}
          </Text>
        </Pressable>
        <View className="flex-row items-center gap-1.5">
          <View
            className={
              phase === "recording"
                ? "size-2 rounded-full bg-gr-danger"
                : "size-2 rounded-full bg-gr-button-tertiary"
            }
          />
          <Text className="text-2xs text-gr-ink-2">
            {phase === "recording"
              ? "Recording on this phone"
              : phase === "saving"
                ? "Saving…"
                : phase === "starting"
                  ? "Starting…"
                  : "Not recording"}
          </Text>
        </View>
        <View className="w-16" />
      </View>

      <View className="flex-1" style={{ paddingHorizontal: GUTTER, paddingTop: 16 }}>
        <TextInput
          accessibilityLabel="Meeting title"
          className="text-[28px] leading-[34px] text-gr-ink"
          style={{ fontFamily: SERIF }}
          value={title}
          onChangeText={setTitle}
          returnKeyType="done"
          cursorColorClassName="accent-gr-accent"
        />
        <View className="mt-3 flex-row flex-wrap gap-1.5">
          {chips.map((chip) => (
            <GrChip key={chip}>{chip}</GrChip>
          ))}
        </View>
        <TextInput
          accessibilityLabel="Your notes"
          className="mt-5 flex-1 font-sans text-[16px] leading-6 text-gr-ink"
          style={{ textAlignVertical: "top" }}
          multiline
          placeholder="Type your notes. They are kept with the recording, in your words."
          placeholderTextColorClassName="accent-gr-ink-3"
          cursorColorClassName="accent-gr-accent"
          value={notes}
          onChangeText={setNotes}
        />
        {problem ? <Text className="pb-3 text-sm text-gr-danger">{problem}</Text> : null}
      </View>

      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom - 8 }}>
        <View
          className="flex-row items-center gap-3 bg-gr-button py-2 pr-2 pl-5"
          style={{
            marginHorizontal: GUTTER,
            borderRadius: RADIUS.panel,
            marginBottom: Math.max(12, insets.bottom),
          }}
        >
          <View className="h-5 flex-row items-center gap-[3px]">
            {BAR_KEYS.map((key, slot) => (
              <View
                key={key}
                className={
                  phase === "recording"
                    ? "w-[3px] rounded-full bg-gr-bars"
                    : "w-[3px] rounded-full bg-gr-ink-3"
                }
                style={{
                  height: 4 + (levels[slot] ?? 0) * 16,
                }}
              />
            ))}
          </View>
          <Text
            className="font-t3-medium text-[15px] text-gr-button-ink"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {clockTime(seconds)}
          </Text>
          <View className="flex-1" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop and save"
            disabled={phase !== "recording"}
            onPress={() => void stop()}
            className="size-11 items-center justify-center rounded-full bg-gr-danger"
            style={{ opacity: phase === "recording" ? 1 : 0.5 }}
          >
            <View className="size-3.5 rounded-[3px] bg-white" />
          </Pressable>
        </View>
      </KeyboardStickyView>
    </View>
  );
}
