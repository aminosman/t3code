import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, HistoryMeetingReadOutput, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, MessageSquarePlusIcon, SendIcon } from "lucide-react";
import { useMemo } from "react";

import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Bars } from "./MeetingsParts";

type MeetingThread = NonNullable<HistoryMeetingReadOutput["threads"]>[number];

/** One row per thread, in the order the meeting first reached it, with every request it got. */
export function groupMeetingThreads(entries: ReadonlyArray<MeetingThread>) {
  const byThread = new Map<
    string,
    { first: MeetingThread; started: boolean; requests: Array<MeetingThread> }
  >();
  for (const entry of entries) {
    const group = byThread.get(entry.threadId);
    if (group) {
      group.requests.push(entry);
      group.started ||= entry.action === "started";
    } else {
      byThread.set(entry.threadId, {
        first: entry,
        started: entry.action === "started",
        requests: [entry],
      });
    }
  }
  return [...byThread.values()];
}

const clock = (at: string) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The meeting's Threads tab: what was asked of Tui in it ("hey Tui, look
 * into…") and the thread each request started or reached — still in its own
 * project, listed here so the meeting shows what it set going.
 */
export function MeetingThreads({
  environmentId,
  threads,
}: {
  environmentId: EnvironmentId;
  threads: ReadonlyArray<MeetingThread>;
}) {
  const shells = useThreadShells();
  const groups = useMemo(() => groupMeetingThreads(threads), [threads]);
  if (groups.length === 0) {
    return (
      <p className="text-sm text-(--mt-ink-2)">
        Nothing was sent to a thread from this meeting. Say “Tui, look into…” during a meeting and
        the thread it starts shows here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {groups.map(({ first, started, requests }) => {
        const shell =
          shells.find(
            (candidate) =>
              candidate.environmentId === environmentId && candidate.id === first.threadId,
          ) ?? null;
        const working = threadRuntimeIsActive(shell?.runtime);
        const ref = scopeThreadRef(environmentId, first.threadId as ThreadId);
        return (
          <Link
            key={first.threadId}
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(ref)}
            className="group -mx-3 flex flex-col gap-1.5 rounded-xl border border-transparent p-3 hover:border-(--mt-hairline) hover:bg-(--mt-raised)"
          >
            <span className="flex items-center gap-2">
              {started ? (
                <MessageSquarePlusIcon className="size-4 shrink-0 text-(--mt-accent)" />
              ) : (
                <SendIcon className="size-4 shrink-0 text-(--mt-accent)" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-(--mt-ink)">
                {shell?.title ?? first.title}
              </span>
              {working ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-(--mt-accent)">
                  <Bars live />
                  Working
                </span>
              ) : null}
              <ArrowUpRightIcon className="size-3.5 shrink-0 text-(--mt-ink-3) group-hover:text-(--mt-ink-2)" />
            </span>
            <span className="pl-6 text-xs text-(--mt-ink-2)">
              {first.project} · {started ? "started from this meeting" : "sent from this meeting"}
            </span>
            {requests.map((entry) => (
              <span
                key={`${entry.at}:${entry.request}`}
                className="flex gap-2 pl-6 text-sm text-(--mt-ink-2)"
              >
                <span className="shrink-0 text-xs tabular-nums text-(--mt-ink-3)">
                  {clock(entry.at)}
                </span>
                <span>“{entry.request}”</span>
              </span>
            ))}
          </Link>
        );
      })}
    </div>
  );
}
