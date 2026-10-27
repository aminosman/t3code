import { requireNativeModule } from "expo";
import { Platform } from "react-native";

export interface VoiceAudioPort {
  readonly type: string;
  readonly uidHash: string;
  readonly external: boolean;
  readonly channels: number;
}

export interface VoiceAudioSessionState {
  readonly category: string;
  readonly categoryOptions: number;
  readonly mode: string;
  readonly sampleRate: number;
  readonly ioBufferDuration: number;
  readonly inputNumberOfChannels: number;
  readonly outputNumberOfChannels: number;
  readonly inputLatency: number;
  readonly outputLatency: number;
  readonly outputVolume: number;
  readonly inputAvailable: boolean;
  readonly otherAudioPlaying: boolean;
  readonly secondaryAudioShouldBeSilenced: boolean;
  readonly inputs: ReadonlyArray<VoiceAudioPort>;
  readonly outputs: ReadonlyArray<VoiceAudioPort>;
  readonly availableInputs: ReadonlyArray<VoiceAudioPort>;
  readonly hasExternalOutput: boolean;
  readonly hasExternalAudioDevice: boolean;
  readonly inputGain?: number;
}

export interface NativeDiagnosticsSummary {
  readonly nativeEvents: number;
  readonly nativeBytes: number;
  readonly crashes: number;
  readonly hangs: number;
  readonly lastCrash: number;
  readonly metricKitAvailable: boolean;
}

interface NativeVoiceDiagnostics {
  startDiagnostics(): void;
  prepareVoiceAudioSession(): VoiceAudioSessionState;
  getAudioSessionState(): VoiceAudioSessionState;
  getDiagnosticsSummary(): Promise<NativeDiagnosticsSummary>;
  exportDiagnostics(): Promise<{
    readonly eventFiles: ReadonlyArray<{ readonly name: string; readonly jsonl: string }>;
    readonly metricKitFiles: ReadonlyArray<{ readonly name: string; readonly json: string }>;
    readonly audioSessionAtExport: VoiceAudioSessionState;
  }>;
  clearDiagnostics(): Promise<NativeDiagnosticsSummary>;
  addListener(
    eventName: "onAudioSessionEvent",
    listener: (event: {
      readonly event: string;
      readonly fields: VoiceAudioSessionState & Record<string, unknown>;
    }) => void,
  ): { remove(): void };
}

let cached: NativeVoiceDiagnostics | null | undefined;

/** The JS fallback keeps diagnostics usable in Android and non-native tests. */
export function nativeVoiceDiagnostics(): NativeVoiceDiagnostics | null {
  if (Platform.OS !== "ios") return null;
  if (cached !== undefined) return cached;
  try {
    // Loaded lazily so a compatible JS bundle can still report a missing
    // native client instead of failing the whole app at import time.
    cached = requireNativeModule<NativeVoiceDiagnostics>("T3VoiceDiagnostics");
  } catch {
    cached = null;
  }
  return cached;
}

export function prepareVoiceAudioSession(): VoiceAudioSessionState | null {
  try {
    return nativeVoiceDiagnostics()?.prepareVoiceAudioSession() ?? null;
  } catch {
    return null;
  }
}

export function currentVoiceAudioSession(): VoiceAudioSessionState | null {
  try {
    return nativeVoiceDiagnostics()?.getAudioSessionState() ?? null;
  } catch {
    return null;
  }
}

export function subscribeToVoiceAudioSession(
  listener: (state: VoiceAudioSessionState & Record<string, unknown>) => void,
): () => void {
  try {
    const native = nativeVoiceDiagnostics();
    if (!native) return () => undefined;
    const subscription = native.addListener("onAudioSessionEvent", (event) => {
      if (event.event === "audio.route_changed") listener(event.fields);
    });
    return () => subscription.remove();
  } catch {
    return () => undefined;
  }
}
