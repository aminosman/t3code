import { useSyncExternalStore } from "react";

import { transcribeRecordingOnDevice } from "../../native/voiceTranscription";

/**
 * Meetings recorded on the phone itself. Each lives in its own folder under
 * the app's documents — `phone-meetings/<id>/meeting.json` and `audio.m4a` —
 * so a meeting recorded with no connection is kept, transcribed on the
 * device, and still there when the Mac is next reachable.
 */
export type PhoneMeetingKind = "room" | "call";

export type PhoneMeetingTranscription = "pending" | "done" | "unavailable" | "failed";

export interface PhoneTranscriptLine {
  readonly at: string;
  readonly seconds: number;
  readonly text: string;
}

export interface PhoneMeeting {
  readonly id: string;
  readonly title: string;
  readonly kind: PhoneMeetingKind;
  readonly startedAt: string;
  readonly durationSeconds: number;
  readonly myNotes: string;
  readonly transcription: PhoneMeetingTranscription;
  readonly transcript: ReadonlyArray<PhoneTranscriptLine>;
  /** When the Mac took it; null while it is only on the phone. */
  readonly syncedAt: string | null;
}

const ROOT = "phone-meetings";
const AUDIO = "audio.m4a";
const RECORD = "meeting.json";

/** m:ss, or h:mm:ss past an hour. */
export function clockTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A folder name that sorts by time and reads as one: 2026.10.06-1742-a1b2. */
export function newPhoneMeetingId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultMeetingTitle(kind: PhoneMeetingKind, startedAt: Date): string {
  const time = startedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return kind === "call" ? `Call at ${time}` : `Meeting at ${time}`;
}

/** Joins transcriber segments into lines a reader can follow: new line on a pause. */
export function transcriptLines(
  segments: ReadonlyArray<{ text: string; startSecond: number; endSecond: number }>,
): ReadonlyArray<PhoneTranscriptLine> {
  const lines: { seconds: number; end: number; text: string }[] = [];
  for (const segment of segments) {
    const last = lines.at(-1);
    if (last && segment.startSecond - last.end < 1.5 && last.text.length < 280) {
      last.text = `${last.text} ${segment.text}`;
      last.end = segment.endSecond;
    } else {
      lines.push({ seconds: segment.startSecond, end: segment.endSecond, text: segment.text });
    }
  }
  return lines.map((line) => ({
    at: clockTime(line.seconds),
    seconds: Math.round(line.seconds),
    text: line.text,
  }));
}

/* ─── Storage ─────────────────────────────────────────────────────────── */

async function rootDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, ROOT);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function meetingDirectory(id: string) {
  const { Directory } = await import("expo-file-system");
  const directory = new Directory(await rootDirectory(), id);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

export async function phoneMeetingAudioUri(id: string): Promise<string> {
  const { File } = await import("expo-file-system");
  return new File(await meetingDirectory(id), AUDIO).uri;
}

async function writeRecord(meeting: PhoneMeeting): Promise<void> {
  const { File } = await import("expo-file-system");
  const file = new File(await meetingDirectory(meeting.id), RECORD);
  file.write(JSON.stringify(meeting, null, 2));
}

async function readAll(): Promise<PhoneMeeting[]> {
  const { Directory, File } = await import("expo-file-system");
  const meetings: PhoneMeeting[] = [];
  for (const entry of (await rootDirectory()).list()) {
    if (!(entry instanceof Directory)) continue;
    const file = new File(entry, RECORD);
    if (!file.exists) continue;
    try {
      meetings.push(JSON.parse(await file.text()) as PhoneMeeting);
    } catch {
      // A record cut off mid-write is skipped rather than failing the list.
    }
  }
  return meetings.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/* ─── Store ───────────────────────────────────────────────────────────── */

let snapshot: ReadonlyArray<PhoneMeeting> = [];
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: ReadonlyArray<PhoneMeeting>) {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function reload(): Promise<void> {
  publish(await readAll());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) {
    loaded = true;
    void reload();
  }
  return () => listeners.delete(listener);
}

/** Every meeting recorded on this phone, newest first. */
export function usePhoneMeetings(): ReadonlyArray<PhoneMeeting> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function usePhoneMeeting(id: string): PhoneMeeting | null {
  return usePhoneMeetings().find((meeting) => meeting.id === id) ?? null;
}

export async function savePhoneMeeting(meeting: PhoneMeeting): Promise<void> {
  await writeRecord(meeting);
  publish(
    [meeting, ...snapshot.filter((entry) => entry.id !== meeting.id)].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
  );
}

export async function updatePhoneMeeting(
  id: string,
  change: (meeting: PhoneMeeting) => PhoneMeeting,
): Promise<void> {
  const current =
    snapshot.find((meeting) => meeting.id === id) ?? (await readAll()).find((m) => m.id === id);
  if (!current) return;
  await savePhoneMeeting(change(current));
}

export async function deletePhoneMeeting(id: string): Promise<void> {
  const directory = await meetingDirectory(id);
  directory.delete();
  publish(snapshot.filter((meeting) => meeting.id !== id));
}

/**
 * Transcribes a recording on the device and stores the lines with it. Runs
 * after Stop and again whenever a pending one is found (the app may have been
 * closed mid-way); needs no connection.
 */
export async function transcribePhoneMeeting(id: string): Promise<void> {
  try {
    const segments = await transcribeRecordingOnDevice(await phoneMeetingAudioUri(id));
    await updatePhoneMeeting(id, (meeting) =>
      segments === null
        ? { ...meeting, transcription: "unavailable" }
        : { ...meeting, transcription: "done", transcript: transcriptLines(segments) },
    );
  } catch {
    await updatePhoneMeeting(id, (meeting) => ({ ...meeting, transcription: "failed" }));
  }
}

let resumed = false;
/** Picks up transcriptions an earlier session did not finish. Once per launch. */
export async function resumePendingTranscriptions(): Promise<void> {
  if (resumed) return;
  resumed = true;
  for (const meeting of await readAll()) {
    if (meeting.transcription === "pending") await transcribePhoneMeeting(meeting.id);
  }
}
