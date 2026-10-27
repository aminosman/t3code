import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  RealtimeVoiceSession,
  type DataChannelLike,
  type PeerConnectionLike,
  type RealtimeVoiceSessionOptions,
  type VoicePlatform,
} from "./realtimeSession.js";

class MockChannel {
  readyState = "connecting";
  readonly sent: Array<Record<string, unknown>> = [];
  onclose: (() => void) | null = null;
  onerror: ((event: { readonly error?: unknown }) => void) | null = null;
  private readonly listeners = new Map<
    string,
    (event: { data?: unknown; error?: unknown }) => void
  >();

  addEventListener(
    type: "message" | "open" | "close" | "error",
    listener: (event: { data?: unknown; error?: unknown }) => void,
  ) {
    this.listeners.set(type, listener);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.readyState = "closed";
    this.listeners.get("close")?.({});
  }

  open() {
    this.readyState = "open";
    this.listeners.get("open")?.({});
  }

  serverEvent(event: Record<string, unknown>) {
    this.listeners.get("message")?.({ data: JSON.stringify(event) });
  }
}

async function connectHarness(options?: {
  readonly onDiagnosticEvent?: RealtimeVoiceSessionOptions["onDiagnosticEvent"];
  readonly onStatusChange?: (status: string) => void;
  readonly onError?: (message: string) => void;
  readonly onHangUp?: () => void;
}) {
  const channel = new MockChannel();
  const track = { enabled: true, stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  const peer = {
    connectionState: "new",
    iceConnectionState: "new",
    ontrack: null,
    onconnectionstatechange: null,
    oniceconnectionstatechange: null,
    addTrack: vi.fn(),
    createDataChannel: () => channel as unknown as DataChannelLike,
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async () => undefined,
    getStats: async () => new Map(),
    close: vi.fn(),
  } as unknown as PeerConnectionLike;
  const platform: VoicePlatform = {
    suppressEchoByMuting: true,
    turnDetection: {
      threshold: 0.95,
      prefixPaddingMs: 300,
      silenceDurationMs: 1_200,
      interruptResponse: false,
    },
    acquireAudioStream: async () => stream,
    createPeerConnection: () => peer,
    attachRemoteAudio: () => () => undefined,
  };
  const sessionOptions: RealtimeVoiceSessionOptions = {
    clientSecret: "not-written-to-diagnostics",
    model: "test-model",
    instructions: "test",
    tools: [],
    onToolCall: async () => ({}),
    onStatusChange: options?.onStatusChange ?? (() => undefined),
    onAssistantTranscript: () => undefined,
    onUserTranscript: () => undefined,
    onHangUp: options?.onHangUp ?? (() => undefined),
    onError: options?.onError ?? (() => undefined),
    ...(options?.onDiagnosticEvent ? { onDiagnosticEvent: options.onDiagnosticEvent } : {}),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => "answer" }) as Response),
  );
  const session = await RealtimeVoiceSession.connect(sessionOptions, platform);
  channel.open();
  return { channel, peer, session, track };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RealtimeVoiceSession mobile interruption handling", () => {
  it("sends the platform's less-sensitive VAD config and disables response interruption", async () => {
    const { channel, session } = await connectHarness();
    const update = channel.sent.find((event) => event.type === "session.update");
    const sessionConfig = update?.session as {
      audio: { input: { turn_detection: Record<string, unknown> } };
    };
    expect(sessionConfig.audio.input.turn_detection).toMatchObject({
      threshold: 0.95,
      prefix_padding_ms: 300,
      silence_duration_ms: 1_200,
      interrupt_response: false,
    });
    session.close();
  });

  it("keeps the mic gated until generation and playback are both done", async () => {
    const { channel, session, track } = await connectHarness();
    channel.serverEvent({ type: "response.created" });
    expect(track.enabled).toBe(false);
    channel.serverEvent({ type: "output_audio_buffer.started" });
    channel.serverEvent({ type: "response.done", response: { status: "completed" } });
    expect(track.enabled).toBe(false);
    channel.serverEvent({ type: "output_audio_buffer.stopped" });
    expect(track.enabled).toBe(true);
    session.close();
  });

  it("waits for the sign-off audio to drain before hanging up", async () => {
    const onHangUp = vi.fn();
    const { channel, session } = await connectHarness({ onHangUp });
    session.requestHangUp();
    channel.serverEvent({ type: "response.created" });
    channel.serverEvent({ type: "output_audio_buffer.started" });
    channel.serverEvent({ type: "response.done", response: { status: "completed" } });
    expect(onHangUp).not.toHaveBeenCalled();
    channel.serverEvent({ type: "output_audio_buffer.stopped" });
    expect(onHangUp).toHaveBeenCalledOnce();
    session.close();
  });

  it("treats a disconnected peer as recoverable until it fails or closes", async () => {
    const statuses: Array<string> = [];
    const onError = vi.fn();
    const { channel, peer, session, track } = await connectHarness({
      onStatusChange: (status) => statuses.push(status),
      onError,
    });
    (peer as { connectionState: string }).connectionState = "disconnected";
    peer.onconnectionstatechange?.();
    expect(onError).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe("connecting");
    (peer as { connectionState: string }).connectionState = "connected";
    peer.onconnectionstatechange?.();
    expect(statuses.at(-1)).toBe("listening");
    expect(onError).not.toHaveBeenCalled();
    channel.serverEvent({ type: "response.created" });
    expect(track.enabled).toBe(false);
    (peer as { connectionState: string }).connectionState = "failed";
    peer.onconnectionstatechange?.();
    expect(track.enabled).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    session.close();
  });

  it("releases a late audio start and a cleared output buffer", async () => {
    const { channel, session, track } = await connectHarness();
    channel.serverEvent({ type: "response.created" });
    channel.serverEvent({ type: "response.done", response: { status: "completed" } });
    expect(track.enabled).toBe(true);
    channel.serverEvent({ type: "output_audio_buffer.started" });
    expect(track.enabled).toBe(false);
    channel.serverEvent({ type: "output_audio_buffer.cleared" });
    expect(track.enabled).toBe(true);
    session.close();
  });

  it("does not reopen the mic on a timer while playback is still draining", async () => {
    vi.useFakeTimers();
    const { channel, session, track } = await connectHarness();
    channel.serverEvent({ type: "response.created" });
    channel.serverEvent({ type: "output_audio_buffer.started" });
    channel.serverEvent({ type: "response.done", response: { status: "completed" } });
    vi.advanceTimersByTime(10_000);
    expect(track.enabled).toBe(false);
    channel.serverEvent({ type: "output_audio_buffer.stopped" });
    expect(track.enabled).toBe(true);
    session.close();
  });

  it("releases the mic when the data channel dies mid-response", async () => {
    const onError = vi.fn();
    const { channel, session, track } = await connectHarness({ onError });
    channel.serverEvent({ type: "response.created" });
    expect(track.enabled).toBe(false);
    channel.close();
    expect(track.enabled).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    session.close();
  });

  it("does not let an overlapping response reset the active playback gate", async () => {
    const { channel, session, track } = await connectHarness();
    channel.serverEvent({ type: "response.created" });
    channel.serverEvent({ type: "output_audio_buffer.started" });
    channel.serverEvent({ type: "response.created" });
    channel.serverEvent({ type: "response.done", response: { status: "completed" } });
    channel.serverEvent({ type: "output_audio_buffer.stopped" });
    expect(track.enabled).toBe(true);
    channel.serverEvent({ type: "output_audio_buffer.started" });
    expect(track.enabled).toBe(false);
    channel.serverEvent({ type: "response.done", response: { status: "completed" } });
    expect(track.enabled).toBe(false);
    channel.serverEvent({ type: "output_audio_buffer.stopped" });
    expect(track.enabled).toBe(true);
    session.close();
  });

  it("records event metadata without storing transcript content", async () => {
    const diagnostic = vi.fn();
    const { channel, session } = await connectHarness({ onDiagnosticEvent: diagnostic });
    channel.serverEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "private words that must not enter diagnostics",
    });
    expect(diagnostic).toHaveBeenCalledWith("realtime.user_transcription_completed", {});
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private words");
    session.close();
  });
});
