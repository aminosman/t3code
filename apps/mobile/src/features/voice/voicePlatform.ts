/**
 * React Native platform adapter for the shared realtime voice driver.
 *
 * react-native-webrtc plays remote audio tracks automatically. InCallManager
 * owns the call session, while the actual AVAudioSession route—not a wired-
 * headset guess—decides when the speaker override is safe to apply.
 */
import type {
  MediaStreamLike,
  PeerConnectionLike,
  VoicePlatform,
} from "@t3tools/client-runtime/voice/realtimeSession";
import { Platform } from "react-native";
import InCallManager from "react-native-incall-manager";
import { mediaDevices, RTCPeerConnection } from "react-native-webrtc";

import { recordLocalDiagnostic, recordLocalDiagnosticError } from "../diagnostics/localDiagnostics";
import {
  currentVoiceAudioSession,
  prepareVoiceAudioSession,
  subscribeToVoiceAudioSession,
} from "./nativeVoiceDiagnostics";
import { isHeadphoneRouteChange } from "./voiceRouting";

export class MicrophoneAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrophoneAccessError";
  }
}

let audioSessionActive = false;
let audioSessionGeneration = 0;
let audioSessionStart: Promise<number> | null = null;
let speakerForced = false;
let unsubscribeFromRoutes: (() => void) | null = null;
let routeSettleTimer: ReturnType<typeof setTimeout> | null = null;
const speakerphoneListeners = new Set<(enabled: boolean, externalDevice: boolean) => void>();

function isCurrentAudioSession(generation: number): boolean {
  return audioSessionActive && audioSessionGeneration === generation;
}

/** Keep the call-screen icon in sync with automatic Bluetooth route changes. */
export function subscribeVoiceSpeakerphone(
  listener: (enabled: boolean, externalDevice: boolean) => void,
): () => void {
  speakerphoneListeners.add(listener);
  return () => speakerphoneListeners.delete(listener);
}

/**
 * A speaker override outranks Bluetooth on iOS. It is therefore applied only
 * when no external audio device is available, never merely because no *wired*
 * headset was found (the old AirPods bug).
 */
export function setVoiceSpeakerphone(enabled: boolean): void {
  if (routeSettleTimer !== null) {
    clearTimeout(routeSettleTimer);
    routeSettleTimer = null;
  }
  speakerForced = enabled;
  InCallManager.setForceSpeakerphoneOn(enabled);
  const route = currentVoiceAudioSession();
  recordLocalDiagnostic("audio.speaker_override", {
    enabled,
    route,
  });
  for (const listener of speakerphoneListeners) {
    // The bridge applies overrides asynchronously; connected-device state is
    // truthful before the output route settles, unlike hasExternalOutput.
    listener(enabled, route?.hasExternalAudioDevice ?? false);
  }
}

export function isVoiceSpeakerphoneOn(): boolean {
  return speakerForced;
}

function reevaluateVoiceRoute(): void {
  if (routeSettleTimer !== null) {
    clearTimeout(routeSettleTimer);
    routeSettleTimer = null;
  }
  if (!audioSessionActive) return;
  const route = currentVoiceAudioSession();
  if (route) setVoiceSpeakerphone(!route.hasExternalAudioDevice);
}

function scheduleVoiceRouteReevaluation(): void {
  if (routeSettleTimer !== null) clearTimeout(routeSettleTimer);
  routeSettleTimer = setTimeout(reevaluateVoiceRoute, 200);
}

function startAudioSession(): Promise<number> {
  if (audioSessionStart) return audioSessionStart;
  if (audioSessionActive) return Promise.resolve(audioSessionGeneration);

  const generation = ++audioSessionGeneration;
  audioSessionActive = true;
  const start = (async () => {
    InCallManager.start({ media: "audio" });
    InCallManager.setKeepScreenOn(true);
    // start() is asynchronous on InCallManager's serial queue. Awaiting its
    // next promise method orders Bluetooth preparation after that start.
    const wired = await InCallManager.getIsWiredHeadsetPluggedIn().catch(() => ({
      isWiredHeadsetPluggedIn: false,
    }));
    // A screen may close while the native handshake is pending. Do not
    // reactivate audio or subscribe routes after its teardown.
    if (!isCurrentAudioSession(generation)) return generation;

    if (Platform.OS === "ios") {
      const route = prepareVoiceAudioSession() ?? currentVoiceAudioSession();
      if (route) {
        setVoiceSpeakerphone(!route.hasExternalAudioDevice);
        unsubscribeFromRoutes = subscribeToVoiceAudioSession((next) => {
          // Only hardware arrivals/removals drive automatic routing. Category
          // and our own override notifications can be transient WebRTC routes.
          if (!isHeadphoneRouteChange(next.reason)) return;
          scheduleVoiceRouteReevaluation();
        });
        recordLocalDiagnostic("audio.session_started", { route });
        return generation;
      }
      // A JS update on an older native client uses the previous fallback.
    }

    setVoiceSpeakerphone(!wired.isWiredHeadsetPluggedIn);
    recordLocalDiagnostic("audio.session_started", {
      wiredHeadset: wired.isWiredHeadsetPluggedIn,
    });
    return generation;
  })();
  audioSessionStart = start;
  void start.then(
    () => {
      if (audioSessionStart === start) audioSessionStart = null;
    },
    () => {
      if (audioSessionStart === start) audioSessionStart = null;
    },
  );
  return start;
}

/** Idempotent teardown; an expected generation protects a newer screen. */
export function stopVoiceAudioSession(expectedGeneration?: number): void {
  if (expectedGeneration !== undefined && !isCurrentAudioSession(expectedGeneration)) return;
  if (!audioSessionActive) return;
  recordLocalDiagnostic("audio.session_stopping", { route: currentVoiceAudioSession() });
  audioSessionActive = false;
  audioSessionGeneration += 1;
  audioSessionStart = null;
  if (routeSettleTimer !== null) {
    clearTimeout(routeSettleTimer);
    routeSettleTimer = null;
  }
  unsubscribeFromRoutes?.();
  unsubscribeFromRoutes = null;
  speakerForced = false;
  InCallManager.setKeepScreenOn(false);
  InCallManager.setForceSpeakerphoneOn(false);
  InCallManager.stop();
}

export const reactNativeVoicePlatform: VoicePlatform = {
  audioEnvironment: "near_field",
  // Speakerphone puts the oracle's own voice straight back into the mic. Keep
  // the whole response gated, and do not let wind/traffic cancel it either.
  suppressEchoByMuting: true,
  turnDetection: {
    threshold: 0.95,
    prefixPaddingMs: 300,
    silenceDurationMs: 1_200,
    interruptResponse: false,
  },
  acquireAudioStream: async () => {
    let generation: number | null = null;
    try {
      generation = await startAudioSession();
      if (!isCurrentAudioSession(generation)) {
        throw new MicrophoneAccessError("The voice session was closed.");
      }
      // libwebrtc owns echo cancellation and audio processing constraints.
      const stream = await mediaDevices.getUserMedia({ audio: true });
      if (!isCurrentAudioSession(generation)) {
        for (const track of stream.getTracks()) track.stop();
        throw new MicrophoneAccessError("The voice session was closed.");
      }
      // Re-read after mic acquisition rather than trusting a pre-mic route or
      // a transitional A2DP/HFP event.
      reevaluateVoiceRoute();
      recordLocalDiagnostic("audio.microphone_acquired", {
        tracks: stream.getAudioTracks().length,
        route: currentVoiceAudioSession(),
      });
      return stream as unknown as MediaStreamLike;
    } catch (error) {
      recordLocalDiagnosticError("audio.microphone_failed", error);
      if (generation === null || isCurrentAudioSession(generation)) {
        stopVoiceAudioSession();
      }
      if (error instanceof MicrophoneAccessError) throw error;
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
    const generation = audioSessionGeneration;
    recordLocalDiagnostic("audio.remote_track_playing", {
      route: currentVoiceAudioSession(),
    });
    return () => {
      stopVoiceAudioSession(generation);
    };
  },
};
