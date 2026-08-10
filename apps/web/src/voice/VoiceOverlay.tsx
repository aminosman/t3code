import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MicIcon, MicOffIcon, SettingsIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../components/ui/button";
import { describeVoiceMintError, mintVoiceRealtimeSession } from "./mintVoiceSession";
import { RealtimeVoiceSession, type VoiceSessionStatus } from "./realtimeVoiceSession";
import {
  buildOracleInstructions,
  buildResumeContext,
  describeAgentActivity,
  executeVoiceOracleTool,
  truncateForVoice,
  VOICE_ORACLE_TOOLS,
  type VoiceOracleThreadView,
} from "./voiceOracle";

interface VoiceOverlayProps {
  environmentId: EnvironmentId;
  threadTitle: string;
  projectName: string | null;
  messages: ReadonlyArray<OrchestrationMessage>;
  session: OrchestrationSession | null;
  latestTurn: OrchestrationLatestTurn | null;
  /** Sends a message to the coding agent; resolves to an error message or null. */
  onSendToAgent: (text: string) => Promise<string | null>;
  onClose: () => void;
}

type OverlayPhase =
  | { readonly kind: "connecting" }
  | { readonly kind: "active"; readonly status: VoiceSessionStatus }
  | { readonly kind: "not-configured"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

interface CaptionState {
  readonly user: string | null;
  readonly oracle: string | null;
  readonly oracleDone: boolean;
}

const STATUS_LABELS: Record<VoiceSessionStatus, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Ended",
  error: "Error",
};

const ORB_LEVEL_EPSILON = 0.015;

export const VoiceOverlay = memo(function VoiceOverlay({
  environmentId,
  threadTitle,
  projectName,
  messages,
  session,
  latestTurn,
  onSendToAgent,
  onClose,
}: VoiceOverlayProps) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<OverlayPhase>({ kind: "connecting" });
  // Set only once voiceSessionRef is assigned; "listening" can arrive from the
  // data channel before connect() resolves, so phase alone can't gate effects
  // that need the session object.
  const [sessionReady, setSessionReady] = useState(false);
  const [hangingUp, setHangingUp] = useState(false);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState<CaptionState>({
    user: null,
    oracle: null,
    oracleDone: true,
  });

  const voiceSessionRef = useRef<RealtimeVoiceSession | null>(null);
  const orbRef = useRef<HTMLDivElement | null>(null);

  // Tools and the turn watcher always read the freshest thread facts without
  // re-tearing the WebRTC session on every stream update.
  const viewRef = useRef<VoiceOracleThreadView>({
    threadTitle,
    projectName,
    messages,
    session,
    latestTurn,
  });
  viewRef.current = { threadTitle, projectName, messages, session, latestTurn };
  const sendToAgentRef = useRef(onSendToAgent);
  sendToAgentRef.current = onSendToAgent;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const lastTurnRef = useRef<{ turnId: string | null; state: string | null }>({
    turnId: latestTurn?.turnId ?? null,
    state: latestTurn?.state ?? null,
  });

  useEffect(() => {
    let disposed = false;
    let voiceSession: RealtimeVoiceSession | null = null;

    const connect = async () => {
      try {
        const minted = await mintVoiceRealtimeSession(environmentId);
        if (disposed) return;
        voiceSession = await RealtimeVoiceSession.connect({
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
            onCloseRef.current();
          },
          onStatusChange: (status) => {
            if (disposed || status === "ended") return;
            setPhase((current) =>
              current.kind === "error" || current.kind === "not-configured"
                ? current
                : { kind: "active", status },
            );
          },
          onAssistantTranscript: (text, done) => {
            if (disposed) return;
            setCaptions((current) => ({ ...current, oracle: text, oracleDone: done }));
          },
          onUserTranscript: (text) => {
            if (disposed) return;
            setCaptions((current) => ({ ...current, user: text }));
          },
          onError: (message) => {
            if (disposed) return;
            setPhase({ kind: "error", message });
          },
        });
        if (disposed) {
          voiceSession.close();
          return;
        }
        voiceSessionRef.current = voiceSession;
        setSessionReady(true);
        // Announce only turn changes that happen while the oracle is live.
        lastTurnRef.current = {
          turnId: viewRef.current.latestTurn?.turnId ?? null,
          state: viewRef.current.latestTurn?.state ?? null,
        };
      } catch (error) {
        if (disposed) return;
        const described = describeVoiceMintError(error);
        setPhase(
          described.notConfigured
            ? { kind: "not-configured", message: described.message }
            : { kind: "error", message: described.message },
        );
      }
    };
    void connect();

    return () => {
      disposed = true;
      voiceSessionRef.current = null;
      setSessionReady(false);
      voiceSession?.close();
    };
  }, [environmentId]);

  // Report coding-agent turn transitions into the live voice conversation.
  const latestTurnId = latestTurn?.turnId ?? null;
  const latestTurnState = latestTurn?.state ?? null;
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

  // Drive the orb from live audio levels. Writes CSS variables directly so
  // silence costs nothing: when the level settles, style writes stop and the
  // compositor has nothing to repaint.
  const isActive = phase.kind === "active";
  useEffect(() => {
    if (!isActive || !sessionReady) return;
    const voiceSession = voiceSessionRef.current;
    const orb = orbRef.current;
    if (!voiceSession || !orb) return;

    const audioContext = new AudioContext();
    const inputAnalyser = audioContext.createAnalyser();
    inputAnalyser.fftSize = 256;
    const outputAnalyser = audioContext.createAnalyser();
    outputAnalyser.fftSize = 256;
    audioContext
      .createMediaStreamSource(voiceSession.localStream as MediaStream)
      .connect(inputAnalyser);

    let outputAttached = false;
    const inputData = new Uint8Array(inputAnalyser.frequencyBinCount);
    const outputData = new Uint8Array(outputAnalyser.frequencyBinCount);
    let lastLevel = -1;
    let frame = 0;

    const rms = (analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>) => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (const value of data) sum += value * value;
      return Math.sqrt(sum / data.length) / 255;
    };

    const tick = () => {
      if (!outputAttached && voiceSession.remoteStream) {
        audioContext
          .createMediaStreamSource(voiceSession.remoteStream as MediaStream)
          .connect(outputAnalyser);
        outputAttached = true;
      }
      const level = Math.min(
        1,
        Math.max(
          rms(inputAnalyser, inputData),
          outputAttached ? rms(outputAnalyser, outputData) : 0,
        ) * 2.2,
      );
      if (Math.abs(level - lastLevel) > ORB_LEVEL_EPSILON) {
        lastLevel = level;
        orb.style.setProperty("--voice-orb-level", level.toFixed(3));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      void audioContext.close().catch(() => {});
    };
  }, [isActive, sessionReady]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      voiceSessionRef.current?.setMuted(next);
      return next;
    });
  }, []);

  const openVoiceSettings = useCallback(() => {
    onClose();
    void navigate({ to: "/settings/voice" });
  }, [navigate, onClose]);

  const agentActivity = describeAgentActivity({
    threadTitle,
    projectName,
    messages,
    session,
    latestTurn,
  });
  const orbStatus: VoiceSessionStatus = phase.kind === "active" ? phase.status : "connecting";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-background/92 backdrop-blur-md [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Voice oracle"
    >
      <div className="flex w-full items-start justify-between p-4 sm:p-6">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{threadTitle}</p>
          <p className="truncate text-xs text-muted-foreground">
            {projectName ? `${projectName} · ` : ""}
            {agentActivity.label}
            {agentActivity.working ? "…" : ""}
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Close voice oracle"
          onClick={onClose}
        >
          <XIcon className="size-5" />
        </Button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
        <div ref={orbRef} className="voice-orb" data-status={orbStatus} aria-hidden>
          <div className="voice-orb-halo" />
          <div className="voice-orb-ring" />
          <div className="voice-orb-core" />
        </div>

        {phase.kind === "connecting" && (
          <p className="text-sm text-muted-foreground">Summoning the oracle…</p>
        )}
        {phase.kind === "active" && (
          <div className="flex max-w-xl flex-col items-center gap-3 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground/70">
              {hangingUp ? "Wrapping up" : STATUS_LABELS[phase.status]}
            </p>
            {captions.user && (
              <p className="max-h-16 overflow-hidden text-sm text-muted-foreground">
                “{captions.user}”
              </p>
            )}
            {captions.oracle && (
              <p
                className={cn(
                  "max-h-40 overflow-hidden text-balance text-base text-foreground",
                  !captions.oracleDone && "opacity-90",
                )}
              >
                {captions.oracle}
              </p>
            )}
          </div>
        )}
        {phase.kind === "not-configured" && (
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">{phase.message}</p>
            <Button type="button" variant="outline" onClick={openVoiceSettings}>
              <SettingsIcon className="size-4" /> Open voice settings
            </Button>
          </div>
        )}
        {phase.kind === "error" && (
          <p className="max-w-md text-center text-sm text-destructive">{phase.message}</p>
        )}
      </div>

      <div className="flex items-center gap-4 p-6 sm:p-8">
        <Button
          type="button"
          size="icon-xl"
          variant={muted ? "destructive" : "secondary"}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          disabled={!isActive}
          onClick={toggleMuted}
          className="rounded-full"
        >
          {muted ? <MicOffIcon className="size-5" /> : <MicIcon className="size-5" />}
        </Button>
        <Button
          type="button"
          size="icon-xl"
          variant="destructive"
          aria-label="End voice session"
          onClick={onClose}
          className="rounded-full"
        >
          <XIcon className="size-5" />
        </Button>
      </div>
    </div>
  );
});
