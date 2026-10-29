import { useLocation } from "@tanstack/react-router";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { groupOwnedThreads, isLiveThread } from "@t3tools/client-runtime/state/ownedThreads";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useSidebarProjectsAndThreads } from "../meetings/sidebarWithoutMeetings";

const OwnedThreads = createContext<ReadonlyMap<string, readonly EnvironmentThreadShell[]>>(
  new Map(),
);

export function SidebarOwnedThreadsProvider({ children }: { children: ReactNode }) {
  const { threads } = useSidebarProjectsAndThreads();
  const projects = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    const list = projects.get(key) ?? [];
    list.push(thread);
    projects.set(key, list);
  }
  const owned = new Map<string, readonly EnvironmentThreadShell[]>();
  for (const list of projects.values()) {
    const { childrenByOwner } = groupOwnedThreads(list);
    for (const [ownerId, children] of childrenByOwner) {
      owned.set(`${list[0]!.environmentId}:${ownerId}`, children);
    }
  }

  return <OwnedThreads value={owned}>{children}</OwnedThreads>;
}

export function SidebarOwnedThreads({
  threadRef,
  onActivate,
}: {
  threadRef: ScopedThreadRef;
  onActivate: (ref: ScopedThreadRef) => void;
}) {
  const owned = useContext(OwnedThreads);
  const pathname = useLocation({ select: (location) => location.pathname });
  const children = owned.get(scopedThreadKey(threadRef)) ?? [];
  const [expandedOverride, setExpanded] = useState<boolean | null>(null);
  const includesActive = (threads: readonly EnvironmentThreadShell[]): boolean =>
    threads.some(
      (thread) =>
        pathname.endsWith(`/${encodeURIComponent(thread.id)}`) ||
        includesActive(owned.get(`${thread.environmentId}:${thread.id}`) ?? []),
    );
  const expanded = expandedOverride ?? (children.some(isLiveThread) || includesActive(children));
  if (children.length === 0) return null;
  return (
    <li className="ml-4 list-none">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-sidebar-muted-foreground"
      >
        <ChevronRightIcon className={expanded ? "size-3 rotate-90" : "size-3"} />
        {expanded ? "Hide" : "Show"} {children.length} owned threads
      </button>
      {expanded ? (
        <ul>
          {children.map((thread) => {
            const ref = scopeThreadRef(thread.environmentId, thread.id);
            return (
              <li key={scopedThreadKey(ref)} className="list-none">
                <button
                  type="button"
                  onClick={() => onActivate(ref)}
                  className="block w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-row-hover"
                >
                  {thread.title}
                </button>
                <ul>
                  <SidebarOwnedThreads threadRef={ref} onActivate={onActivate} />
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
