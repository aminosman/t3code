/**
 * Roost: a thread that another thread owns — a delegate_task child, or a
 * subagent the provider spawned itself — is drawn under its owner, and a
 * thread nobody owns stays at the top of the project's list (Amin, Oct 5
 * 2026: "nest owned and unnest non owned"). Ownership is the server's
 * `lineage.relationshipToParent === "subagent"`; a fork is not owned and stays
 * flat. Shared by the desktop's legacy sidebar and the phone's grouped list.
 */
interface OwnableThread {
  readonly id: string;
  readonly lineage: {
    readonly parentThreadId: string | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  };
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly runtime?: { readonly status: string } | null | undefined;
}

export interface OwnedThreadRow<T> {
  readonly thread: T;
  readonly depth: number;
  /** Owned children of this thread in the list, whether shown or not. */
  readonly childCount: number;
  readonly expanded: boolean;
}

export function ownerThreadId(thread: OwnableThread): string | null {
  return thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
}

const LIVE_RUNTIME = new Set(["running", "waiting", "preparing", "starting", "queued"]);

/** Working, or stopped on the user: worth seeing without a click. */
export function isLiveThread(thread: OwnableThread): boolean {
  return (
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true ||
    (thread.runtime != null && LIVE_RUNTIME.has(thread.runtime.status))
  );
}

/**
 * Splits a project's sorted threads into the ones at the top of the list and
 * each owner's children, in the same order. A child whose owner is not in the
 * list (archived, or in another project) is shown at the top.
 */
export function groupOwnedThreads<T extends OwnableThread>(
  threads: readonly T[],
): { topLevel: T[]; childrenByOwner: ReadonlyMap<string, T[]> } {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  // An owner chain that never reaches the top would hide every thread on it.
  const reachesTop = (thread: T): boolean => {
    const seen = new Set([thread.id]);
    for (let owner = ownerThreadId(thread); owner !== null;) {
      const next = byId.get(owner);
      if (next === undefined) return true;
      if (seen.has(owner)) return false;
      seen.add(owner);
      owner = ownerThreadId(next);
    }
    return true;
  };
  const topLevel: T[] = [];
  const childrenByOwner = new Map<string, T[]>();
  for (const thread of threads) {
    const owner = ownerThreadId(thread);
    if (owner === null || !byId.has(owner) || !reachesTop(thread)) {
      topLevel.push(thread);
      continue;
    }
    const siblings = childrenByOwner.get(owner);
    if (siblings) siblings.push(thread);
    else childrenByOwner.set(owner, [thread]);
  }
  return { topLevel, childrenByOwner };
}

/**
 * The rows to draw under the given top-level threads. An owner's children are
 * shown when the user opened them, or — until the user says otherwise — when
 * one of them is live or is the thread on screen.
 */
export function flattenOwnedThreads<T extends OwnableThread>(input: {
  readonly roots: readonly T[];
  readonly childrenByOwner: ReadonlyMap<string, T[]>;
  readonly expandedByThreadId: Readonly<Record<string, boolean>>;
  readonly activeThreadId: string | null;
}): OwnedThreadRow<T>[] {
  const { childrenByOwner, expandedByThreadId, activeThreadId } = input;
  const holdsAttention = new Map<string, boolean>();
  const descendantHoldsAttention = (threadId: string, seen: Set<string>): boolean => {
    const known = holdsAttention.get(threadId);
    if (known !== undefined) return known;
    let result = false;
    for (const child of childrenByOwner.get(threadId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (
        child.id === activeThreadId ||
        isLiveThread(child) ||
        descendantHoldsAttention(child.id, seen)
      ) {
        result = true;
        break;
      }
    }
    holdsAttention.set(threadId, result);
    return result;
  };

  const rows: OwnedThreadRow<T>[] = [];
  const visit = (thread: T, depth: number, seen: Set<string>) => {
    const children = childrenByOwner.get(thread.id) ?? [];
    const expanded =
      children.length > 0 &&
      (expandedByThreadId[thread.id] ?? descendantHoldsAttention(thread.id, new Set([thread.id])));
    rows.push({ thread, depth, childCount: children.length, expanded });
    if (!expanded) return;
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      visit(child, depth + 1, seen);
    }
  };
  for (const root of input.roots) visit(root, 0, new Set([root.id]));
  return rows;
}
