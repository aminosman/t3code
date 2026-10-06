// A meeting's notes (summary.md) as its page draws them: a title, the summary,
// sections of bullets — each line marked as the user's own words or the
// model's. Granola keeps what the user typed in black and what the AI added in
// grey; a line is the user's when it carries most of the words of one line they
// typed (notes.md). Pure, so it is tested.

export interface NoteLine {
  readonly text: string;
  readonly mine: boolean;
}

export interface NoteSection {
  readonly heading: string;
  readonly kind: "action" | "decision" | "points";
  readonly items: ReadonlyArray<NoteLine>;
}

export interface MeetingNotesDocument {
  readonly title: string | null;
  readonly summary: NoteLine | null;
  readonly sections: ReadonlyArray<NoteSection>;
  readonly tags: ReadonlyArray<string>;
  /** "written by Claude Code on your account …" — shown small at the foot. */
  readonly provenance: string | null;
}

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );

/** At least two thirds of the words of something the user typed. */
export function isMine(text: string, typed: ReadonlyArray<Set<string>>): boolean {
  const have = words(text);
  if (have.size === 0) return false;
  return typed.some((mine) => {
    let shared = 0;
    for (const word of mine) if (have.has(word)) shared += 1;
    return shared / mine.size >= 0.67;
  });
}

const sectionKind = (heading: string): NoteSection["kind"] => {
  const name = heading.toLowerCase();
  if (name.includes("action") || name.includes("to-do") || name.includes("next step"))
    return "action";
  if (name.includes("decision")) return "decision";
  return "points";
};

export function parseMeetingNotes(markdown: string, typed: string | null): MeetingNotesDocument {
  const mine = (typed ?? "")
    .split("\n")
    .map(words)
    .filter((set) => set.size >= 2);
  const line = (text: string): NoteLine => ({ text, mine: isMine(text, mine) });
  let title: string | null = null;
  let summary: NoteLine | null = null;
  const sections: Array<{ heading: string; kind: NoteSection["kind"]; items: Array<NoteLine> }> =
    [];
  let tags: Array<string> = [];
  let provenance: string | null = null;
  let paragraph: Array<string> = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    paragraph = [];
    if (sections.length === 0) {
      summary = summary === null ? line(text) : line(`${summary.text}\n\n${text}`);
    } else {
      sections[sections.length - 1]!.items.push(line(text));
    }
  };
  for (const raw of markdown.split("\n")) {
    const s = raw.trim();
    if (s.length === 0) {
      flush();
      continue;
    }
    if (/^#{2,6}\s/.test(s)) {
      flush();
      const heading = s.replace(/^#+\s*/, "");
      sections.push({ heading, kind: sectionKind(heading), items: [] });
    } else if (/^#\s/.test(s)) {
      flush();
      title ??= s.slice(2).trim();
    } else if (/^[-*•]\s/.test(s)) {
      flush();
      if (sections.length === 0) sections.push({ heading: "", kind: "points", items: [] });
      sections[sections.length - 1]!.items.push(line(s.slice(2).trim()));
    } else if (/^tags:/i.test(s)) {
      flush();
      tags = s
        .slice(5)
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
    } else if (s.startsWith("<sub>")) {
      flush();
      provenance = s.replace(/<\/?sub>/g, "").trim();
    } else {
      paragraph.push(s);
    }
  }
  flush();
  return { title, summary, sections, tags, provenance };
}

/** "[[2026.09.30-1335]]" → the meeting folders an answer cites, in order. */
export function meetingCitations(text: string): ReadonlyArray<string> {
  const out: Array<string> = [];
  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const id = match[1]!.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** "2026.09.30-1335" → its start, local time. */
export function meetingStart(id: string): Date | null {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})(\d{2})/.exec(id);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

/** Named people first; voices nobody has named ("Speaker a8cb") are counted. */
export function peopleLine(people: ReadonlyArray<string>): string {
  const named = people.filter((person) => !/^speaker\b/i.test(person));
  const unnamed = people.length - named.length;
  let text =
    named.length === 0
      ? ""
      : named.length === 1
        ? named[0]!
        : named.length === 2
          ? `${named[0]} & ${named[1]}`
          : `${named[0]}, ${named[1]} & ${named.length - 2} others`;
  if (unnamed > 0)
    text =
      text.length === 0 ? `${unnamed} voice${unnamed === 1 ? "" : "s"}` : `${text} +${unnamed}`;
  return text;
}

// A context link's id is [a-z0-9_-]; a meeting's ("2026.09.30-1335") is not,
// so every other character travels as _ and its hex code.
const encodeMeetingRef = (id: string) =>
  [...id]
    .map((char) =>
      /[A-Za-z0-9-]/.test(char) ? char : `_${char.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    )
    .join("");
export const decodeMeetingRef = (ref: string) =>
  ref.replace(/_([0-9a-f]{4})/gi, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );

/**
 * The agent names each meeting it draws on as [[2026.09.30-1335]]: a chip that
 * opens it. On a meeting's own page, naming that meeting says nothing, so it
 * is left out (`here`).
 */
export function linkMeetingCitations(text: string, here: string | null = null): string {
  return text.replace(/ ?\[\[([\p{L}\p{N}][\p{L}\p{N}._ -]*)\]\]/gu, (whole, id: string) =>
    id === here
      ? ""
      : `${whole.startsWith(" ") ? " " : ""}[${id}](t3-context://v1/meeting/${encodeMeetingRef(id)})`,
  );
}
