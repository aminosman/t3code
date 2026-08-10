/**
 * Browser platform adapter for the shared realtime voice driver: native
 * WebRTC, mic acquisition through the desktop-aware permission helper, and
 * remote audio through a detached <audio> element.
 */
import {
  RealtimeVoiceSession as SharedRealtimeVoiceSession,
  type MediaStreamLike,
  type PeerConnectionLike,
  type RealtimeVoiceSessionOptions,
  type VoicePlatform,
} from "@t3tools/client-runtime/voice/realtimeSession";
import { acquireMicrophoneStream } from "./microphoneAccess";

export type {
  RealtimeVoiceSessionOptions,
  VoiceSessionStatus,
  VoiceToolDefinition,
} from "@t3tools/client-runtime/voice/realtimeSession";

const browserVoicePlatform: VoicePlatform = {
  acquireAudioStream: () => acquireMicrophoneStream(),
  // Structural cast: DOM event-handler property types are narrower than the
  // shared driver's minimal surface, but the runtime shapes line up.
  createPeerConnection: () => new RTCPeerConnection() as unknown as PeerConnectionLike,
  attachRemoteAudio: (stream: MediaStreamLike) => {
    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    audioElement.srcObject = stream as MediaStream;
    void audioElement.play().catch(() => {
      // Autoplay may be deferred until the next user gesture; the session
      // opened from a click, so this only happens in automated contexts.
    });
    return () => {
      audioElement.srcObject = null;
    };
  },
};

export type RealtimeVoiceSession = SharedRealtimeVoiceSession;

export const RealtimeVoiceSession = {
  connect: (options: RealtimeVoiceSessionOptions) =>
    SharedRealtimeVoiceSession.connect(options, browserVoicePlatform),
};
