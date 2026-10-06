import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpIcon, ExternalLinkIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import ChatMarkdown, { type ChatMarkdownContextReference } from "~/components/ChatMarkdown";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useThreadShell, useThreadVisibleTurnItems } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { buildThreadRouteParams } from "~/threadRoutes";

import { decodeMeetingRef, linkMeetingCitations, meetingStart } from "./meetingNotes";
import { Bars } from "./MeetingsParts";

/** What a chat asked the server: its first question names the meeting for the agent. */
const MEETING_PREFIX = /^About the meeting \[\[[^\]]+\]\]: /;

function MeetingChip({
  reference,
  titleOf,
}: {
  reference: ChatMarkdownContextReference;
  titleOf: (meetingId: string) => string | undefined;
}) {
  if (reference.kind !== "meeting") return <span>{reference.label}</span>;
  const id = decodeMeetingRef(reference.contextId);
  const date = meetingStart(id);
  const label =
    titleOf(id) ??
    date?.toLocaleDateString(undefined, { month: "short", day: "numeric" }) ??
    reference.label;
  return (
    <Link
      to="/meetings/$meetingId"
      params={{ meetingId: id }}
      className="mx-0.5 inline-flex max-w-[220px] items-center rounded-md bg-(--mt-accent-tint) px-1.5 align-baseline text-xs font-medium text-(--mt-accent) no-underline hover:underline"
    >
      <span className="truncate">{label}</span>
    </Link>
  );
}

const PANEL_ACTION =
  "flex size-7 items-center justify-center rounded-full text-(--mt-ink-2) hover:bg-(--mt-hover)";

function PanelAction({
  label,
  render,
  children,
}: {
  label: string;
  render: ReactElement;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={render} aria-label={label}>
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Granola's chat: a panel beside the notes, the conversation with the user's
 * agent about this meeting (or all of them). The thread behind it lives in
 * the Meetings project; it is shown here, where the user's thoughts are, and
 * opens as a full thread only when asked to.
 */
export function MeetingChat({
  environmentId,
  threadId,
  heading,
  placeholder,
  asking,
  onAsk,
  onFresh,
  onClose,
  pending,
  meetingId = null,
}: {
  environmentId: EnvironmentId;
  threadId: string | null;
  heading: string;
  placeholder: string;
  asking: boolean;
  onAsk: (question: string) => void;
  onFresh?: (() => void) | undefined;
  onClose: () => void;
  /** The question being asked, shown until the thread has it. */
  pending: string | null;
  /** The meeting this chat is about, when it is about one. */
  meetingId?: string | null;
}) {
  const ref = useMemo(
    () => (threadId === null ? null : scopeThreadRef(environmentId, threadId as ThreadId)),
    [environmentId, threadId],
  );
  const items = useThreadVisibleTurnItems(ref);
  const shell = useThreadShell(ref);
  const working = asking || threadRuntimeIsActive(shell?.runtime);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // The same listing the Meetings home reads: citations show a meeting's title.
  const listing = useEnvironmentQuery(
    serverEnvironment.meetingList({ environmentId, input: { limit: 200 } }),
  );
  const titleOf = useMemo(() => {
    const titles = new Map(listing.data?.meetings.map((meeting) => [meeting.id, meeting.title]));
    return (meetingId: string) => titles.get(meetingId);
  }, [listing.data]);

  const messages = useMemo(
    () =>
      items.flatMap(({ item }) =>
        item.type === "user_message"
          ? [
              {
                id: item.id,
                mine: true,
                text: item.text.replace(MEETING_PREFIX, ""),
                streaming: false,
              },
            ]
          : item.type === "assistant_message" && item.text.trim().length > 0
            ? [
                {
                  id: item.id,
                  mine: false,
                  text: linkMeetingCitations(item.text, meetingId),
                  streaming: item.streaming,
                },
              ]
            : [],
      ),
    [items, meetingId],
  );

  // Follow the answer as it is written, unless the user scrolled up to read.
  const last = messages.at(-1);
  const atEnd = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (list && atEnd.current) list.scrollTop = list.scrollHeight;
  });

  const send = () => {
    const question = text.trim();
    if (question.length === 0 || asking) return;
    onAsk(question);
    setText("");
  };

  return (
    <aside className="meetings-surface flex h-full w-[min(420px,42vw)] shrink-0 flex-col border-l border-(--mt-hairline) bg-(--mt-surface)">
      <div className="flex h-[52px] shrink-0 items-center gap-1 px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-(--mt-ink)">
          {heading}
        </span>
        {onFresh && threadId !== null ? (
          <PanelAction
            label="New chat"
            render={<button type="button" onClick={onFresh} className={PANEL_ACTION} />}
          >
            <SquarePenIcon className="size-3.5" />
          </PanelAction>
        ) : null}
        {ref !== null ? (
          <PanelAction
            label="Open as a thread"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(ref)}
                className={PANEL_ACTION}
              />
            }
          >
            <ExternalLinkIcon className="size-3.5" />
          </PanelAction>
        ) : null}
        <PanelAction
          label="Close"
          render={<button type="button" onClick={onClose} className={PANEL_ACTION} />}
        >
          <XIcon className="size-4" />
        </PanelAction>
      </div>

      <div
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
        }}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4"
      >
        {messages.length === 0 && !working && pending === null ? (
          <p className="mt-6 text-center text-sm text-(--mt-ink-2)">
            Ask anything — your agent reads the notes and the transcript, and answers here.
          </p>
        ) : null}
        {messages.map((message) =>
          message.mine ? (
            <div
              key={message.id}
              className="max-w-[85%] self-end rounded-lg bg-(--mt-bubble-me) px-3 py-1.5 text-sm whitespace-pre-wrap text-(--mt-ink)"
            >
              {message.text}
            </div>
          ) : (
            <div key={message.id} className="text-sm leading-relaxed text-(--mt-ink)">
              <ChatMarkdown
                text={message.text}
                cwd={undefined}
                isStreaming={message.streaming}
                renderContextReference={(reference) => (
                  <MeetingChip reference={reference} titleOf={titleOf} />
                )}
              />
            </div>
          ),
        )}
        {pending !== null && asking ? (
          <div className="max-w-[85%] self-end rounded-lg bg-(--mt-bubble-me) px-3 py-1.5 text-sm whitespace-pre-wrap text-(--mt-ink)">
            {pending}
          </div>
        ) : null}
        {working && !last?.streaming ? (
          <div className="flex items-center gap-2 text-xs text-(--mt-ink-2)">
            <Bars live />
            Reading your meetings…
          </div>
        ) : null}
      </div>

      <form
        className="m-3 mt-0 flex items-end gap-2 rounded-2xl border border-(--mt-hairline) bg-(--mt-raised) py-2 pr-2 pl-3.5 mt-float"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          className="max-h-32 min-h-[28px] min-w-0 flex-1 resize-none bg-transparent py-1 text-sm text-(--mt-ink) outline-none field-sizing-content placeholder:text-(--mt-ink-3)"
        />
        <button
          type="submit"
          disabled={asking || text.trim().length === 0}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--mt-accent) text-white disabled:opacity-40"
        >
          <ArrowUpIcon className="size-4" />
        </button>
      </form>
    </aside>
  );
}
