import type { HistoryMeetingSummary } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTuiVoiceNote } from "../tui/useTuiVoiceNote";
import { useTuiEnvironment } from "./use-tui-environment";

function newClientMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const SERIF_FONT = Platform.select({ ios: "ui-serif", default: "serif" });

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
    <GlassSurface
      className="mx-2.5 overflow-hidden rounded-[26px] border border-border"
      fallbackClassName="bg-card"
    >
      <View className="gap-2 px-3.5 pt-3 pb-2.5">
        {props.liveMeeting ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${props.liveMeeting.title}, being recorded`}
            className="-mx-1 flex-row items-center gap-2.5 rounded-2xl bg-adaptive-emerald-500-a12-a16 px-3 py-2"
            onPress={() => props.liveMeeting && props.onOpenMeeting(props.liveMeeting)}
          >
            <View className="size-2 rounded-full bg-danger-foreground" />
            <View className="flex-1">
              <Text className="font-t3-medium text-sm" numberOfLines={1}>
                {props.liveMeeting.title}
              </Text>
              <Text className="text-2xs text-foreground-muted">Recording on the Mac</Text>
            </View>
            <SymbolView name="chevron.right" size={13} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}

        <TextInput
          accessibilityLabel="Message tui"
          className="max-h-40 font-sans text-[17px] leading-6 text-foreground"
          style={{ minHeight: focused ? 96 : 28 }}
          multiline
          placeholder={
            voice.recording ? "Listening… release to send" : "Message tui. It finds the thread."
          }
          placeholderTextColorClassName="accent-placeholder"
          cursorColorClassName="accent-focus"
          selectionColorClassName="accent-focus/32"
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
          <View className="flex-row items-center gap-1 rounded-full bg-subtle px-2.5 py-1">
            <SymbolView name="sparkles" size={11} tintColorClassName="accent-icon-muted" />
            <Text className="text-2xs text-foreground-muted">Auto</Text>
          </View>
          {notice?.tone === "ok" ? (
            <Pressable onPress={() => navigation.navigate("TuiInbox", undefined)} hitSlop={8}>
              <Text className="text-2xs text-foreground-muted">
                {notice.text} · <Text className="font-t3-medium text-2xs">Open</Text>
              </Text>
            </Pressable>
          ) : problem ? (
            <Text className="flex-1 text-2xs text-danger-foreground" numberOfLines={2}>
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
              className="size-10 items-center justify-center rounded-full bg-primary"
              style={{ opacity: sending ? 0.5 : 1 }}
            >
              <SymbolView
                name="arrow.up"
                size={17}
                tintColorClassName="accent-primary-foreground"
              />
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
                  ? "size-11 items-center justify-center rounded-full bg-adaptive-emerald-600-400"
                  : "size-11 items-center justify-center rounded-full bg-foreground"
              }
            >
              <SymbolView
                name={voice.recording ? "waveform" : "mic"}
                size={18}
                tintColorClassName="accent-screen"
              />
            </Pressable>
          )}
        </View>
      </View>
    </GlassSurface>
  );
}
