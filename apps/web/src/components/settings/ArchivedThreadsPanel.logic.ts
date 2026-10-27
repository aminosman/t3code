import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { groupOwnedThreads } from "@t3tools/client-runtime/state/ownedThreads";

export function groupArchivedThreads(
  snapshots: ReadonlyArray<ArchivedSnapshotEntry>,
  selectedProjectKeys: ReadonlySet<string> | null,
) {
  return snapshots.flatMap(({ environmentId, snapshot }) =>
    snapshot.projects.flatMap((project) => {
      if (
        selectedProjectKeys !== null &&
        !selectedProjectKeys.has(`${environmentId}:${project.id}`)
      ) {
        return [];
      }
      const threads = snapshot.threads
        .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
        .map((thread) => presentThreadShell(environmentId, thread))
        .toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        });
      if (threads.length === 0) return [];
      // Group only this project's archived threads. Active or missing owners
      // leave their archived children at the top, as in the active sidebar.
      return [{ project: { ...project, environmentId }, ...groupOwnedThreads(threads) }];
    }),
  );
}
