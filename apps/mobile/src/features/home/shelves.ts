import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { threadHasUnseenCompletion } from "../threads/threadListV2";

/**
 * The home screen's rows: one per status, in the desktop sidebar's words and
 * order (resolveThreadStatusPill in apps/web Sidebar.logic.ts) — Pending
 * approval, Awaiting input, Working, Connecting, Waiting, Plan ready,
 * Completed — then what the desktop leaves without a pill, split the same
 * way: Failed, Usage limit, Stopped, Done, Not started. Each thread lands on
 * exactly one row; subagent threads never get a card of their own and are
 * counted on the thread that started them.
 */
export type ShelfCardState =
  | "needs-approval"
  | "needs-input"
  | "working"
  | "connecting"
  | "waiting"
  | "plan-ready"
  | "completed"
  | "error"
  | "limited"
  | "stopped"
  | "done"
  | "new";

/** A row is a status. */
export type ShelfKind = ShelfCardState;

export const SHELF_ORDER: ReadonlyArray<ShelfKind> = [
  "needs-approval",
  "needs-input",
  "working",
  "connecting",
  "waiting",
  "plan-ready",
  "completed",
  "error",
  "limited",
  "stopped",
  "done",
  "new",
];

export interface ShelfCard {
  readonly thread: EnvironmentThreadShell;
  readonly state: ShelfCardState;
  /** Subagent threads under this one, at any depth. */
  readonly agentCount: number;
  /** Of those, how many are working now. */
  readonly agentsWorking: number;
  /** When the card's state last changed, for ordering and "2m". */
  readonly activityAt: string;
}

export type Shelves = Readonly<Record<ShelfKind, ReadonlyArray<ShelfCard>>>;

/** Cards per shelf; the rest are one swipe away in Chats. */
export const SHELF_LIMIT = 12;

/** Done work older than this has left the home screen. */
const DONE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function isSubagent(thread: EnvironmentThreadShell): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

function threadKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return `${thread.environmentId}:${thread.id}`;
}

export function shelfCardState(thread: EnvironmentThreadShell): ShelfCardState {
  if (thread.hasPendingApprovals) return "needs-approval";
  if (thread.hasPendingUserInput) return "needs-input";
  const status = thread.runtime?.status;
  if (status === "running" || status === "waiting") return "working";
  if (status === "preparing" || status === "starting" || status === "queued") return "connecting";
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return "waiting";
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    !threadRuntimeIsActive(thread.runtime)
  ) {
    return "plan-ready";
  }
  if (threadHasUnseenCompletion(thread)) return "completed";
  if (status === "failed") {
    return thread.runtime?.lastErrorClass === "usage_limit" ? "limited" : "error";
  }
  if (thread.latestRun?.status === "failed") return "error";
  const run = thread.latestRun?.status;
  if (run === "interrupted" || run === "cancelled" || run === "rolled_back") return "stopped";
  if (thread.latestRun === null) return "new";
  return "done";
}

/** The rows that ask something of the user, for the Chats tab's dot. */
export function shelfNeedsUser(kind: ShelfKind): boolean {
  return kind === "needs-approval" || kind === "needs-input" || kind === "plan-ready";
}

function activityAt(thread: EnvironmentThreadShell): string {
  return thread.latestRun?.completedAt ?? thread.latestUserMessageAt ?? thread.updatedAt;
}

function isSnoozed(thread: EnvironmentThreadShell, now: number): boolean {
  return thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now;
}

function isSettled(thread: EnvironmentThreadShell): boolean {
  if (thread.settledOverride === "settled") return true;
  if (thread.settledOverride === "active") return false;
  return thread.settledAt !== null;
}

function byRecent(a: ShelfCard, b: ShelfCard): number {
  return b.activityAt.localeCompare(a.activityAt);
}

/**
 * `threads` is every thread shell (subagents included, so they can be
 * counted); archived, deleted and snoozed threads are left off.
 */
export function buildShelves(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: number = Date.now(),
): Shelves {
  // Subagents by the top-level thread they belong to.
  const byKey = new Map(threads.map((thread) => [threadKey(thread), thread] as const));
  const rootOf = (thread: EnvironmentThreadShell): EnvironmentThreadShell => {
    let current = thread;
    const seen = new Set<string>();
    while (isSubagent(current) && current.lineage.parentThreadId !== null) {
      const key = `${current.environmentId}:${current.lineage.parentThreadId}`;
      if (seen.has(key)) break;
      seen.add(key);
      const parent = byKey.get(key);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const agents = new Map<string, { count: number; working: number }>();
  for (const thread of threads) {
    if (!isSubagent(thread) || thread.deletedAt !== null) continue;
    const root = rootOf(thread);
    if (root === thread) continue;
    const entry = agents.get(threadKey(root)) ?? { count: 0, working: 0 };
    entry.count += 1;
    const childState = shelfCardState(thread);
    if (childState === "working" || childState === "connecting") entry.working += 1;
    agents.set(threadKey(root), entry);
  }

  const shelves = Object.fromEntries(
    SHELF_ORDER.map((kind) => [kind, [] as ShelfCard[]]),
  ) as Record<ShelfKind, ShelfCard[]>;
  for (const thread of threads) {
    if (isSubagent(thread) || thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (isSnoozed(thread, now)) continue;
    const state = shelfCardState(thread);
    const team = agents.get(threadKey(thread));
    const card: ShelfCard = {
      thread,
      state,
      agentCount: team?.count ?? 0,
      agentsWorking: team?.working ?? 0,
      activityAt: activityAt(thread),
    };
    if (state === "done") {
      // Finished and seen: the last three days stay on the home screen.
      if (now - Date.parse(card.activityAt) <= DONE_WINDOW_MS) shelves.done.push(card);
    } else if (
      (state === "error" || state === "limited" || state === "stopped" || state === "new") &&
      isSettled(thread)
    ) {
      // Settling a thread that went wrong or never ran puts it away.
      continue;
    } else {
      shelves[state].push(card);
    }
  }

  const result = {} as Record<ShelfKind, ReadonlyArray<ShelfCard>>;
  for (const kind of SHELF_ORDER) {
    result[kind] = shelves[kind].sort(byRecent).slice(0, SHELF_LIMIT);
  }
  return result;
}

/** The desktop's own words where it has a pill. */
export function shelfStateLabel(state: ShelfCardState): string {
  switch (state) {
    case "needs-approval":
      return "Pending approval";
    case "needs-input":
      return "Awaiting input";
    case "working":
      return "Working";
    case "connecting":
      return "Connecting";
    case "waiting":
      return "Waiting";
    case "plan-ready":
      return "Plan ready";
    case "completed":
      return "Completed";
    case "error":
      return "Failed";
    case "limited":
      return "Usage limit";
    case "stopped":
      return "Stopped";
    case "done":
      return "Done";
    case "new":
      return "Not started";
  }
}

/** "now", "4m", "2h", "3d" — short enough for a card corner. */
export function shortAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The latest visible message, flattened to a line or two of plain text. */
export function shelfPreview(thread: EnvironmentThreadShell): string | null {
  const text = thread.source.latestVisibleMessage?.text;
  if (!text) return null;
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  return plain.length > 180 ? `${plain.slice(0, 179)}…` : plain;
}
