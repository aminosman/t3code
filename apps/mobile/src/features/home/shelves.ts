import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";

/**
 * The home screen's shelves, one per status: what needs the user, what is
 * working, what is done, what failed and what stopped. Each thread lands on
 * exactly one shelf; subagent threads never get a card of their own and are
 * counted on the thread that started them.
 */
export type ShelfKind = "needs" | "working" | "done" | "failed" | "stopped";

export const SHELF_ORDER: ReadonlyArray<ShelfKind> = [
  "needs",
  "working",
  "done",
  "failed",
  "stopped",
];

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
  switch (state) {
    case "needs-approval":
    case "needs-input":
    case "plan-ready":
      return "needs";
    case "working":
    case "connecting":
      return "working";
    case "done":
      return "done";
    case "error":
      return "failed";
    case "stopped":
    case "new":
      return "stopped";
  }
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
    if (shelfOf(shelfCardState(thread)) === "working") entry.working += 1;
    agents.set(threadKey(root), entry);
  }

  const shelves: Record<ShelfKind, ShelfCard[]> = {
    needs: [],
    working: [],
    done: [],
    failed: [],
    stopped: [],
  };
  for (const thread of threads) {
    if (isSubagent(thread) || thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (isSnoozed(thread, now)) continue;
    const ownState = shelfCardState(thread);
    const team = agents.get(threadKey(thread));
    // A thread whose agents are still at work is working, whatever its own turn says.
    const state: ShelfCardState =
      ownState === "done" && (team?.working ?? 0) > 0 ? "working" : ownState;
    const card: ShelfCard = {
      thread,
      state,
      agentCount: team?.count ?? 0,
      agentsWorking: team?.working ?? 0,
      activityAt: activityAt(thread),
    };
    const shelf = shelfOf(state);
    if (shelf === "done") {
      if (now - Date.parse(card.activityAt) <= DONE_WINDOW_MS) shelves.done.push(card);
    } else if (shelf === "working" || shelf === "needs" || !isSettled(thread)) {
      // Settling a failed or stopped thread puts it away.
      shelves[shelf].push(card);
    }
  }

  const result = {} as Record<ShelfKind, ReadonlyArray<ShelfCard>>;
  for (const kind of SHELF_ORDER) {
    result[kind] = shelves[kind].sort(byRecent).slice(0, SHELF_LIMIT);
  }
  return result;
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
