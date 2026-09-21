/**
 * Meetings — the recordings tui keeps on this Mac, read as files.
 *
 * tui records a call into one folder per meeting (`~/Meetings/2026.09.21-1330`)
 * and writes beside the audio what an agent can use: `summary.md` (the notes),
 * `transcript.md` (who said what, when), `slides.md` (what was on screen),
 * `meta.json` (when, how long, which window) and `project.json` (which project
 * it was filed under, and who was named). Nothing here writes to that folder,
 * and nothing here needs tui to be running: the files are the interface.
 *
 * @module historySearch/Meetings
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

export interface TranscriptLine {
  /** m:ss into the recording, as the transcript writes it. */
  readonly at: string;
  readonly seconds: number;
  readonly speaker: string;
  readonly text: string;
}

export interface Meeting {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string | null;
  readonly durationSeconds: number | null;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  readonly people: ReadonlyArray<string>;
  readonly notes: string | null;
  readonly slides: string | null;
  readonly lines: ReadonlyArray<TranscriptLine>;
}

export interface MeetingDocument {
  readonly role: "notes" | "transcript" | "slides";
  /** Where a transcript passage starts; null for notes and slides. */
  readonly at: string | null;
  readonly text: string;
}

const expandHome = (value: string) =>
  value === "~" || value.startsWith("~/") ? `${NodeOS.homedir()}${value.slice(1)}` : value;

const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  });

const readJson = (file: string) =>
  readText(file).pipe(
    Effect.map((text): Record<string, unknown> | null => {
      if (text === null) return null;
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }),
  );

/** `meetings.dir` from tui's config (it kept kea's config home), else ~/Meetings. */
export const configuredDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configHome = expandHome(process.env.KEA_CONFIG_DIR?.trim() || "~/.config/kea");
  const config = yield* readJson(path.join(configHome, "config.json"));
  const meetings = config?.["meetings"];
  const dir =
    typeof meetings === "object" && meetings !== null
      ? (meetings as Record<string, unknown>)["dir"]
      : undefined;
  return expandHome(typeof dir === "string" && dir.trim().length > 0 ? dir.trim() : "~/Meetings");
});

/** A folder name is the id, and the only part of a path a caller supplies. */
const isMeetingId = (id: string) =>
  /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(id) && !id.includes("..");

const INDEXED_FILES = ["summary.md", "transcript.md", "slides.md", "meta.json", "project.json"];

/**
 * Every meeting folder that has something to read, with a version that
 * changes when any of its files does. A meeting still being transcribed has no
 * notes or transcript yet and is left for the next look.
 */
export const scan = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const found: Array<{ readonly id: string; readonly version: string }> = [];
    for (const name of names.toSorted()) {
      if (!isMeetingId(name)) continue;
      const stamps: Array<string> = [];
      let readable = false;
      for (const file of INDEXED_FILES) {
        const info = yield* fs.stat(path.join(dir, name, file)).pipe(Effect.option);
        if (info._tag === "None" || info.value.type !== "File") continue;
        if (file === "summary.md" || file === "transcript.md") readable = true;
        const modified = info.value.mtime._tag === "Some" ? info.value.mtime.value.getTime() : 0;
        stamps.push(`${file}:${modified}:${info.value.size}`);
      }
      if (readable) found.push({ id: name, version: stamps.join("|") });
    }
    return found;
  });

/** "12:04" or "1:02:33" into seconds. */
export const seconds = (at: string): number | null => {
  const parts = at.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/u.test(part))) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
};

const LINE = /^\*\*\[(\d+(?::\d+){1,2})\]\s*([^*]*?):\*\*\s*(.*)$/u;

export const parseTranscript = (markdown: string): ReadonlyArray<TranscriptLine> => {
  const lines: Array<TranscriptLine> = [];
  for (const raw of markdown.split("\n")) {
    const match = LINE.exec(raw.trim());
    if (match === null) continue;
    const at = match[1]!;
    const text = match[3]!.trim();
    if (text.length === 0) continue;
    lines.push({ at, seconds: seconds(at) ?? 0, speaker: match[2]!.trim(), text });
  }
  return lines;
};

// The notes end with a line saying which local model wrote them. True, and of
// no use to a search.
const stripGeneratedBy = (notes: string) =>
  notes.replace(/\n*<sub>generated[^\n]*<\/sub>\s*$/u, "");

/** The notes' first heading, when it says more than "Meeting Notes". */
const ownHeading = (notes: string | null): string | null => {
  const heading = /^#\s+(.+)$/mu.exec(notes ?? "")?.[1]?.trim() ?? null;
  return heading === null || /^meeting notes$/iu.test(heading) ? null : heading;
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export const load = (dir: string, id: string) =>
  Effect.gen(function* () {
    if (!isMeetingId(id)) return null;
    const path = yield* Path.Path;
    const folder = path.join(dir, id);
    const notes = yield* readText(path.join(folder, "summary.md"));
    const transcript = yield* readText(path.join(folder, "transcript.md"));
    if (notes === null && transcript === null) return null;
    const slides = yield* readText(path.join(folder, "slides.md"));
    const meta = yield* readJson(path.join(folder, "meta.json"));
    const project = yield* readJson(path.join(folder, "project.json"));

    const context = meta?.["context"];
    const windowTitle =
      typeof context === "object" && context !== null
        ? str((context as Record<string, unknown>)["title"])
        : null;
    const people = Array.isArray(project?.["people"])
      ? (project["people"] as ReadonlyArray<unknown>).filter(
          (person): person is string => typeof person === "string",
        )
      : [];
    const duration = meta?.["duration_seconds"];
    return {
      id,
      // The notes' own heading is "Meeting Notes" every time; the window the
      // call ran in ("Meet - Ficra Team Sync") says which meeting it was.
      title: windowTitle ?? ownHeading(notes) ?? id,
      startedAt: str(meta?.["started"]),
      durationSeconds: typeof duration === "number" ? Math.round(duration) : null,
      projectId: str(project?.["projectId"]),
      projectTitle: str(project?.["name"]),
      people,
      notes: notes === null ? null : stripGeneratedBy(notes).trim() || null,
      slides: slides?.trim() || null,
      lines: transcript === null ? [] : parseTranscript(transcript),
    } satisfies Meeting;
  });

const PASSAGE_CHARS = 900;

/**
 * What a meeting puts in the index: its notes whole, its slides whole, and its
 * transcript in passages of a few exchanges each — long enough that the words
 * of one point in the conversation land together, short enough that a hit says
 * where in an hour to read.
 */
export const documents = (meeting: Meeting): ReadonlyArray<MeetingDocument> => {
  const docs: Array<MeetingDocument> = [];
  if (meeting.notes !== null) {
    docs.push({ role: "notes", at: null, text: `${meeting.title}\n${meeting.notes}` });
  }
  if (meeting.slides !== null) docs.push({ role: "slides", at: null, text: meeting.slides });
  let passage: Array<TranscriptLine> = [];
  let size = 0;
  const flush = () => {
    if (passage.length === 0) return;
    docs.push({
      role: "transcript",
      at: passage[0]!.at,
      text: passage.map((line) => `${line.speaker}: ${line.text}`).join("\n"),
    });
    passage = [];
    size = 0;
  };
  for (const line of meeting.lines) {
    passage.push(line);
    size += line.text.length + line.speaker.length + 2;
    if (size >= PASSAGE_CHARS) flush();
  }
  flush();
  return docs;
};
