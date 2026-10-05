import { EnvironmentId, type TuiInboxEntry } from "@t3tools/contracts";
import { EMPTY_TUI_INBOX } from "@t3tools/client-runtime/tui-inbox";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";
import { RequestActionButton } from "../threads/RequestActionButton";
import { useTuiVoiceNote } from "./useTuiVoiceNote";

type TuiInboxScreenProps = StaticScreenProps<{ readonly environmentId?: string } | undefined>;

/** The environment last talked to, so the screen reopens on it. */
let lastEnvironmentId: string | null = null;

function newClientMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Talk to tui, the Mac's voice assistant, from no thread at all: type or
 * hold the mic, and tui decides what it is — a reply, a thread to start or
 * continue, something to do on the Mac — exactly as it does for push-to-talk.
 * A card that waits for ↑ before acting shows here with Allow / Decline,
 * and arrives as a push when the app is closed.
 */
export function TuiInboxScreen({ route }: TuiInboxScreenProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { environments: workspaceEnvironments } = useWorkspaceState();
  const environments = useMemo(() => {
    const state = new Map(
      workspaceEnvironments.map((environment) => [
        environment.environmentId,
        environment.connectionState,
      ]),
    );
    return Object.values(savedConnectionsById)
      .map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connected: state.get(connection.environmentId) === "connected",
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [savedConnectionsById, workspaceEnvironments]);

  const requested = route.params?.environmentId;
  // A push names the environment that asked; otherwise a chip the user
  // tapped, then the one talked to last.
  const [picked, setChosen] = useState<string | null>(null);
  const chosen = requested ?? picked ?? lastEnvironmentId;
  // A push names the Mac that asked: if that one is not here, say so rather
  // than talk to another Mac by mistake.
  const missingRequested =
    requested !== undefined &&
    !environments.some((candidate) => candidate.environmentId === requested);
  const environment = missingRequested
    ? null
    : (environments.find((candidate) => candidate.environmentId === chosen) ??
      environments.find((candidate) => candidate.connected) ??
      environments[0] ??
      null);
  const environmentId = environment ? EnvironmentId.make(environment.environmentId) : null;
  useEffect(() => {
    if (environmentId) lastEnvironmentId = environmentId;
  }, [environmentId]);

  const inbox =
    useEnvironmentQuery(
      environmentId ? serverEnvironment.tuiInbox({ environmentId, input: {} }) : null,
    ).data ?? EMPTY_TUI_INBOX;
  const send = useAtomCommand(serverEnvironment.sendToTui, {
    label: "send to tui",
    reportFailure: false,
  });
  const control = useAtomCommand(serverEnvironment.controlTui, {
    label: "answer tui",
    reportFailure: false,
  });

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const voice = useTuiVoiceNote();
  const pressing = useRef(false);

  const deliver = async (input: {
    readonly text?: string;
    readonly voice?: { base64: string; mimeType: string; durationMs: number };
  }) => {
    if (!environmentId) return;
    setSending(true);
    setProblem(null);
    const result = await send({
      environmentId,
      input: { clientMessageId: newClientMessageId(), ...input },
    });
    setSending(false);
    if (result._tag === "Failure") {
      setProblem("Could not reach Roost on the Mac. Check the connection and try again.");
      return false;
    }
    return true;
  };

  const sendText = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await deliver({ text })) setDraft("");
  };

  const micDown = async () => {
    pressing.current = true;
    const started = await voice.start();
    // Released before the recorder came up: a tap, not a note.
    if (started && !pressing.current) await voice.finish();
  };
  const micUp = async () => {
    pressing.current = false;
    const note = await voice.finish();
    if (note) await deliver({ voice: note });
  };

  const answer = async (promptId: string, verdict: "up" | "down") => {
    if (!environmentId) return;
    const result = await control({ environmentId, input: { type: "verdict", promptId, verdict } });
    if (result._tag === "Failure") setProblem("That answer did not reach tui.");
  };
  const stop = async () => {
    if (!environmentId) return;
    await control({ environmentId, input: { type: "stop" } });
  };

  const scroller = useRef<ScrollViewInstance>(null);
  const openPromptIds = new Set(inbox.openPrompts.map((prompt) => prompt.promptId));

  return (
    <>
      <NativeStackScreenOptions options={{ title: "tui", headerShown: true }} />
      <KeyboardAvoidingView
        className="flex-1 bg-screen"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}
      >
        {environments.length > 1 ? (
          <ScrollView
            horizontal
            className="max-h-12 flex-none px-3 pt-2"
            contentContainerClassName="gap-2"
            showsHorizontalScrollIndicator={false}
          >
            {environments.map((candidate) => (
              <Pressable
                key={candidate.environmentId}
                onPress={() => {
                  setChosen(candidate.environmentId);
                  if (requested) navigation.setParams({ environmentId: undefined } as never);
                }}
                className={`rounded-full border px-3 py-1.5 ${
                  candidate.environmentId === environment?.environmentId
                    ? "border-primary bg-primary"
                    : "border-border bg-card"
                }`}
              >
                <Text
                  className={`font-sans text-sm ${
                    candidate.environmentId === environment?.environmentId
                      ? "text-primary-foreground"
                      : "text-foreground"
                  }`}
                >
                  {candidate.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <Text className="px-4 pt-2 font-sans text-xs text-foreground-secondary">
          {missingRequested
            ? "The Mac that sent this isn't among your environments on this phone."
            : environment === null
              ? "Add the Mac that runs tui under Settings › Environments."
              : inbox.hostConnected
                ? `tui is listening on ${environment.label}.`
                : `tui isn't connected on ${environment.label}. Notes you send now wait 10 minutes for it.`}
        </Text>

        <ScrollView
          ref={scroller}
          className="flex-1"
          contentContainerClassName="gap-2.5 px-4 py-3"
          onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
          keyboardDismissMode="interactive"
        >
          {inbox.entries.length === 0 ? (
            <Text className="pt-10 text-center font-sans text-sm leading-5 text-foreground-secondary">
              Say or type anything you would say to tui at the desk: "what's running?", "tell the
              Roost thread to ship it", "print the open document". It asks before it acts, here.
            </Text>
          ) : null}
          {inbox.entries.map((entry) => (
            <TuiEntryRow
              key={entry.id}
              entry={entry}
              open={entry.post?.type === "prompt" && openPromptIds.has(entry.post.promptId)}
              onAnswer={answer}
            />
          ))}
        </ScrollView>

        {inbox.running || inbox.busy ? (
          <View className="mx-4 mb-2 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
            <View className="flex-1">
              <Text className="font-t3-bold text-sm text-foreground" numberOfLines={1}>
                {inbox.running ? inbox.running.goal : "tui is working…"}
              </Text>
              {inbox.running?.step ? (
                <Text className="font-sans text-xs text-foreground-secondary" numberOfLines={1}>
                  {inbox.running.step}
                </Text>
              ) : null}
            </View>
            <RequestActionButton label="Stop" tone="danger" onPress={() => void stop()} />
          </View>
        ) : null}

        {problem || voice.error ? (
          <Text className="px-4 pb-1 font-sans text-xs text-danger">{problem ?? voice.error}</Text>
        ) : null}

        <View
          className="flex-row items-end gap-2 border-t border-border px-3 pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <AppTextInput
            className="max-h-32 min-h-10 flex-1 py-2"
            placeholder={voice.recording ? "Recording… release to send" : "Message tui"}
            value={draft}
            onChangeText={setDraft}
            multiline
            editable={!voice.recording && environmentId !== null}
          />
          {draft.trim().length > 0 ? (
            <Pressable
              accessibilityLabel="Send to tui"
              disabled={sending || environmentId === null}
              onPress={() => void sendText()}
              className="h-10 w-10 items-center justify-center rounded-full bg-primary"
            >
              <SymbolView
                name="arrow.up"
                size={18}
                tintColorClassName="accent-primary-foreground"
              />
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel="Hold to record a voice note for tui"
              disabled={sending || environmentId === null}
              onPressIn={() => void micDown()}
              onPressOut={() => void micUp()}
              className={`h-10 w-10 items-center justify-center rounded-full ${
                voice.recording ? "bg-danger" : "bg-primary"
              }`}
            >
              <SymbolView
                name={voice.recording ? "waveform" : "mic"}
                size={18}
                tintColorClassName="accent-primary-foreground"
              />
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

function TuiEntryRow(props: {
  readonly entry: TuiInboxEntry;
  readonly open: boolean;
  readonly onAnswer: (promptId: string, verdict: "up" | "down") => void;
}) {
  const { entry } = props;
  if (entry.from === "me") {
    const utterance = entry.utterance;
    const label = utterance?.text ?? (utterance?.voice ? "Voice note" : "");
    return (
      <View className="max-w-[85%] self-end rounded-2xl bg-primary px-3.5 py-2">
        <Text className="font-sans text-base text-primary-foreground">
          {utterance?.voice && !utterance.text
            ? `🎙 ${label}${utterance.durationMs ? ` · ${Math.round(utterance.durationMs / 1000)}s` : ""}`
            : label}
        </Text>
      </View>
    );
  }
  const post = entry.post;
  if (!post) return null;
  switch (post.type) {
    case "heard":
      return (
        <Text className="self-end px-1 font-sans text-xs italic text-foreground-secondary">
          heard “{post.text}”
        </Text>
      );
    case "say":
      return (
        <View className="max-w-[85%] self-start rounded-2xl bg-card px-3.5 py-2">
          <Text className="font-sans text-base text-foreground">{post.text}</Text>
        </View>
      );
    case "show":
      return (
        <Text className="self-start px-1 font-sans text-sm text-foreground-secondary">
          {post.text}
        </Text>
      );
    case "prompt": {
      const rating = post.kind === "rate";
      const lines = post.text
        .split("\n")
        .filter((line) => !line.startsWith("↑ "))
        .join("\n");
      return (
        <View className="gap-2.5 self-stretch rounded-[20px] border border-border bg-card-alt p-4">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
            {rating ? "Was that right?" : "tui is asking"}
          </Text>
          <Text className="font-sans text-base leading-normal text-foreground">{lines}</Text>
          {props.open ? (
            <View className="flex-row flex-wrap gap-2.5">
              <RequestActionButton
                label={rating ? "Right" : "Allow"}
                tone="primary"
                onPress={() => props.onAnswer(post.promptId, "up")}
              />
              <RequestActionButton
                label={rating ? "Wrong" : "Decline"}
                tone={rating ? "secondary" : "danger"}
                onPress={() => props.onAnswer(post.promptId, "down")}
              />
            </View>
          ) : null}
        </View>
      );
    }
    case "settled":
      return (
        <Text className="self-start px-1 font-sans text-xs text-foreground-secondary">
          {post.outcome === "up"
            ? "↑ allowed"
            : post.outcome === "down"
              ? "↓ declined"
              : "no answer in time"}
        </Text>
      );
    case "hands":
      return post.phase === "step" ? null : (
        <Text className="self-start px-1 font-sans text-sm text-foreground-secondary">
          {post.phase === "start"
            ? `▶︎ ${post.text}`
            : `${post.ok === false ? "✕" : "✓"} ${post.text}`}
        </Text>
      );
    case "done":
      return null;
  }
}
