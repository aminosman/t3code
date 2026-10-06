import type { HistoryMeetingPart, HistoryMeetingSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessageCircleIcon, NotebookPenIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import {
  AskBar,
  dayLabel,
  Highlighted,
  meetingDate,
  MeetingRow,
  MeetingTile,
} from "./MeetingsParts";
import { MeetingChat } from "./MeetingChat";
import { useMeetings } from "./useMeetings";

/** "My to-dos", "what did we decide": a kind of passage, not words. */
export function meetingIntent(query: string): {
  readonly parts: ReadonlyArray<HistoryMeetingPart> | undefined;
  readonly rest: string;
} {
  let rest = ` ${query.toLowerCase()} `;
  const parts: Array<HistoryMeetingPart> = [];
  const names: ReadonlyArray<[HistoryMeetingPart, ReadonlyArray<string>]> = [
    [
      "action",
      [
        "action items",
        "action item",
        "to-dos",
        "to-do",
        "todos",
        "todo",
        "tasks",
        "follow-ups",
        "next steps",
      ],
    ],
    ["decision", ["decisions", "decision", "decided"]],
  ];
  for (const [part, phrases] of names) {
    for (const phrase of phrases) {
      if (rest.includes(` ${phrase} `) || rest.includes(` ${phrase}?`)) {
        if (!parts.includes(part)) parts.push(part);
        rest = rest.replaceAll(phrase, " ");
      }
    }
  }
  return { parts: parts.length > 0 ? parts : undefined, rest: rest.trim() };
}

const PART_LABEL: Record<string, string> = {
  notes: "Notes",
  action: "Action item",
  decision: "Decision",
  transcript: "Transcript",
  slides: "Shared screen",
};

export function MeetingsHome() {
  const { environmentId, root, asks, ask, asking } = useMeetings();
  // A chat across all meetings, in the panel beside the list; null with the
  // panel open is a new chat, waiting for its first question.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const askHere = async (question: string, followUp: string | null) => {
    setChatOpen(true);
    setChatThreadId(followUp);
    setPending(question);
    const threadId = await ask(question, { threadId: followUp });
    setPending(null);
    if (threadId !== null) setChatThreadId(threadId);
  };
  const openChat = (threadId: string | null) => {
    setChatThreadId(threadId);
    setChatOpen(true);
  };
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 220);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.meetingList({ environmentId, input: { limit: 200 } }),
  );
  const intent = meetingIntent(settled);
  const search = useEnvironmentQuery(
    environmentId === null || settled.length === 0
      ? null
      : serverEnvironment.historySearch({
          environmentId,
          input: {
            query: intent.rest.length > 0 ? intent.rest : settled,
            sources: ["meetings"],
            ...(intent.parts ? { meetingParts: [...intent.parts] } : {}),
            limit: 25,
          },
        }),
  );

  // A meeting's own chat lives on that meeting; here, the chats across them.
  const chats = useMemo(() => {
    const onMeetings = new Set(
      (list.data?.meetings ?? []).flatMap((meeting) =>
        meeting.chatThreadId ? [meeting.chatThreadId] : [],
      ),
    );
    return asks.filter((thread) => !onMeetings.has(thread.id));
  }, [asks, list.data]);

  const byDay = useMemo(() => {
    const groups = new Map<string, { day: Date; meetings: Array<HistoryMeetingSummary> }>();
    for (const meeting of list.data?.meetings ?? []) {
      const date = meetingDate(meeting);
      const day = date
        ? new Date(date.getFullYear(), date.getMonth(), date.getDate())
        : new Date(0);
      const key = day.toISOString();
      const group = groups.get(key) ?? { day, meetings: [] };
      group.meetings.push(meeting);
      groups.set(key, group);
    }
    return [...groups.values()].toSorted((a, b) => b.day.getTime() - a.day.getTime());
  }, [list.data]);

  if (environmentId === null || root === null) {
    return (
      <div className="meetings-surface flex h-full w-full min-w-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <NotebookPenIcon className="size-8 text-(--mt-ink-3)" />
        <p className="mt-serif text-2xl">No meetings yet</p>
        <p className="max-w-sm text-sm text-(--mt-ink-2)">
          tui records your calls and the meetings you start in the room, writes the notes, and they
          appear here — searchable, and ready to ask about.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-1">
      <div className="meetings-surface relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] flex-1 px-8 pt-11 pb-6">
          <div className="mb-6 flex items-end justify-between gap-4">
            <h1 className="mt-serif text-3xl leading-none">Meetings</h1>
            <span className="text-xs text-(--mt-ink-2)">
              {list.data ? `${list.data.meetings.length} recorded` : ""}
            </span>
          </div>
          <label className="mb-8 flex h-[38px] items-center gap-2 rounded-full border border-(--mt-hairline) bg-(--mt-raised) px-3.5">
            <SearchIcon className="size-4 text-(--mt-ink-3)" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search every meeting — notes, action items, what was said"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-(--mt-ink-3)"
            />
          </label>

          {settled.length > 0 ? (
            <section>
              <button
                type="button"
                onClick={() => void askHere(settled, null)}
                disabled={asking}
                className="mb-7 flex w-full items-center gap-2.5 rounded-xl border border-(--mt-hairline) bg-(--mt-raised) px-4 py-3.5 text-left text-sm font-medium hover:bg-(--mt-hover) disabled:opacity-60"
              >
                <SparklesIcon className="size-4 text-(--mt-accent)" />
                <span className="flex-1">Ask your agent across all meetings: “{settled}”</span>
                <span className="text-xs text-(--mt-ink-3)">{asking ? "Asking…" : "↩"}</span>
              </button>
              {search.data ? (
                <p className="mb-2 text-xs font-medium text-(--mt-ink-2-strong)">
                  {search.data.results.length} meeting{search.data.results.length === 1 ? "" : "s"}
                  {search.data.terms.length === 0
                    ? " · newest first"
                    : search.data.meaning.active
                      ? " · by words and meaning"
                      : " · by words"}
                </p>
              ) : search.error ? (
                <p className="text-sm text-(--mt-ink-2)">
                  Search needs a word or two to look for — or ask your agent above.
                </p>
              ) : (
                <p className="text-sm text-(--mt-ink-2)">Searching…</p>
              )}
              {search.data?.results.length === 0 ? (
                <p className="text-sm text-(--mt-ink-2)">
                  Nothing in your meetings matches that. Ask your agent above — it can read every
                  transcript.
                </p>
              ) : null}
              <div className="flex flex-col gap-1.5">
                {search.data?.results.map((result) => (
                  <Link
                    key={result.id}
                    to="/meetings/$meetingId"
                    params={{ meetingId: result.id }}
                    className="-mx-3 flex gap-3 rounded-xl p-3 hover:bg-(--mt-hover)"
                  >
                    <MeetingTile title={result.title} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="flex-1 truncate text-sm font-medium">{result.title}</span>
                        <span className="shrink-0 text-xs text-(--mt-ink-2)">
                          {result.date ? dayLabel(new Date(result.date)) : ""}
                        </span>
                      </span>
                      {result.hits.map((hit) => (
                        <span
                          key={`${hit.role}:${hit.at ?? ""}:${hit.snippet.slice(0, 32)}`}
                          className="mt-1.5 block"
                        >
                          <span className="block text-2xs font-medium tracking-wide text-(--mt-accent) uppercase">
                            {PART_LABEL[hit.role] ?? hit.role}
                            {hit.at ? ` · ${hit.at}` : ""}
                          </span>
                          <span className="line-clamp-3 text-sm leading-relaxed">
                            <Highlighted text={hit.snippet} />
                          </span>
                        </span>
                      ))}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : (
            <>
              {chats.length > 0 ? (
                <section className="mb-9">
                  <h2 className="mb-2 text-xs font-medium text-(--mt-ink-2-strong)">Chats</h2>
                  {chats.slice(0, 4).map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => openChat(thread.id)}
                      className={`-mx-2.5 flex h-10 w-[calc(100%+20px)] items-center gap-3 rounded-lg px-2.5 text-left hover:bg-(--mt-hover) ${
                        chatOpen && chatThreadId === thread.id ? "bg-(--mt-hover)" : ""
                      }`}
                    >
                      <MessageCircleIcon className="size-4 text-(--mt-ink-3)" />
                      <span className="flex-1 truncate text-sm">{thread.title}</span>
                      <span className="text-xs text-(--mt-ink-2)">
                        {dayLabel(new Date(thread.updatedAt))}
                      </span>
                    </button>
                  ))}
                </section>
              ) : null}
              {list.isPending && !list.data ? (
                <p className="text-sm text-(--mt-ink-2)">Loading your meetings…</p>
              ) : null}
              <div className="flex flex-col gap-7">
                {byDay.map((group) => (
                  <section key={group.day.toISOString()}>
                    <h2 className="mb-1.5 text-xs font-medium text-(--mt-ink-2-strong)">
                      {group.day.getTime() === 0 ? "Earlier" : dayLabel(group.day)}
                    </h2>
                    {group.meetings.map((meeting) => (
                      <MeetingRow key={meeting.id} meeting={meeting} />
                    ))}
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
        {chatOpen ? null : (
          <AskBar
            placeholder="Ask anything about your meetings"
            recipe={{
              label: "List my to-dos",
              question:
                "What are all my open to-dos across my meetings, who owns each, and from which meeting?",
            }}
            onAsk={(question) => void askHere(question, null)}
            asking={asking}
          />
        )}
      </div>
      {chatOpen ? (
        <MeetingChat
          environmentId={environmentId}
          threadId={chatThreadId}
          heading="Chat · all meetings"
          placeholder="Ask anything about your meetings"
          asking={asking}
          pending={pending}
          onAsk={(question) => void askHere(question, chatThreadId)}
          onFresh={() => openChat(null)}
          onClose={() => setChatOpen(false)}
        />
      ) : null}
    </div>
  );
}
