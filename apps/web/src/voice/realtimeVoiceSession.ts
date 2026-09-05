/**
 * Framework-free manager for one OpenAI Realtime voice session over WebRTC.
 *
 * The browser talks to OpenAI directly using a short-lived client secret
 * minted by the T3 server; audio plays through a detached `<audio>` element
 * and JSON events flow over the `oai-events` data channel. The React overlay
 * consumes this through callbacks and never touches the wire protocol.
 */

import { acquireMicrophoneStream } from "./microphoneAccess";

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
}

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
/** Backstop so a dropped audio-done event cannot strand a hung-up session. */
const HANG_UP_TIMEOUT_MS = 12_000;

interface RealtimeEvent {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export class RealtimeVoiceSession {
  private readonly peer: RTCPeerConnection;
  private readonly micStream: MediaStream;
  private readonly audioElement: HTMLAudioElement;
  private readonly options: RealtimeVoiceSessionOptions;
  private dataChannel: RTCDataChannel | null = null;
  private remoteStreamValue: MediaStream | null = null;
  private assistantTranscriptBuffer = "";
  private closed = false;
  private hangUpPending = false;
  private hangUpTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    options: RealtimeVoiceSessionOptions,
    peer: RTCPeerConnection,
    micStream: MediaStream,
  ) {
    this.options = options;
    this.peer = peer;
    this.micStream = micStream;
    this.audioElement = document.createElement("audio");
    this.audioElement.autoplay = true;
  }

  /** Microphone stream, for input-level visualization. */
  get localStream(): MediaStream {
    return this.micStream;
  }

  /** Oracle voice stream, for output-level visualization. Null until connected. */
  get remoteStream(): MediaStream | null {
    return this.remoteStreamValue;
  }

  static async connect(options: RealtimeVoiceSessionOptions): Promise<RealtimeVoiceSession> {
    const micStream = await acquireMicrophoneStream();
    const peer = new RTCPeerConnection();
    const session = new RealtimeVoiceSession(options, peer, micStream);
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
      const [stream] = event.streams;
      this.remoteStreamValue = stream ?? new MediaStream([event.track]);
      this.audioElement.srcObject = this.remoteStreamValue;
      void this.audioElement.play().catch(() => {
        // Autoplay may be deferred until the next user gesture; the session
        // opened from a click, so this only happens in automated contexts.
      });
    };
    this.peer.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = this.peer.connectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        this.options.onError("The voice connection was lost.");
        this.options.onStatusChange("error");
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
      }
    });
    channel.addEventListener("open", () => {
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
          audio: { input: { transcription: { model: "whisper-1" } } },
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
      throw new Error(`OpenAI rejected the voice call (status ${response.status}).`);
    }
    await this.peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
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
    this.hangUpPending = true;
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
    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.hangUpTimer !== null) {
      clearTimeout(this.hangUpTimer);
      this.hangUpTimer = null;
    }
    this.dataChannel?.close();
    for (const track of this.micStream.getTracks()) {
      track.stop();
    }
    this.peer.close();
    this.audioElement.srcObject = null;
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
        if (typeof event.transcript === "string" && event.transcript.trim().length > 0) {
          this.options.onUserTranscript(event.transcript.trim());
        }
        return;
      }
      case "input_audio_buffer.speech_started": {
        this.options.onStatusChange("listening");
        return;
      }
      case "response.created": {
        this.assistantTranscriptBuffer = "";
        this.options.onStatusChange("thinking");
        return;
      }
      case "output_audio_buffer.started": {
        this.options.onStatusChange("speaking");
        return;
      }
      case "output_audio_buffer.stopped":
      case "response.done": {
        // A hang-up armed mid-response waits for the sign-off audio to drain.
        if (this.hangUpPending) {
          this.finalizeHangUp();
          return;
        }
        this.options.onStatusChange("listening");
        return;
      }
      case "response.function_call_arguments.done": {
        const callId = typeof event.call_id === "string" ? event.call_id : null;
        const name = typeof event.name === "string" ? event.name : null;
        if (callId === null || name === null) return;
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
        this.options.onError(error?.message ?? "The voice session reported an error.");
        return;
      }
      default:
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
