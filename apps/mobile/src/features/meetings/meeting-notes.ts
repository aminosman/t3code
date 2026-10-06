/**
 * Meeting notes are markdown of a narrow kind: headings, bullets, a little
 * bold. They are drawn as Granola draws them — a grey "#" hanging before
 * each heading, bullets below — so a small reader is enough.
 */
export type NoteBlock = { readonly id: string } & (
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "bullet"; readonly text: string; readonly depth: number }
  | { readonly kind: "text"; readonly text: string }
);

function clean(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

export function parseMeetingNotes(markdown: string): ReadonlyArray<NoteBlock> {
  const blocks: NoteBlock[] = [];
  const lines = markdown.split("\n");
  for (const [line, raw] of lines.entries()) {
    const id = `line-${line}`;
    if (raw.trim() === "" || /^-{3,}$/.test(raw.trim())) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(raw.trim());
    if (heading) {
      blocks.push({ id, kind: "heading", text: clean(heading[1] ?? "") });
      continue;
    }
    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(raw);
    if (bullet) {
      const indent = (bullet[1] ?? "").replace(/\t/g, "  ").length;
      blocks.push({
        id,
        kind: "bullet",
        text: clean(bullet[2] ?? ""),
        depth: Math.min(2, Math.floor(indent / 2)),
      });
      continue;
    }
    blocks.push({ id, kind: "text", text: clean(raw) });
  }
  return blocks;
}

/** "Today", "Yesterday", "Monday 5 October". */
export function meetingDayLabel(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "Undated";
  const day = new Date(iso);
  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export function meetingTime(iso: string | null): string {
  if (iso === null) return "";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
