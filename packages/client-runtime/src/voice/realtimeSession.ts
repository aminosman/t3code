// Platform-specific WebRTC and microphone operations are injected through VoicePlatform.
// Audio goes directly to OpenAI using a short-lived secret minted by the server.

import { summarizeVoiceConnectionStats } from "./voiceDiagnostics.ts";

export type VoiceSessionStatus =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "ended"
  | "error";

export interface VoiceToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface MediaStreamTrackLike {
  enabled: boolean;
  stop(): void;
}

export interface MediaStreamLike {
  getAudioTracks(): MediaStreamTrackLike[];
  getTracks(): MediaStreamTrackLike[];
}

export interface DataChannelLike {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: { readonly error?: unknown }) => void): void;
}

export interface SessionDescriptionLike {
  readonly type?: string;
  readonly sdp?: string;
}

export interface PeerConnectionLike {
  readonly connectionState: string;
  readonly iceConnectionState: string;
  getStats?(): Promise<unknown>;
  addTrack(track: MediaStreamTrackLike, stream: MediaStreamLike): unknown;
  createDataChannel(label: string): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  close(): void;
  /** Assigned, not addEventListener: identical shape on both platforms. */
  ontrack: ((event: { streams?: readonly MediaStreamLike[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
}

export interface VoicePlatform {
  /**
   * Mic distance profile for server-side noise reduction. A handset is
   * near-field; a laptop across a desk (speakers well away from the mic) is
   * far-field. Defaults to far-field.
   */
  readonly audioEnvironment?: "near_field" | "far_field";
  /**
   * Mute the microphone for as long as the oracle is speaking. Needed where
   * the speaker feeds the mic badly enough that echo reads as the user
   * talking (a phone on speakerphone); it trades away mid-sentence barge-in
   * for not being interrupted by itself.
   */
  readonly suppressEchoByMuting?: boolean;
  /** Server VAD tuning and whether detected speech may cut off a response. */
  readonly turnDetection?: {
    readonly threshold?: number;
    readonly prefixPaddingMs?: number;
    readonly silenceDurationMs?: number;
    readonly interruptResponse?: boolean;
  };
  /** Acquire the microphone stream, raising platform permission prompts. */
  acquireAudioStream(): Promise<MediaStreamLike>;
  createPeerConnection(): PeerConnectionLike;
  /**
   * Route the oracle's remote audio to the speakers. Browser attaches an
   * <audio> element; React Native plays remote tracks automatically and only
   * configures the audio session. Returns a cleanup called on close.
   */
  attachRemoteAudio(stream: MediaStreamLike): () => void;
}

export interface RealtimeVoiceSessionOptions {
  readonly clientSecret: string;
  readonly model: string;
  readonly instructions: string;
  readonly tools: ReadonlyArray<VoiceToolDefinition>;
  /**
   * Context handed to the model the moment the channel opens, with an
   * immediate spoken response. Used to resume a thread: the oracle greets
   * with where the work stands instead of waiting to be spoken to.
   */
  readonly openingContext?: string;
  /**
   * Executes a tool call and resolves to a JSON-serializable result. The live
   * session is passed in so handlers can drive it (e.g. hang up) without
   * waiting for `connect()` to resolve and publish a reference.
   */
  readonly onToolCall: (
    name: string,
    args: unknown,
    session: RealtimeVoiceSession,
  ) => Promise<unknown>;
  readonly onStatusChange: (status: VoiceSessionStatus) => void;
  /** Streaming transcript of what the oracle is saying, for captions. */
  readonly onAssistantTranscript: (text: string, done: boolean) => void;
  /** Completed transcript of what the user said. */
  readonly onUserTranscript: (text: string) => void;
  /** The oracle finished its sign-off and the session should be torn down. */
  readonly onHangUp: () => void;
  readonly onError: (message: string) => void;
  /** Content-free protocol, connection, and audio-level telemetry. */
  readonly onDiagnosticEvent?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
/** Backstop so a dropped audio-done event cannot strand a hung-up session. */
const HANG_UP_TIMEOUT_MS = 12_000;
const STATS_SAMPLE_INTERVAL_MS = 2_000;

interface RealtimeEvent {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export class RealtimeVoiceSession {
  private readonly peer: PeerConnectionLike;
  private readonly micStream: MediaStreamLike;
  private readonly options: RealtimeVoiceSessionOptions;
  private readonly platform: VoicePlatform;
  private dataChannel: DataChannelLike | null = null;
  private remoteStreamValue: MediaStreamLike | null = null;
  private detachRemoteAudio: (() => void) | null = null;
  private assistantTranscriptBuffer = "";
  private closed = false;
  private userMuted = false;
  private oracleSpeaking = false;
  private responseInProgress = false;
  private responseGenerationDone = false;
  private outputAudioStarted = false;
  private outputAudioStopped = false;
  private hangUpPending = false;
  private hangUpTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private statsSampleInFlight = false;
  private lastMicEnabled: boolean | null = null;

  private constructor(
    options: RealtimeVoiceSessionOptions,
    platform: VoicePlatform,
    peer: PeerConnectionLike,
    micStream: MediaStreamLike,
  ) {
    this.options = options;
    this.platform = platform;
    this.peer = peer;
    this.micStream = micStream;
  }

  /** Microphone stream, for input-level visualization. */
  get localStream(): MediaStreamLike {
    return this.micStream;
  }

  /** Oracle voice stream, for output-level visualization. Null until connected. */
  get remoteStream(): MediaStreamLike | null {
    return this.remoteStreamValue;
  }

  static async connect(
    options: RealtimeVoiceSessionOptions,
    platform: VoicePlatform,
  ): Promise<RealtimeVoiceSession> {
    const micStream = await platform.acquireAudioStream();
    const peer = platform.createPeerConnection();
    const session = new RealtimeVoiceSession(options, platform, peer, micStream);
    try {
      await session.negotiate();
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  private async negotiate(): Promise<void> {
    const micTrack = this.micStream.getAudioTracks()[0];
    if (!micTrack) {
      throw new Error("No microphone track is available.");
    }
    this.peer.addTrack(micTrack, this.micStream);
    this.peer.ontrack = (event) => {
      const [stream] = event.streams ?? [];
      if (!stream) return;
      this.remoteStreamValue = stream;
      this.diagnostic("peer.remote_audio_attached");
      this.detachRemoteAudio = this.platform.attachRemoteAudio(stream);
    };
    this.peer.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = this.peer.connectionState;
      this.diagnostic("peer.connection_state", { state, iceState: this.peer.iceConnectionState });
      if (state === "connected") {
        this.options.onStatusChange(
          this.responseInProgress
            ? this.outputAudioStarted && !this.outputAudioStopped
              ? "speaking"
              : "thinking"
            : this.dataChannel?.readyState === "open"
              ? "listening"
              : "connecting",
        );
        return;
      }
      if (state === "disconnected") {
        // Cellular handoff and brief route changes often recover on their own.
        this.options.onStatusChange("connecting");
        return;
      }
      if (state === "failed" || state === "closed") {
        this.abortResponse();
        this.options.onError("The voice connection was lost.");
        this.options.onStatusChange("error");
      }
    };
    this.peer.oniceconnectionstatechange = () => {
      if (!this.closed) {
        this.diagnostic("peer.ice_state", { state: this.peer.iceConnectionState });
      }
    };

    const channel = this.peer.createDataChannel("oai-events");
    this.dataChannel = channel;
    channel.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        this.handleServerEvent(JSON.parse(event.data) as RealtimeEvent);
      } catch {
        // Ignore unparseable frames; the protocol is JSON-only.
        this.diagnostic("channel.invalid_json");
      }
    });
    channel.addEventListener("close", () => {
      if (this.closed) return;
      this.diagnostic("channel.closed");
      this.abortResponse();
      this.options.onError("The voice data channel was lost.");
      this.options.onStatusChange("error");
    });
    channel.addEventListener("error", (event) => {
      this.diagnostic("channel.error", {
        message: event.error instanceof Error ? event.error.message : undefined,
      });
      if (this.closed) return;
      this.abortResponse();
      this.options.onError("The voice data channel reported an error.");
      this.options.onStatusChange("error");
    });
    channel.addEventListener("open", () => {
      const turnDetection = this.platform.turnDetection;
      this.diagnostic("channel.opened", {
        vadThreshold: turnDetection?.threshold ?? 0.85,
        vadSilenceMs: turnDetection?.silenceDurationMs ?? 900,
        vadPrefixMs: turnDetection?.prefixPaddingMs ?? 300,
        interruptResponse: turnDetection?.interruptResponse ?? true,
        echoGating: this.platform.suppressEchoByMuting === true,
      });
      this.startStatsSampling();
      this.send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: this.options.instructions,
          tools: this.options.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
          tool_choice: "auto",
          audio: {
            input: {
              // gpt-4o-mini-transcribe over whisper-1: whisper hallucinates
              // confident text out of near-silence and speaker bleed, which
              // surfaces as the oracle "hearing" words nobody said.
              transcription: { model: "gpt-4o-mini-transcribe" },
              noise_reduction: {
                type: this.platform.audioEnvironment ?? "far_field",
              },
              // Speaker leakage can look like an interruption; require louder speech
              // and longer silence to avoid cutting the oracle off mid-sentence.
              turn_detection: {
                type: "server_vad",
                // Tuned for a phone in a room with other things happening.
                // Below ~0.8 typing, traffic, and other people's voices read
                // as the user speaking, which stops the oracle mid-word.
                threshold: turnDetection?.threshold ?? 0.85,
                prefix_padding_ms: turnDetection?.prefixPaddingMs ?? 300,
                silence_duration_ms: turnDetection?.silenceDurationMs ?? 900,
                interrupt_response: turnDetection?.interruptResponse ?? true,
              },
            },
          },
        },
      });
      if (this.options.openingContext) {
        this.injectContext(this.options.openingContext, { respond: true });
      }
      if (!this.closed) {
        this.options.onStatusChange("listening");
      }
    });

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    // This driver is intentionally Effect-free: it is consumed directly by
    // React components on web and React Native, and the SDP exchange is one
    // plain POST to OpenAI with no environment auth involved.
    // @effect-diagnostics-next-line globalFetch:off
    const response = await fetch(
      `${OPENAI_REALTIME_CALLS_URL}?model=${encodeURIComponent(this.options.model)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.clientSecret}`,
          "content-type": "application/sdp",
        },
        body: offer.sdp ?? "",
      },
    );
    if (!response.ok) {
      this.diagnostic("session.sdp_rejected", { status: response.status });
      throw new Error(`OpenAI rejected the voice call (status ${response.status}).`);
    }
    await this.peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    this.diagnostic("session.sdp_answer_applied");
  }

  private send(event: Record<string, unknown>): void {
    if (this.dataChannel?.readyState === "open") {
      this.dataChannel.send(JSON.stringify(event));
    }
  }

  /**
   * Push out-of-band context (e.g. "the coding agent finished") into the
   * conversation. With `respond`, the oracle speaks to it immediately.
   */
  injectContext(text: string, options?: { readonly respond?: boolean }): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text }],
      },
    });
    if (options?.respond) {
      this.send({ type: "response.create" });
    }
  }

  /**
   * Arm a hang-up. The oracle keeps speaking its sign-off; the session tears
   * down once its audio drains (or after a backstop timeout).
   */
  requestHangUp(): void {
    if (this.closed || this.hangUpPending) return;
    this.diagnostic("session.hang_up_requested");
    this.hangUpPending = true;
    // @effect-diagnostics-next-line globalTimers:off
    this.hangUpTimer = setTimeout(() => this.finalizeHangUp(), HANG_UP_TIMEOUT_MS);
  }

  private finalizeHangUp(): void {
    if (this.closed || !this.hangUpPending) return;
    this.hangUpPending = false;
    if (this.hangUpTimer !== null) {
      clearTimeout(this.hangUpTimer);
      this.hangUpTimer = null;
    }
    this.options.onHangUp();
  }

  setMuted(muted: boolean): void {
    this.diagnostic("mic.user_mute_changed", { muted });
    this.userMuted = muted;
    this.applyMicState();
  }

  /**
   * The mic is live only when the user has not muted it and — on platforms
   * that need echo suppression — the oracle is not currently speaking.
   */
  private applyMicState(): void {
    const gatedForEcho = this.platform.suppressEchoByMuting === true && this.oracleSpeaking;
    const enabled = !this.userMuted && !gatedForEcho;
    if (this.lastMicEnabled !== enabled) {
      this.diagnostic("mic.track_state", { enabled, userMuted: this.userMuted, gatedForEcho });
      this.lastMicEnabled = enabled;
    }
    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  close(): void {
    if (this.closed) return;
    this.diagnostic("session.closed");
    this.closed = true;
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.hangUpTimer !== null) {
      clearTimeout(this.hangUpTimer);
      this.hangUpTimer = null;
    }
    this.dataChannel?.close();
    for (const track of this.micStream.getTracks()) {
      track.stop();
    }
    this.peer.close();
    this.detachRemoteAudio?.();
    this.detachRemoteAudio = null;
    this.options.onStatusChange("ended");
  }

  private handleServerEvent(event: RealtimeEvent): void {
    if (this.closed || typeof event.type !== "string") return;
    switch (event.type) {
      // Event names cover both the GA ("output_audio") and earlier ("audio")
      // realtime API generations so a server-side model change does not
      // silently break captions.
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        if (typeof event.delta === "string") {
          this.assistantTranscriptBuffer += event.delta;
          this.options.onAssistantTranscript(this.assistantTranscriptBuffer, false);
        }
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const transcript =
          typeof event.transcript === "string" ? event.transcript : this.assistantTranscriptBuffer;
        this.assistantTranscriptBuffer = "";
        this.options.onAssistantTranscript(transcript, true);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        this.diagnostic("realtime.user_transcription_completed");
        if (typeof event.transcript === "string" && event.transcript.trim().length > 0) {
          this.options.onUserTranscript(event.transcript.trim());
        }
        return;
      }
      case "input_audio_buffer.speech_started": {
        this.diagnostic("realtime.speech_started");
        if (!this.responseInProgress) this.options.onStatusChange("listening");
        return;
      }
      case "input_audio_buffer.speech_stopped": {
        this.diagnostic("realtime.speech_stopped");
        return;
      }
      case "response.created": {
        if (this.responseInProgress) {
          // Tool follow-ups can overlap the previous playback. Never let a
          // later response reset the audio state that still owns the mic.
          this.diagnostic("realtime.response_overlap_deferred");
          return;
        }
        this.diagnostic("realtime.response_created");
        this.assistantTranscriptBuffer = "";
        this.responseInProgress = true;
        this.responseGenerationDone = false;
        this.outputAudioStarted = false;
        this.outputAudioStopped = false;
        // Gate from the moment a response starts forming, not just when its
        // audio begins: noise in the gap between the two cancels the
        // in-flight response, which is heard as stuttering.
        this.oracleSpeaking = true;
        this.applyMicState();
        this.options.onStatusChange("thinking");
        return;
      }
      case "output_audio_buffer.started": {
        this.diagnostic("realtime.output_audio_started");
        this.outputAudioStarted = true;
        this.outputAudioStopped = false;
        if (!this.responseInProgress) {
          // A late started event after done must reopen the drain wait rather
          // than leaving the mic gated after the early completion.
          this.responseInProgress = true;
        }
        this.oracleSpeaking = true;
        this.applyMicState();
        this.options.onStatusChange("speaking");
        return;
      }
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": {
        this.diagnostic(event.type);
        this.outputAudioStopped = true;
        if (!this.responseInProgress && this.outputAudioStarted) {
          this.oracleSpeaking = false;
          this.applyMicState();
          this.options.onStatusChange("listening");
        }
        this.completeResponseIfDrained();
        return;
      }
      case "response.done": {
        const response = event.response as { status?: unknown } | undefined;
        this.diagnostic("realtime.response_done", { status: response?.status });
        this.responseGenerationDone = true;
        this.completeResponseIfDrained();
        return;
      }
      case "response.function_call_arguments.done": {
        const callId = typeof event.call_id === "string" ? event.call_id : null;
        const name = typeof event.name === "string" ? event.name : null;
        if (callId === null || name === null) return;
        this.diagnostic("realtime.tool_call", { name });
        let parsedArguments: unknown = {};
        if (typeof event.arguments === "string" && event.arguments.length > 0) {
          try {
            parsedArguments = JSON.parse(event.arguments);
          } catch {
            parsedArguments = {};
          }
        }
        void this.runTool(callId, name, parsedArguments);
        return;
      }
      case "error": {
        const error = event.error as { message?: string } | undefined;
        this.diagnostic("realtime.error", { message: error?.message });
        this.options.onError(error?.message ?? "The voice session reported an error.");
        return;
      }
      default:
    }
  }

  private completeResponseIfDrained(): void {
    if (!this.responseInProgress || !this.responseGenerationDone) return;
    if (this.outputAudioStarted && !this.outputAudioStopped) return;
    this.responseInProgress = false;
    this.oracleSpeaking = false;
    this.applyMicState();
    // A hang-up armed mid-response waits for the sign-off audio to drain.
    if (this.hangUpPending) {
      this.finalizeHangUp();
      return;
    }
    this.options.onStatusChange("listening");
  }

  private abortResponse(): void {
    this.responseInProgress = false;
    this.responseGenerationDone = false;
    this.outputAudioStarted = false;
    this.outputAudioStopped = false;
    this.oracleSpeaking = false;
    this.applyMicState();
  }

  private diagnostic(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    try {
      this.options.onDiagnosticEvent?.(event, fields);
    } catch {
      // Telemetry is deliberately unable to interrupt the realtime session.
    }
  }

  private startStatsSampling(): void {
    if (!this.options.onDiagnosticEvent || !this.peer.getStats || this.statsTimer !== null) return;
    void this.sampleConnectionStats();
    // @effect-diagnostics-next-line globalTimers:off
    this.statsTimer = setInterval(() => {
      void this.sampleConnectionStats();
    }, STATS_SAMPLE_INTERVAL_MS);
  }

  private async sampleConnectionStats(): Promise<void> {
    if (this.closed || this.statsSampleInFlight || !this.peer.getStats) return;
    this.statsSampleInFlight = true;
    try {
      const stats = await this.peer.getStats();
      if (!this.closed) {
        this.diagnostic("connection.stats", { reports: summarizeVoiceConnectionStats(stats) });
      }
    } catch (error) {
      this.diagnostic("connection.stats_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.statsSampleInFlight = false;
    }
  }

  private async runTool(callId: string, name: string, args: unknown): Promise<void> {
    let output: unknown;
    try {
      output = await this.options.onToolCall(name, args, this);
    } catch (error) {
      output = { error: error instanceof Error ? error.message : "Tool execution failed." };
    }
    if (this.closed) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output ?? {}),
      },
    });
    this.send({ type: "response.create" });
  }
}
