import type { HistoryMeetingSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { meetingStart, peopleLine } from "./meetingNotes";

/** The pastel tile behind a meeting's initial, stable per title. */
const TILES = ["#fbefb8", "#e4e4de", "#f8ddf0", "#d9ecf7", "#e2f0c9", "#f6e1cf"];
export function MeetingTile({ title }: { title: string }) {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return (
    <span
      className="mt-serif flex size-7 shrink-0 items-center justify-center rounded-md text-base text-(--mt-tile-ink)"
      style={{ background: TILES[hash % TILES.length] }}
    >
      {title.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function dayLabel(day: Date): string {
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function meetingDate(meeting: Pick<HistoryMeetingSummary, "id" | "startedAt">): Date | null {
  return meeting.startedAt ? new Date(meeting.startedAt) : meetingStart(meeting.id);
}

/** Granola's row: the tile, the title over who was there, the time. */
export function MeetingRow({ meeting }: { meeting: HistoryMeetingSummary }) {
  const date = meetingDate(meeting);
  const people = peopleLine(meeting.people);
  const sub = [people, meeting.projectTitle].filter(Boolean).join(" · ");
  return (
    <Link
      to="/meetings/$meetingId"
      params={{ meetingId: meeting.id }}
      className="-mx-2.5 flex h-[46px] items-center gap-3 rounded-lg px-2.5 transition-colors hover:bg-(--mt-hover)"
    >
      <MeetingTile title={meeting.title} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-(--mt-ink)">{meeting.title}</span>
        {sub.length > 0 || meeting.durationMinutes ? (
          <span className="block truncate text-xs text-(--mt-ink-2)">
            {sub.length > 0 ? sub : `${meeting.durationMinutes} min`}
          </span>
        ) : null}
      </span>
      {meeting.live ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-(--mt-accent)">
          <Bars live />
          Recording
        </span>
      ) : (
        <span className="shrink-0 text-xs tabular-nums text-(--mt-ink-2)">
          {date?.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </span>
      )}
    </Link>
  );
}

/** «matched» words in ink, the rest grey. */
export function Highlighted({ text }: { text: string }) {
  const parts: Array<ReactNode> = [];
  const flat = text.replace(/\s+/g, " ");
  let index = 0;
  for (const match of flat.matchAll(/«([^»]*)»/g)) {
    parts.push(flat.slice(index, match.index));
    parts.push(
      <strong key={match.index} className="font-semibold text-(--mt-ink)">
        {match[1]}
      </strong>,
    );
    index = (match.index ?? 0) + match[0].length;
  }
  parts.push(flat.slice(index));
  return <span className="text-(--mt-ink-2)">{parts}</span>;
}

/**
 * Granola's chat bar: a white capsule at the foot of the page, the question
 * typed in it asked of the user's agent, a recipe chip beside it.
 */
export function AskBar({
  placeholder,
  recipe,
  onAsk,
  asking,
  disabled,
}: {
  placeholder: string;
  recipe?: { label: string; question: string };
  onAsk: (question: string) => void;
  asking: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const send = (question: string) => {
    if (question.trim().length === 0 || asking || disabled) return;
    onAsk(question);
    setText("");
  };
  return (
    <div className="pointer-events-none sticky bottom-0 z-10 bg-linear-to-t from-(--mt-surface) from-55% to-transparent px-8 pt-10 pb-5">
      <form
        className="pointer-events-auto mx-auto flex h-[52px] max-w-[680px] items-center gap-2.5 rounded-full border border-(--mt-hairline) bg-(--mt-raised) pr-2 pl-5 mt-float"
        onSubmit={(event) => {
          event.preventDefault();
          send(text);
        }}
      >
        <SparklesIcon className="size-4 shrink-0 text-(--mt-accent)" />
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={asking ? "Asking…" : placeholder}
          disabled={asking || disabled}
          className="min-w-0 flex-1 bg-transparent text-base text-(--mt-ink) outline-none placeholder:text-(--mt-ink-3)"
        />
        {recipe ? (
          <button
            type="button"
            onClick={() => send(recipe.question)}
            disabled={asking || disabled}
            className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-full border border-(--mt-hairline) px-2.5 text-sm text-(--mt-ink) hover:bg-(--mt-hover) disabled:opacity-50"
          >
            <span className="flex size-[18px] items-center justify-center rounded-sm bg-(--mt-accent-tint) text-2xs font-bold text-(--mt-accent)">
              /
            </span>
            {recipe.label}
          </button>
        ) : null}
      </form>
    </div>
  );
}

/** Three bars that move while something is being heard or worked on. */
export function Bars({ live, color }: { live: boolean; color?: string }) {
  return (
    <span className="flex h-5 w-[18px] items-center justify-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={live ? "mt-bar w-[3px] rounded-full" : "w-[3px] rounded-full"}
          style={{
            height: i === 1 ? 16 : 12,
            background: color ?? (live ? "var(--mt-bars)" : "var(--mt-ink-3)"),
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </span>
  );
}
