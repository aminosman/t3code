// Roost's card wall, as data: which column each thread's card sits in, which
// cards a board shows, and in what order. No React here, so it is tested alone.
import type { BoardCard, BoardColumn, BoardStage, BoardSubCards } from "@t3tools/contracts";
import { groupOwnedThreads, isLiveThread } from "@t3tools/client-runtime/state/ownedThreads";

/** What the board needs of a thread; EnvironmentThreadShell has all of it. */
export interface BoardThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  /** What the sidebar dates a thread by; updatedAt moves on bookkeeping too. */
  readonly latestUserMessageAt?: string | null | undefined;
  readonly archivedAt: string | null;
  readonly lineage: {
    readonly parentThreadId: string | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  };
  readonly delegatedFrom?:
    | { readonly environmentId: string; readonly threadId: string }
    | null
    | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly runtime?: { readonly status: string } | null | undefined;
  readonly latestRun?: { readonly status: string } | null | undefined;
}

export type BoardScope =
  | { readonly kind: "all" }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "thread"; readonly threadId: string };

/**
 * The column a card sits in. Archiving is T3's, so an archived thread sits in
 * the archiving column it was dropped on, else the last archiving column; an
 * open thread never placed, or placed in a column since removed, starts in
 * the first open column.
 */
export function columnOf(
  stage: BoardStage | undefined,
  archived: boolean,
  columns: ReadonlyArray<BoardColumn>,
): BoardStage {
  const placed = columns.find((column) => column.id === stage);
  if (archived) {
    if (placed?.archives) return placed.id;
    return columns.findLast((column) => column.archives)?.id ?? "";
  }
  return placed?.id ?? columns.find((column) => !column.archives)?.id ?? "";
}

export interface BoardCardView<T extends BoardThread> {
  readonly thread: T;
  readonly column: BoardStage;
  readonly card: BoardCard | undefined;
  /** Its own sub-threads, for the badge that opens its board. */
  readonly subCards: number;
  /** Of those, how many are Deployed or archived. */
  readonly subCardsDone: number;
}

export interface BoardView<T extends BoardThread> {
  readonly columns: ReadonlyMap<BoardStage, ReadonlyArray<BoardCardView<T>>>;
  /** The thread whose board this is, for a thread scope. */
  readonly owner: BoardCardView<T> | null;
}

const needsYou = (thread: BoardThread) =>
  thread.hasPendingApprovals === true || thread.hasPendingUserInput === true;

/** Stopped on you first, then working, then most recently touched. */
function byUrgency<T extends BoardThread>(a: BoardCardView<T>, b: BoardCardView<T>): number {
  const rank = (view: BoardCardView<T>) =>
    needsYou(view.thread) ? 0 : isLiveThread(view.thread) ? 1 : 2;
  return (
    rank(a) - rank(b) ||
    (b.thread.archivedAt ?? activityAt(b.thread)).localeCompare(
      a.thread.archivedAt ?? activityAt(a.thread),
    )
  );
}

/**
 * The cards a board shows: every project's top-level threads, one project's,
 * or one thread's own sub-threads. `threads` holds live and archived threads
 * together, so an archived owner still keeps its children under it.
 */
export function buildBoard<T extends BoardThread>(
  threads: ReadonlyArray<T>,
  cards: ReadonlyArray<BoardCard>,
  scope: BoardScope,
  boardColumns: ReadonlyArray<BoardColumn>,
  /** The server's counts, which see the idle sub-threads shells leave out. */
  subCounts: ReadonlyArray<BoardSubCards> = [],
): BoardView<T> {
  const archiving = new Set(
    boardColumns.filter((column) => column.archives).map((column) => column.id),
  );
  const countedById = new Map(subCounts.map((count) => [count.threadId as string, count] as const));
  const stageById = new Map(cards.map((card) => [card.threadId as string, card] as const));
  const { topLevel, childrenByOwner } = groupOwnedThreads(threads);
  const view = (thread: T): BoardCardView<T> => {
    const card = stageById.get(thread.id);
    const children = childrenByOwner.get(thread.id) ?? [];
    const counted = countedById.get(thread.id);
    const done = children.filter(
      (child) => child.archivedAt !== null || archiving.has(stageById.get(child.id)?.stage ?? ""),
    ).length;
    const useCounted = counted !== undefined && counted.total > children.length;
    return {
      thread,
      column: columnOf(card?.stage, thread.archivedAt !== null, boardColumns),
      card,
      subCards: useCounted ? counted.total : children.length,
      subCardsDone: useCounted ? counted.done : done,
    };
  };

  const shown =
    scope.kind === "thread"
      ? (childrenByOwner.get(scope.threadId) ?? [])
      : scope.kind === "project"
        ? topLevel.filter((thread) => thread.projectId === scope.projectId)
        : topLevel;

  const columns = new Map<BoardStage, BoardCardView<T>[]>(
    boardColumns.map((column) => [column.id, []] as const),
  );
  for (const thread of shown) {
    const card = view(thread);
    columns.get(card.column)?.push(card);
  }
  for (const list of columns.values()) list.sort(byUrgency);

  const ownerThread =
    scope.kind === "thread" ? threads.find((thread) => thread.id === scope.threadId) : undefined;
  return { columns, owner: ownerThread === undefined ? null : view(ownerThread) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the thread was last worked in, as the sidebar shows it. */
export function activityAt(thread: BoardThread): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}

/** Whole days since the thread was last touched. */
export function idleDays(thread: BoardThread, now: number): number {
  const at = Date.parse(activityAt(thread));
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / DAY_MS));
}

/** Cards a column's cleanup would archive: not live, untouched for `days` or more. */
export function idleCards<T extends BoardThread>(
  list: ReadonlyArray<BoardCardView<T>>,
  now: number,
  days: number,
): ReadonlyArray<BoardCardView<T>> {
  return list.filter(
    (view) =>
      view.thread.archivedAt === null &&
      !isLiveThread(view.thread) &&
      idleDays(view.thread, now) >= days,
  );
}

export type TurnStatus =
  | "needs-you"
  | "working"
  | "queued"
  | "done"
  | "failed"
  | "stopped"
  | "none";

const QUEUED = new Set(["preparing", "queued", "starting"]);
const WORKING = new Set(["running", "waiting"]);

/** How the thread's last turn stands, for the chip every card carries. */
export function turnStatus(thread: BoardThread): TurnStatus {
  if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true)
    return "needs-you";
  const live = thread.runtime?.status;
  if (live !== undefined && WORKING.has(live)) return "working";
  if (live !== undefined && QUEUED.has(live)) return "queued";
  switch (thread.latestRun?.status) {
    case undefined:
      return "none";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
    case "running":
    case "waiting":
      return "working";
    default:
      return "done";
  }
}

export type BoardFilter = "all" | "needs-you" | "working" | "stale" | "unsummarized";

/** Whether a card passes a quick filter; `summarized` says it has a summary. */
export function passesFilter(
  view: BoardCardView<BoardThread>,
  filter: BoardFilter,
  now: number,
  summarized: boolean,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs-you":
      return turnStatus(view.thread) === "needs-you";
    case "working": {
      const status = turnStatus(view.thread);
      return status === "working" || status === "queued";
    }
    case "stale":
      return (
        view.thread.archivedAt === null &&
        !isLiveThread(view.thread) &&
        idleDays(view.thread, now) >= STALE_DAYS
      );
    case "unsummarized":
      return !summarized && view.thread.archivedAt === null;
  }
}

/** A thread untouched this long is stale: red on its card, and the cleanup's target. */
export const STALE_DAYS = 14;

/** A summary older than the thread's last activity is out of date. */
export function summaryIsStale(thread: BoardThread, summarizedAt: string | undefined): boolean {
  return summarizedAt === undefined || summarizedAt < activityAt(thread);
}

/** The thread that owns this one (a subagent's parent, a delegated task's sender), if any. */
export function ownerOf(thread: BoardThread | undefined): string | null {
  if (thread === undefined) return null;
  if (thread.lineage.relationshipToParent === "subagent") return thread.lineage.parentThreadId;
  if (thread.lineage.relationshipToParent === null && thread.delegatedFrom != null) {
    return thread.delegatedFrom.threadId;
  }
  return null;
}

/** The card a board marks for a chat: its own, or its nearest owner's on this board. */
export function focusedCardId(
  threads: ReadonlyArray<BoardThread>,
  shownIds: ReadonlySet<string>,
  threadId: string | null,
): string | null {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  let id = threadId;
  for (let hops = 0; id !== null && hops < 8; hops += 1) {
    if (shownIds.has(id)) return id;
    id = ownerOf(byId.get(id));
  }
  return null;
}
