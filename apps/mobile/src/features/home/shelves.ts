import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";

/**
 * The home screen's three shelves: what is working, what is done, and
 * everything else (what needs the user first, then what stopped). Each
 * thread lands on exactly one shelf; subagent threads never get a card of
 * their own and are counted on the thread that started them.
 */
export type ShelfKind = "working" | "done" | "other";

export type ShelfCardState =
  | "working"
  | "connecting"
  | "done"
  | "needs-approval"
  | "needs-input"
  | "plan-ready"
  | "error"
  | "stopped"
  | "new";

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

export interface Shelves {
  readonly working: ReadonlyArray<ShelfCard>;
  readonly done: ReadonlyArray<ShelfCard>;
  readonly other: ReadonlyArray<ShelfCard>;
}

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
  if (threadRuntimeIsActive(thread.runtime)) return "working";
  if (status === "failed" || thread.latestRun?.status === "failed") return "error";
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) return "plan-ready";
  const run = thread.latestRun?.status;
  if (run === "completed") return "done";
  if (run === "interrupted" || run === "cancelled" || run === "rolled_back") return "stopped";
  if (thread.latestRun === null) return "new";
  return "done";
}

export function shelfOf(state: ShelfCardState): ShelfKind {
  if (state === "working" || state === "connecting") return "working";
  if (state === "done") return "done";
  return "other";
}

/** Needs the user first, then what broke, then what simply stopped. */
const OTHER_RANK: Record<ShelfCardState, number> = {
  "needs-approval": 0,
  "needs-input": 0,
  "plan-ready": 1,
  error: 2,
  stopped: 3,
  new: 4,
  working: 5,
  connecting: 5,
  done: 5,
};

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
    if (shelfOf(shelfCardState(thread)) === "working") entry.working += 1;
    agents.set(threadKey(root), entry);
  }

  const working: ShelfCard[] = [];
  const done: ShelfCard[] = [];
  const other: ShelfCard[] = [];
  for (const thread of threads) {
    if (isSubagent(thread) || thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (isSnoozed(thread, now)) continue;
    const ownState = shelfCardState(thread);
    const team = agents.get(threadKey(thread));
    // A thread whose agents are still at work is working, whatever its own turn says.
    const state: ShelfCardState =
      shelfOf(ownState) !== "working" && ownState === "done" && (team?.working ?? 0) > 0
        ? "working"
        : ownState;
    const card: ShelfCard = {
      thread,
      state,
      agentCount: team?.count ?? 0,
      agentsWorking: team?.working ?? 0,
      activityAt: activityAt(thread),
    };
    const shelf = shelfOf(state);
    if (shelf === "working") working.push(card);
    else if (shelf === "done") {
      if (now - Date.parse(card.activityAt) <= DONE_WINDOW_MS) done.push(card);
    } else if (!isSettled(thread)) other.push(card);
  }

  working.sort(byRecent);
  done.sort(byRecent);
  other.sort((a, b) => OTHER_RANK[a.state] - OTHER_RANK[b.state] || byRecent(a, b));
  return {
    working: working.slice(0, SHELF_LIMIT),
    done: done.slice(0, SHELF_LIMIT),
    other: other.slice(0, SHELF_LIMIT),
  };
}

export function shelfStateLabel(state: ShelfCardState): string {
  switch (state) {
    case "working":
      return "Working";
    case "connecting":
      return "Starting";
    case "done":
      return "Done";
    case "needs-approval":
      return "Needs approval";
    case "needs-input":
      return "Needs you";
    case "plan-ready":
      return "Plan ready";
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
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
