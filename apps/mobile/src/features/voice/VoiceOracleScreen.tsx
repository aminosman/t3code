import type { StaticScreenProps } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";
import {
  buildOracleInstructions,
  buildResumeContext,
  describeAgentActivity,
  executeVoiceOracleTool,
  isRunActive,
  voiceOracleThreadView,
  truncateForVoice,
  VOICE_ORACLE_TOOLS,
} from "@t3tools/client-runtime/voice/oracle";
import {
  RealtimeVoiceSession,
  type VoiceSessionStatus,
} from "@t3tools/client-runtime/voice/realtimeSession";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
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

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { uuidv4 } from "../../lib/uuid";
import { recordLocalDiagnostic, recordLocalDiagnosticError } from "../diagnostics/localDiagnostics";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadSelection } from "../../state/use-thread-selection";
import { describeVoiceStartError, mintVoiceRealtimeSession } from "./mintVoiceSession";
import { currentVoiceAudioSession } from "./nativeVoiceDiagnostics";
import {
  isVoiceSpeakerphoneOn,
  reactNativeVoicePlatform,
  setVoiceSpeakerphone,
  stopVoiceAudioSession,
  subscribeVoiceSpeakerphone,
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
  const [externalAudio, setExternalAudio] = useState(false);
  const [hangingUp, setHangingUp] = useState(false);
  const [voiceSessionId] = useState(() => uuidv4());
  const [captions, setCaptions] = useState<{ user: string | null; oracle: string | null }>({
    user: null,
    oracle: null,
  });

  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const view = voiceOracleThreadView({
    threadTitle: shell?.title ?? "this thread",
    projectName: null,
    projection: thread,
    shell,
  });
  const readView = useEffectEvent(() => view);

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
  const sendCurrentToAgent = useEffectEvent(sendToAgent);

  const voiceSessionRef = useRef<RealtimeVoiceSession | null>(null);
  const lastTurnRef = useRef<{ turnId: string | null; state: string | null }>({
    turnId: view.latestRun?.runId ?? null,
    state: view.latestRun?.status ?? null,
  });

  const reflectConnectedSession = useEffectEvent(() => {
    setSpeakerOn(isVoiceSpeakerphoneOn());
    setExternalAudio(currentVoiceAudioSession()?.hasExternalAudioDevice ?? false);
    lastTurnRef.current = {
      turnId: view.latestRun?.runId ?? null,
      state: view.latestRun?.status ?? null,
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to native audio route changes.
  useEffect(
    () =>
      subscribeVoiceSpeakerphone((enabled, externalOutput) => {
        setSpeakerOn(enabled);
        setExternalAudio(externalOutput);
      }),
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the realtime voice connection and close it on unmount.
  useEffect(() => {
    let disposed = false;
    let voiceSession: RealtimeVoiceSession | null = null;

    const connect = async () => {
      recordLocalDiagnostic("voice.connect_started", { voiceSessionId });
      try {
        const minted = await mintVoiceRealtimeSession(environmentId);
        recordLocalDiagnostic("voice.session_minted", { voiceSessionId, model: minted.model });
        if (disposed) return;
        voiceSession = await RealtimeVoiceSession.connect(
          {
            clientSecret: minted.clientSecret,
            model: minted.model,
            instructions: buildOracleInstructions(readView()),
            tools: VOICE_ORACLE_TOOLS,
            openingContext: buildResumeContext(readView()),
            onDiagnosticEvent: (event, fields) => {
              recordLocalDiagnostic(event, { voiceSessionId, ...fields });
            },
            onToolCall: (name, args, session) =>
              executeVoiceOracleTool({
                name,
                args,
                view: readView(),
                sendToAgent: (text) => sendCurrentToAgent(text),
                endSession: () => {
                  setHangingUp(true);
                  session.requestHangUp();
                },
              }),
            onHangUp: () => {
              recordLocalDiagnostic("voice.hang_up_callback", { voiceSessionId });
              if (disposed) return;
              navigation.goBack();
            },
            onStatusChange: (status) => {
              recordLocalDiagnostic("voice.status_changed", { voiceSessionId, status });
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
              recordLocalDiagnostic("voice.error", { voiceSessionId, message });
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
        recordLocalDiagnostic("voice.connected", { voiceSessionId });
        // The session picks the initial route (headphones win over speaker);
        // reflect whatever it chose so the toggle starts truthful.
        reflectConnectedSession();
      } catch (error) {
        recordLocalDiagnosticError("voice.connect_failed", error);
        if (disposed) return;
        stopVoiceAudioSession();
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
      recordLocalDiagnostic("voice.screen_closed", { voiceSessionId });
      voiceSessionRef.current = null;
      voiceSession?.close();
      stopVoiceAudioSession();
    };
  }, [environmentId, navigation, voiceSessionId]);

  // Report coding-agent turn transitions into the live voice conversation.
  const latestTurnId = view.latestRun?.runId ?? null;
  const latestTurnState = view.latestRun?.status ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Inject coding-agent turn transitions into the live voice connection.
  useEffect(() => {
    const voiceSession = voiceSessionRef.current;
    const previous = lastTurnRef.current;
    if (previous.turnId === latestTurnId && previous.state === latestTurnState) return;
    lastTurnRef.current = { turnId: latestTurnId, state: latestTurnState };
    if (!voiceSession || latestTurnId === null || latestTurnState === null) return;

    if (isRunActive(latestTurnState)) {
      if (previous.turnId !== latestTurnId) {
        voiceSession.injectContext("The coding agent started working on a new turn.");
      }
      return;
    }
    const wasRunningTurn = previous.turnId === latestTurnId && isRunActive(previous.state);
    if (!wasRunningTurn) return;

    const lastAssistantText = [...readView().messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.text.trim().length > 0)?.text;
    const outcome =
      latestTurnState === "completed"
        ? "finished its turn"
        : latestTurnState === "failed"
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Drive the native voice orb animation from session status.
  useEffect(() => {
    cancelAnimation(orbScale);
    if (status === "speaking" || status === "thinking") {
      const amplitude = status === "speaking" ? 1.12 : 1.05;
      const duration = status === "speaking" ? 420 : 900;
      orbScale.set(
        withRepeat(
          withTiming(amplitude, { duration, easing: Easing.inOut(Easing.quad) }),
          -1,
          true,
        ),
      );
    } else {
      orbScale.set(withTiming(1, { duration: 350 }));
    }
  }, [orbScale, status]);
  const orbStyle = useAnimatedStyle(() => ({ transform: [{ scale: orbScale.value }] }));

  const agentActivity = describeAgentActivity(view);

  const toggleMuted = () => {
    const next = !muted;
    voiceSessionRef.current?.setMuted(next);
    setMuted(next);
  };

  const toggleSpeaker = () => {
    const next = !speakerOn;
    setVoiceSpeakerphone(next);
    setSpeakerOn(next);
  };

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
          {view.threadTitle}
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
          icon={speakerOn ? "speaker.wave.2.fill" : externalAudio ? "airpods" : "iphone"}
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
