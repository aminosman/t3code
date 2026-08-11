/**
 * React Native platform adapter for the shared realtime voice driver.
 *
 * react-native-webrtc plays remote audio tracks automatically, so
 * `attachRemoteAudio` only manages the audio session: InCallManager routes
 * output to the speaker (a voice copilot is not a phone call held to the
 * ear) and keeps the screen awake during the session.
 */
import type {
  MediaStreamLike,
  PeerConnectionLike,
  VoicePlatform,
} from "@t3tools/client-runtime/voice/realtimeSession";
import InCallManager from "react-native-incall-manager";
import { mediaDevices, RTCPeerConnection } from "react-native-webrtc";

export class MicrophoneAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrophoneAccessError";
  }
}

let audioSessionActive = false;

function startAudioSession(): void {
  if (audioSessionActive) return;
  audioSessionActive = true;
  InCallManager.start({ media: "audio" });
  InCallManager.setForceSpeakerphoneOn(true);
  InCallManager.setKeepScreenOn(true);
}

/**
 * Idempotent teardown, also called from the screen's unmount effect: a
 * session that fails before the remote track arrives never runs the
 * `attachRemoteAudio` cleanup, and a stuck call-audio session would otherwise
 * keep the speaker route and wakelock until the app restarts.
 */
export function stopVoiceAudioSession(): void {
  if (!audioSessionActive) return;
  audioSessionActive = false;
  InCallManager.setKeepScreenOn(false);
  InCallManager.setForceSpeakerphoneOn(false);
  InCallManager.stop();
}

export const reactNativeVoicePlatform: VoicePlatform = {
  // A handset is held close to the mouth even on speakerphone.
  audioEnvironment: "near_field",
  // Speakerphone puts the oracle's own voice straight back into the mic, and
  // the OS echo canceller cannot fully suppress it when the session is
  // routed to the loudspeaker. Gate the mic while it speaks instead.
  suppressEchoByMuting: true,
  acquireAudioStream: async () => {
    startAudioSession();
    try {
      // getUserMedia raises the OS microphone prompt on first use; the usage
      // string ships in the app config. Audio processing constraints are not
      // part of react-native-webrtc's constraint surface (libwebrtc runs its
      // own echo canceller), so echo is handled by muting the mic while the
      // oracle speaks — see `suppressEchoByMuting`.
      const stream = await mediaDevices.getUserMedia({ audio: true });
      return stream as unknown as MediaStreamLike;
    } catch (error) {
      stopVoiceAudioSession();
      const name = error instanceof Error ? error.name : "";
      throw new MicrophoneAccessError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was denied. Enable the microphone for T3 Code in system settings, then try again."
          : "Could not open the microphone.",
      );
    }
  },
  // Structural cast: react-native-webrtc's types differ from the shared
  // driver's minimal surface, but the runtime shapes line up.
  createPeerConnection: () => new RTCPeerConnection() as unknown as PeerConnectionLike,
  attachRemoteAudio: () => {
    // Remote tracks play automatically; the session was configured when the
    // microphone was acquired. Cleanup tears the audio session down.
    return () => {
      stopVoiceAudioSession();
    };
  },
};
