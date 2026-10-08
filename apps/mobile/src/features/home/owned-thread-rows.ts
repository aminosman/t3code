import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export interface AgentRow {
  readonly thread: EnvironmentThreadShell;
  readonly depth: number;
}

/** Every thread an owner started, at any depth, in the order they were made. */
export function ownedThreadRows(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: string,
  threadId: string,
): ReadonlyArray<AgentRow> {
  const children = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    if (thread.lineage.relationshipToParent !== "subagent") continue;
    const parent = thread.lineage.parentThreadId;
    if (parent === null || thread.archivedAt !== null || thread.deletedAt !== null) continue;
    const list = children.get(parent) ?? [];
    list.push(thread);
    children.set(parent, list);
  }
  const rows: AgentRow[] = [];
  const seen = new Set<string>([threadId]);
  const visit = (id: string, depth: number) => {
    const list = [...(children.get(id) ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const child of list) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      rows.push({ thread: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(threadId, 0);
  return rows;
}
