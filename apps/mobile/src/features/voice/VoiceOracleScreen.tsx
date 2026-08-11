import type { StaticScreenProps } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";
import {
  buildOracleInstructions,
  buildResumeContext,
  describeAgentActivity,
  executeVoiceOracleTool,
  truncateForVoice,
  VOICE_ORACLE_TOOLS,
  type VoiceOracleThreadView,
} from "@t3tools/client-runtime/voice/oracle";
import {
  RealtimeVoiceSession,
  type VoiceSessionStatus,
} from "@t3tools/client-runtime/voice/realtimeSession";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadSelection } from "../../state/use-thread-selection";
import { describeVoiceStartError, mintVoiceRealtimeSession } from "./mintVoiceSession";
import {
  isVoiceSpeakerphoneOn,
  reactNativeVoicePlatform,
  setVoiceSpeakerphone,
  stopVoiceAudioSession,
} from "./voicePlatform";

type VoiceOracleScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type OverlayPhase =
  | { readonly kind: "connecting" }
  | { readonly kind: "active"; readonly status: VoiceSessionStatus }
  | { readonly kind: "error"; readonly message: string; readonly notConfigured: boolean };

const STATUS_LABELS: Record<VoiceSessionStatus, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Ended",
  error: "Error",
};

export function VoiceOracleScreen({ route }: VoiceOracleScreenProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const threadState = useEnvironmentThread(environmentId, threadId);
  const thread = Option.getOrNull(threadState.data);
  const { selectedThread } = useThreadSelection();
  const shell = selectedThread?.id === threadId ? selectedThread : null;

  const [phase, setPhase] = useState<OverlayPhase>({ kind: "connecting" });
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [hangingUp, setHangingUp] = useState(false);
  const [captions, setCaptions] = useState<{ user: string | null; oracle: string | null }>({
    user: null,
    oracle: null,
  });

  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const viewRef = useRef<VoiceOracleThreadView>({
    threadTitle: thread?.title ?? "this thread",
    projectName: null,
    messages: thread?.messages ?? [],
    session: thread?.session ?? null,
    latestTurn: thread?.latestTurn ?? null,
  });
  viewRef.current = {
    threadTitle: thread?.title ?? "this thread",
    projectName: null,
    messages: thread?.messages ?? [],
    session: thread?.session ?? null,
    latestTurn: thread?.latestTurn ?? null,
  };

  const sendToAgent = useCallback(
    async (text: string): Promise<string | null> => {
      const currentShell = shell;
      if (!currentShell) {
        return "The thread settings are not available right now.";
      }
      const metadata = makeQueuedMessageMetadata();
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: MessageId.make(metadata.messageId),
            role: "user",
            text,
            attachments: [],
          },
          modelSelection: currentShell.modelSelection,
          runtimeMode: currentShell.runtimeMode,
          interactionMode: currentShell.interactionMode,
          commandId: CommandId.make(metadata.commandId),
          createdAt: metadata.createdAt,
        },
      });
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        return error instanceof Error ? error.message : "Failed to send the message.";
      }
      return null;
    },
    [environmentId, shell, startTurn, threadId],
  );
  const sendToAgentRef = useRef(sendToAgent);
  sendToAgentRef.current = sendToAgent;

  const voiceSessionRef = useRef<RealtimeVoiceSession | null>(null);
  const lastTurnRef = useRef<{ turnId: string | null; state: string | null }>({
    turnId: thread?.latestTurn?.turnId ?? null,
    state: thread?.latestTurn?.state ?? null,
  });

  useEffect(() => {
    let disposed = false;
    let voiceSession: RealtimeVoiceSession | null = null;

    const connect = async () => {
      try {
        const minted = await mintVoiceRealtimeSession(environmentId);
        if (disposed) return;
        voiceSession = await RealtimeVoiceSession.connect(
          {
            clientSecret: minted.clientSecret,
            model: minted.model,
            instructions: buildOracleInstructions(viewRef.current),
            tools: VOICE_ORACLE_TOOLS,
            openingContext: buildResumeContext(viewRef.current),
            onToolCall: (name, args, session) =>
              executeVoiceOracleTool({
                name,
                args,
                view: viewRef.current,
                sendToAgent: (text) => sendToAgentRef.current(text),
                endSession: () => {
                  setHangingUp(true);
                  session.requestHangUp();
                },
              }),
            onHangUp: () => {
              if (disposed) return;
              navigation.goBack();
            },
            onStatusChange: (status) => {
              if (disposed || status === "ended") return;
              setPhase((current) =>
                current.kind === "error" ? current : { kind: "active", status },
              );
            },
            onAssistantTranscript: (text) => {
              if (disposed) return;
              setCaptions((current) => ({ ...current, oracle: text }));
            },
            onUserTranscript: (text) => {
              if (disposed) return;
              setCaptions((current) => ({ ...current, user: text }));
            },
            onError: (message) => {
              if (disposed) return;
              setPhase({ kind: "error", message, notConfigured: false });
            },
          },
          reactNativeVoicePlatform,
        );
        if (disposed) {
          voiceSession.close();
          return;
        }
        voiceSessionRef.current = voiceSession;
        // The session picks the initial route (headphones win over speaker);
        // reflect whatever it chose so the toggle starts truthful.
        setSpeakerOn(isVoiceSpeakerphoneOn());
        lastTurnRef.current = {
          turnId: viewRef.current.latestTurn?.turnId ?? null,
          state: viewRef.current.latestTurn?.state ?? null,
        };
      } catch (error) {
        if (disposed) return;
        const described = describeVoiceStartError(error);
        setPhase({
          kind: "error",
          message: described.message,
          notConfigured: described.notConfigured,
        });
      }
    };
    void connect();

    return () => {
      disposed = true;
      voiceSessionRef.current = null;
      voiceSession?.close();
      stopVoiceAudioSession();
    };
  }, [environmentId, navigation]);

  // Report coding-agent turn transitions into the live voice conversation.
  const latestTurnId = thread?.latestTurn?.turnId ?? null;
  const latestTurnState = thread?.latestTurn?.state ?? null;
  useEffect(() => {
    const voiceSession = voiceSessionRef.current;
    const previous = lastTurnRef.current;
    if (previous.turnId === latestTurnId && previous.state === latestTurnState) return;
    lastTurnRef.current = { turnId: latestTurnId, state: latestTurnState };
    if (!voiceSession || latestTurnId === null || latestTurnState === null) return;

    if (latestTurnState === "running") {
      if (previous.turnId !== latestTurnId) {
        voiceSession.injectContext("The coding agent started working on a new turn.");
      }
      return;
    }
    const wasRunningTurn = previous.turnId === latestTurnId && previous.state === "running";
    if (!wasRunningTurn) return;

    const lastAssistantText = viewRef.current.messages
      .toReversed()
      .find((message) => message.role === "assistant" && message.text.trim().length > 0)?.text;
    const outcome =
      latestTurnState === "completed"
        ? "finished its turn"
        : latestTurnState === "error"
          ? "stopped with an error"
          : "was interrupted";
    voiceSession.injectContext(
      [
        `The coding agent ${outcome}.`,
        lastAssistantText
          ? `Its final message was:\n${truncateForVoice(lastAssistantText, 1_500)}`
          : "It left no final message.",
        "Briefly tell the user what happened, then ask if they want anything else. If they don't, hang up with end_voice_session.",
      ].join("\n"),
      { respond: true },
    );
  }, [latestTurnId, latestTurnState]);

  // Orb: gentle status-driven pulse while the session is live.
  const orbScale = useSharedValue(1);
  const status = phase.kind === "active" ? phase.status : "connecting";
  useEffect(() => {
    cancelAnimation(orbScale);
    if (status === "speaking" || status === "thinking") {
      const amplitude = status === "speaking" ? 1.12 : 1.05;
      const duration = status === "speaking" ? 420 : 900;
      orbScale.value = withRepeat(
        withTiming(amplitude, { duration, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      orbScale.value = withTiming(1, { duration: 350 });
    }
  }, [orbScale, status]);
  const orbStyle = useAnimatedStyle(() => ({ transform: [{ scale: orbScale.value }] }));

  const agentActivity = describeAgentActivity(viewRef.current);

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      voiceSessionRef.current?.setMuted(next);
      return next;
    });
  }, []);

  const toggleSpeaker = useCallback(() => {
    setSpeakerOn((current) => {
      const next = !current;
      setVoiceSpeakerphone(next);
      return next;
    });
  }, []);

  const endSession = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  return (
    <View
      className="bg-screen flex-1 items-center justify-between"
      style={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }}
    >
      <View className="items-center px-6">
        <Text className="font-t3-bold text-foreground text-base" numberOfLines={1}>
          {viewRef.current.threadTitle}
        </Text>
        <Text className="text-foreground-muted mt-1 text-xs">
          {agentActivity.label}
          {agentActivity.working ? "…" : ""}
        </Text>
      </View>

      <View className="items-center px-8">
        <View className="items-center justify-center">
          <Animated.View className="bg-primary/20 absolute size-56 rounded-full" style={orbStyle} />
          <Animated.View className="bg-primary size-36 rounded-full" style={orbStyle} />
        </View>
        <Text className="text-foreground-muted mt-8 text-xs uppercase tracking-widest">
          {hangingUp ? "Wrapping up" : STATUS_LABELS[status]}
        </Text>
        {phase.kind === "error" ? (
          <Text className="text-danger mt-4 text-center text-sm">
            {phase.message}
            {phase.notConfigured
              ? "\nAdd an OpenAI API key in this environment's Settings → Voice."
              : ""}
          </Text>
        ) : (
          <>
            {captions.user ? (
              <Text className="text-foreground-muted mt-4 text-center text-sm" numberOfLines={2}>
                “{captions.user}”
              </Text>
            ) : null}
            {captions.oracle ? (
              <Text className="text-foreground mt-3 text-center text-base" numberOfLines={6}>
                {captions.oracle}
              </Text>
            ) : null}
          </>
        )}
      </View>

      <View className="flex-row items-center gap-6">
        <ControlPill
          icon={muted ? "mic.slash" : "mic"}
          accessibilityLabel={muted ? "Unmute microphone" : "Mute microphone"}
          variant={muted ? "danger" : "circle"}
          disabled={phase.kind !== "active"}
          onPress={toggleMuted}
        />
        <ControlPill
          icon={speakerOn ? "speaker.wave.2.fill" : "airpods"}
          accessibilityLabel={speakerOn ? "Use headphones" : "Use speaker"}
          variant="circle"
          disabled={phase.kind !== "active"}
          onPress={toggleSpeaker}
        />
        <ControlPill
          icon="xmark"
          accessibilityLabel="End voice session"
          variant="danger"
          onPress={endSession}
        />
      </View>
    </View>
  );
}
