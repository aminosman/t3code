// Roost's card wall, as data: which column each thread's card sits in, which
// cards a board shows, and in what order. No React here, so it is tested alone.
import {
  BOARD_STAGES,
  type BoardCard,
  type BoardStage,
  type BoardSubCards,
} from "@t3tools/contracts";
import { groupOwnedThreads, isLiveThread } from "@t3tools/client-runtime/state/ownedThreads";

export interface BoardColumnSpec {
  readonly stage: BoardStage;
  readonly title: string;
  readonly hint: string;
  /** Archived threads: Deployed holds the shipped ones, Archive the rest. */
  readonly archives: boolean;
}

export const BOARD_COLUMNS: ReadonlyArray<BoardColumnSpec> = BOARD_STAGES.map((stage) => {
  switch (stage) {
    case "research":
      return { stage, title: "Research", hint: "Finding out", archives: false };
    case "fix":
      return { stage, title: "Fix", hint: "Changing code", archives: false };
    case "review":
      return { stage, title: "Waiting · In review", hint: "On review or you", archives: false };
    case "pushed":
      return { stage, title: "Committed & pushed", hint: "In the repo", archives: false };
    case "deployed":
      return { stage, title: "Deployed", hint: "Complete; archived", archives: true };
    case "archived":
      return { stage, title: "Archive", hint: "Put away", archives: true };
  }
});

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
}

export type BoardScope =
  | { readonly kind: "all" }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "thread"; readonly threadId: string };

/**
 * The column a card sits in. Archiving is T3's, so an archived thread is in
 * Deployed when it shipped and in Archive otherwise, whatever it was before;
 * a thread never placed starts in Research.
 */
export function columnOf(stage: BoardStage | undefined, archived: boolean): BoardStage {
  if (archived) return stage === "deployed" ? "deployed" : "archived";
  return stage ?? "research";
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
  /** The server's counts, which see the idle sub-threads shells leave out. */
  subCounts: ReadonlyArray<BoardSubCards> = [],
): BoardView<T> {
  const countedById = new Map(subCounts.map((count) => [count.threadId as string, count] as const));
  const stageById = new Map(cards.map((card) => [card.threadId as string, card] as const));
  const { topLevel, childrenByOwner } = groupOwnedThreads(threads);
  const view = (thread: T): BoardCardView<T> => {
    const card = stageById.get(thread.id);
    const children = childrenByOwner.get(thread.id) ?? [];
    const counted = countedById.get(thread.id);
    const done = children.filter(
      (child) => child.archivedAt !== null || stageById.get(child.id)?.stage === "deployed",
    ).length;
    const useCounted = counted !== undefined && counted.total > children.length;
    return {
      thread,
      column: columnOf(card?.stage, thread.archivedAt !== null),
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
    BOARD_STAGES.map((stage) => [stage, []] as const),
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
