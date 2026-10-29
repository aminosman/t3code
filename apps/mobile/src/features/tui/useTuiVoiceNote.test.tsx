import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  recorder: {
    uri: "file:///note.m4a",
    stop: vi.fn(async () => {}),
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
  },
  release: vi.fn(async () => {}),
  deleteFile: vi.fn(),
  readFile: vi.fn(async () => "audio-base64"),
}));
vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: async () => {},
  setIsAudioActiveAsync: harness.release,
  useAudioRecorder: () => harness.recorder,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    base64 = harness.readFile;
    delete = harness.deleteFile;
  },
}));
import { useTuiVoiceNote } from "./useTuiVoiceNote";

it("drops short notes, returns timed-out notes once, and releases the microphone on unmount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  harness.recorder.stop.mockClear();
  harness.deleteFile.mockClear();
  harness.readFile.mockClear();
  let controls: ReturnType<typeof useTuiVoiceNote>;
  function Probe() {
    const result = useTuiVoiceNote();
    useLayoutEffect(() => {
      controls = result;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => {
      await controls!.start();
    });
    let shortNote: unknown;
    await act(async () => {
      shortNote = await controls!.finish();
    });
    expect(shortNote).toBeNull();
    expect(harness.readFile).not.toHaveBeenCalled();
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
    await act(async () => {
      await controls!.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    let note: unknown;
    await act(async () => {
      note = await controls!.finish();
    });
    expect(note).toEqual({ base64: "audio-base64", mimeType: "audio/mp4", durationMs: 120_000 });
    expect(harness.recorder.stop).toHaveBeenCalledTimes(2);
    expect(harness.deleteFile).toHaveBeenCalledTimes(2);
    await act(async () => {
      await controls!.start();
    });
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
  expect(harness.recorder.stop).toHaveBeenCalledTimes(3);
  expect(harness.release).toHaveBeenLastCalledWith(false);
});
