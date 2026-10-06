import { Link } from "@tanstack/react-router";
import { CalendarIcon, ChevronLeftIcon, FolderIcon, SparkleIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { parseMeetingNotes, peopleLine, type MeetingNotesDocument } from "./meetingNotes";
import { AskBar, Bars, meetingDate } from "./MeetingsParts";
import { useMeetings } from "./useMeetings";

type View = "notes" | "mine" | "transcript";

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex h-7 items-center gap-1.5 rounded-full border border-(--mt-hairline) bg-(--mt-surface) px-2.5 text-sm text-(--mt-ink-2-strong)">
      {icon}
      {children}
    </span>
  );
}

/** The written notes: "#" hanging before each heading, the model's lines grey, the user's in ink. */
function NoteBody({ doc }: { doc: MeetingNotesDocument }) {
  return (
    <div className="flex flex-col gap-7 text-base leading-relaxed">
      {doc.summary ? (
        <p className={doc.summary.mine ? "text-(--mt-ink)" : "text-(--mt-ink-2)"}>
          {doc.summary.text}
        </p>
      ) : null}
      {doc.sections.map((section) => (
        <section key={section.heading || "points"}>
          {section.heading ? (
            <h3 className="relative mb-2 text-lg font-semibold text-(--mt-ink-2-strong)">
              <span className="absolute -left-6 font-normal text-(--mt-ink-3)">#</span>
              {section.heading}
            </h3>
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {section.items.map((item, itemIndex) => (
              <li
                key={`${item.text}:${itemIndex}`}
                className={`flex gap-2.5 pl-1.5 ${item.mine ? "text-(--mt-ink)" : "text-(--mt-ink-2)"}`}
              >
                <span className="text-(--mt-ink-2)">•</span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {doc.provenance ? <p className="text-2xs text-(--mt-ink-3)">{doc.provenance}</p> : null}
    </div>
  );
}

/** Granola's bubbles: the far side grey on the left, the user olive on the right. */
function Transcript({
  lines,
}: {
  lines: ReadonlyArray<{ at: string; seconds: number; speaker: string; text: string }>;
}) {
  if (lines.length === 0) {
    return (
      <p className="text-sm text-(--mt-ink-2)">
        No transcript yet — tui transcribes when the meeting ends.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="mb-3 text-center text-xs text-(--mt-ink-2)">
        Always get consent when recording others.
      </p>
      {lines.map((line, index) => {
        const previous = lines[index - 1];
        const turn = previous === undefined || previous.speaker !== line.speaker;
        const stamp = turn && (previous === undefined || line.seconds - previous.seconds >= 20);
        const mine = line.speaker === "me";
        return (
          <div
            key={`${line.seconds}:${line.speaker}:${line.text.slice(0, 24)}`}
            className={`flex flex-col ${mine ? "items-end" : "items-start"}`}
          >
            {stamp ? (
              <span className="my-2 self-center text-2xs tabular-nums text-(--mt-ink-3)">
                {line.at}
              </span>
            ) : null}
            {turn && !mine && line.speaker !== "them" ? (
              <span className="mb-0.5 px-1 text-2xs font-medium text-(--mt-ink-2)">
                {line.speaker}
              </span>
            ) : null}
            <span
              className={`max-w-[520px] rounded-lg px-3 py-1.5 text-sm leading-snug text-(--mt-ink) ${
                mine ? "bg-(--mt-bubble-me)" : "bg-(--mt-bubble-them)"
              }`}
            >
              {line.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function MeetingPage({ meetingId }: { meetingId: string }) {
  const { environmentId, ask, asking } = useMeetings();
  const read = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.meetingRead({ environmentId, input: { meetingId, whole: true } }),
  );
  const meeting = read.data;
  const writeNotes = useAtomCommand(serverEnvironment.writeMeetingNotes, { reportFailure: false });
  const [view, setView] = useState<View | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doc = useMemo(
    () => (meeting?.notes ? parseMeetingNotes(meeting.notes, meeting.myNotes) : null),
    [meeting?.notes, meeting?.myNotes],
  );
  const shown: View = view ?? (doc ? "notes" : "mine");
  const text = typed ?? meeting?.myNotes ?? "";

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const onType = (value: string) => {
    setTyped(value);
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (environmentId === null) return;
      void writeNotes({ environmentId, input: { meetingId, text: value } }).then(() =>
        setSaved(true),
      );
    }, 600);
  };

  const date = meeting
    ? meetingDate({ id: meeting.meeting.id, startedAt: meeting.meeting.startedAt })
    : null;
  const title = doc?.title ?? meeting?.meeting.title ?? meetingId;

  const segment = (key: View, label: ReactNode) => (
    <button
      type="button"
      onClick={() => setView(key)}
      className={`flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${
        shown === key ? "bg-(--mt-raised) text-(--mt-ink) mt-lift" : "text-(--mt-ink-2)"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="meetings-surface relative flex h-full w-full min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between bg-(--mt-surface)/90 px-5 py-3 backdrop-blur">
        <Link
          to="/meetings"
          className="flex h-7 items-center gap-1.5 rounded-full border border-(--mt-hairline) bg-(--mt-raised) px-3 text-xs font-medium text-(--mt-ink-2-strong)"
        >
          <ChevronLeftIcon className="size-3.5" />
          Meetings
        </Link>
        <div className="flex items-center gap-0.5 rounded-full bg-(--mt-hover) p-0.5">
          {doc
            ? segment(
                "notes",
                <>
                  <SparkleIcon className="size-3" />
                  Notes
                </>,
              )
            : null}
          {segment("mine", "My notes")}
          {segment("transcript", "Transcript")}
        </div>
      </div>

      <article className="mx-auto w-full max-w-[680px] flex-1 px-10 pt-4 pb-6">
        {read.isPending && !meeting ? (
          <p className="text-sm text-(--mt-ink-2)">Opening the meeting…</p>
        ) : null}
        {meeting === null ? (
          <p className="text-sm text-(--mt-ink-2)">This meeting is not on this computer.</p>
        ) : null}
        {meeting ? (
          <>
            <h1 className="mt-serif mb-3 text-3xl leading-tight">{title}</h1>
            <div className="mb-7 flex flex-wrap gap-2">
              {date ? (
                <Chip icon={<CalendarIcon className="size-3.5" />}>
                  {date.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                  {meeting.meeting.durationMinutes
                    ? ` · ${meeting.meeting.durationMinutes} min`
                    : ""}
                </Chip>
              ) : null}
              <Chip icon={<UsersIcon className="size-3.5" />}>
                {peopleLine(meeting.meeting.people) || "Me"}
              </Chip>
              {meeting.meeting.projectTitle ? (
                <Chip icon={<FolderIcon className="size-3.5" />}>
                  {meeting.meeting.projectTitle}
                </Chip>
              ) : null}
              {doc?.tags.slice(0, 3).map((tag) => (
                <Chip key={tag} icon={null}>
                  #{tag}
                </Chip>
              ))}
            </div>

            {shown === "notes" && doc ? <NoteBody doc={doc} /> : null}
            {shown === "notes" && !doc ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-(--mt-hairline) bg-(--mt-raised) px-4 py-3 text-sm">
                <Bars live />
                <span className="font-medium text-(--mt-accent)">Writing the notes</span>
                <span className="text-(--mt-ink-2)">
                  · they appear here when the transcript is read
                </span>
              </div>
            ) : null}
            {shown === "mine" ? (
              <div>
                <textarea
                  value={text}
                  onChange={(event) => onType(event.target.value)}
                  placeholder="Write notes — the points you write are kept, in your words, in the notes"
                  className="min-h-[50vh] w-full resize-none bg-transparent text-base leading-loose text-(--mt-ink) outline-none placeholder:text-(--mt-ink-3)"
                />
                <p className="text-2xs text-(--mt-ink-3)">{saved ? "Saved" : "Saving…"}</p>
              </div>
            ) : null}
            {shown === "transcript" ? <Transcript lines={meeting.lines} /> : null}
          </>
        ) : null}
      </article>
      <AskBar
        placeholder="Ask about this meeting"
        recipe={{
          label: "Write follow-up email",
          question:
            "Write a short follow-up email to the people in this meeting: what we agreed and who is doing what.",
        }}
        onAsk={(question) => void ask(question, meetingId)}
        asking={asking}
        disabled={!meeting}
      />
    </div>
  );
}
