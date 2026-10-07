import type { HistoryMeetingSummary } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GrInputSurface, RADIUS, SPACE } from "../../design/granola";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTuiVoiceNote } from "../tui/useTuiVoiceNote";
import { useTuiEnvironment } from "./use-tui-environment";

function newClientMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The home composer: say or type anything and tui decides where it goes
 * (a reply, a thread to start or continue, something to do on the Mac),
 * exactly as with push-to-talk. Hold the mic for a voice note. A meeting
 * being recorded rides on top of it.
 */
export function HomeDock(props: {
  readonly liveMeeting: HistoryMeetingSummary | null;
  readonly onOpenMeeting: (meeting: HistoryMeetingSummary) => void;
  readonly onFocusChange: (focused: boolean) => void;
}) {
  const navigation = useNavigation();
  const { environmentId } = useTuiEnvironment();
  const send = useAtomCommand(serverEnvironment.sendToTui, {
    label: "send to tui",
    reportFailure: false,
  });
  const voice = useTuiVoiceNote();
  const pressing = useRef(false);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "problem" } | null>(null);

  const deliver = async (input: {
    readonly text?: string;
    readonly voice?: { base64: string; mimeType: string; durationMs: number };
  }) => {
    if (!environmentId) {
      setNotice({ text: "Add your Mac in Settings to talk to tui.", tone: "problem" });
      return false;
    }
    setSending(true);
    setNotice(null);
    const result = await send({
      environmentId,
      input: { clientMessageId: newClientMessageId(), ...input },
    });
    setSending(false);
    if (result._tag === "Failure") {
      setNotice({
        text: "Could not reach Roost on the Mac. Check the connection and try again.",
        tone: "problem",
      });
      return false;
    }
    setNotice({ text: "Sent to tui", tone: "ok" });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return true;
  };

  const sendText = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (await deliver({ text })) setDraft("");
  };

  const micDown = async () => {
    pressing.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const started = await voice.start();
    // Released before the recorder came up: a tap, not a note.
    if (started && !pressing.current) await voice.finish();
  };
  const micUp = async () => {
    pressing.current = false;
    const note = await voice.finish();
    if (note) await deliver({ voice: note });
  };

  const hasText = draft.trim().length > 0;
  const problem = voice.error ?? (notice?.tone === "problem" ? notice.text : null);

  return (
    <GrInputSurface>
      <View
        style={{
          paddingHorizontal: SPACE.lg,
          paddingTop: SPACE.md,
          paddingBottom: SPACE.md,
          gap: SPACE.sm,
        }}
      >
        {props.liveMeeting ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${props.liveMeeting.title}, being recorded`}
            className="flex-row items-center gap-2.5 bg-gr-danger-tint px-3 py-2"
            style={{ borderRadius: RADIUS.control, marginHorizontal: -SPACE.xs }}
            onPress={() => props.liveMeeting && props.onOpenMeeting(props.liveMeeting)}
          >
            <View className="size-2 rounded-full bg-gr-danger" />
            <View className="flex-1">
              <Text className="font-t3-medium text-[14px] text-gr-ink" numberOfLines={1}>
                {props.liveMeeting.title}
              </Text>
              <Text className="text-[12px] text-gr-ink-2">Recording on the Mac</Text>
            </View>
            <SymbolView name="chevron.right" size={13} tintColorClassName="accent-gr-ink-3" />
          </Pressable>
        ) : null}

        <TextInput
          accessibilityLabel="Message tui"
          className="max-h-40 font-sans text-[16px] leading-6 text-gr-ink"
          style={{ minHeight: focused ? 96 : 24, paddingTop: 0, paddingBottom: 0 }}
          multiline
          placeholder={
            voice.recording ? "Listening… release to send" : "Message tui. It finds the thread."
          }
          placeholderTextColorClassName="accent-gr-ink-3"
          cursorColorClassName="accent-gr-accent"
          selectionColorClassName="accent-gr-accent-tint"
          value={draft}
          onChangeText={setDraft}
          onFocus={() => {
            setFocused(true);
            props.onFocusChange(true);
          }}
          onBlur={() => {
            setFocused(false);
            props.onFocusChange(false);
          }}
          submitBehavior="blurAndSubmit"
          returnKeyType="send"
          onSubmitEditing={() => void sendText()}
        />

        <View className="flex-row items-center gap-2">
          <View className="h-7 flex-row items-center gap-1 rounded-full border border-gr-hairline px-2.5">
            <SymbolView name="sparkles" size={11} tintColorClassName="accent-gr-ink-2" />
            <Text className="text-[12px] text-gr-ink-2">Auto</Text>
          </View>
          {notice?.tone === "ok" ? (
            <Pressable onPress={() => navigation.navigate("TuiInbox", undefined)} hitSlop={8}>
              <Text className="text-[12px] text-gr-ink-2">
                {notice.text} · <Text className="font-t3-medium text-[12px] text-gr-ink">Open</Text>
              </Text>
            </Pressable>
          ) : problem ? (
            <Text className="flex-1 text-[12px] text-gr-danger" numberOfLines={2}>
              {problem}
            </Text>
          ) : null}
          <View className="flex-1" />
          {hasText ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send to tui"
              disabled={sending}
              onPress={() => void sendText()}
              className="size-9 items-center justify-center rounded-full bg-gr-button"
              style={{ opacity: sending ? 0.5 : 1 }}
            >
              <SymbolView name="arrow.up" size={16} tintColorClassName="accent-gr-button-ink" />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hold to talk to tui"
              accessibilityHint="Hold, speak, and release to send a voice note"
              onPressIn={() => void micDown()}
              onPressOut={() => void micUp()}
              className={
                voice.recording
                  ? "size-9 items-center justify-center rounded-full bg-gr-bars"
                  : "size-9 items-center justify-center rounded-full bg-gr-button"
              }
            >
              <SymbolView
                name={voice.recording ? "waveform" : "mic"}
                size={16}
                tintColorClassName="accent-gr-button-ink"
              />
            </Pressable>
          )}
        </View>
      </View>
    </GrInputSurface>
  );
}
