import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";

export interface TuiVoiceNote {
  readonly base64: string;
  readonly mimeType: string;
  readonly durationMs: number;
}

/** A voice note longer than this is cut off; tui hears commands, not memos. */
const MAX_NOTE_MS = 120_000;

async function releaseAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    await setIsAudioActiveAsync(false);
  }
}

/**
 * Hold to record, release to send: a voice note for tui, recorded as AAC
 * (.m4a) and handed over as base64. tui transcribes it on the Mac, with the
 * same ear and name corrections as push-to-talk, so nothing is transcribed
 * here.
 */
export function useTuiVoiceNote() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRef = useRef<(() => Promise<TuiVoiceNote | null>) | null>(null);
  // A note stopped by the time limit, waiting for the finger to lift.
  const autoStopped = useRef<Promise<TuiVoiceNote | null> | null>(null);
  // One recorder transition at a time: a press while the last note is
  // still stopping would prepare the recorder under its shutdown.
  const busy = useRef<Promise<unknown> | null>(null);

  const start = useCallback(async (): Promise<boolean> => {
    if (busy.current) await busy.current.catch(() => undefined);
    setError(null);
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setError("Microphone access is off for Roost. Turn it on in Settings to send voice notes.");
      return false;
    }
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        interruptionMode: "doNotMix",
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      await setIsAudioActiveAsync(true);
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt.current = Date.now();
      setRecording(true);
      limit.current = setTimeout(() => {
        autoStopped.current = stopRef.current?.() ?? null;
      }, MAX_NOTE_MS);
      return true;
    } catch (cause) {
      await releaseAudio().catch(() => undefined);
      setError(cause instanceof Error ? cause.message : "Could not start recording.");
      return false;
    }
  }, [recorder]);

  const stop = useCallback(async (): Promise<TuiVoiceNote | null> => {
    if (limit.current) clearTimeout(limit.current);
    limit.current = null;
    if (startedAt.current === 0) return null;
    const durationMs = Date.now() - startedAt.current;
    startedAt.current = 0;
    setRecording(false);
    try {
      await recorder.stop();
    } finally {
      await releaseAudio().catch(() => undefined);
    }
    const uri = recorder.uri;
    if (!uri) return null;
    const file = new File(uri);
    try {
      if (durationMs < 400) return null;
      return { base64: await file.base64(), mimeType: "audio/mp4", durationMs };
    } finally {
      try {
        file.delete();
      } catch {
        // A note left in the cache is cleaned up by the OS.
      }
    }
  }, [recorder]);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  /** Stops and returns the note; null when it was too short to be words. */
  const finish = useCallback(async (): Promise<TuiVoiceNote | null> => {
    const pending = autoStopped.current;
    autoStopped.current = null;
    const stopping = pending ?? stop();
    busy.current = stopping;
    try {
      return await stopping;
    } finally {
      if (busy.current === stopping) busy.current = null;
    }
  }, [stop]);

  // Leaving the screen mid-note stops the mic and drops the note.
  useEffect(
    () => () => {
      void stopRef.current?.();
    },
    [],
  );

  return { recording, error, start, finish, clearError: () => setError(null) };
}
