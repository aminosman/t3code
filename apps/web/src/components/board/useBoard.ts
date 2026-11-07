// The card wall's data and its one action, moving a card. Stages come from
// the server's board store; whether a thread is archived stays T3's, so a
// move into Deployed or Archive archives the thread and a move out of them
// brings it back.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type BoardCard,
  type BoardColumn,
  type BoardStage,
  DEFAULT_BOARD_COLUMNS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useThreadActions } from "~/hooks/useThreadActions";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "~/lib/archivedThreadsState";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { olderSettledThreads, threadEnvironment, threadFamilies } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

const NO_ENVIRONMENTS: ReadonlyArray<EnvironmentId> = [];
const NO_OLDER_SETTLED = Atom.make(null);

const failureMessage = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : "An error occurred.";

export function useBoard(scopeThreadId: string | null) {
  const environmentId = usePrimaryEnvironmentId();
  const environmentIds = environmentId === null ? NO_ENVIRONMENTS : [environmentId];
  const liveShells = useQuietThreadShells();
  const archived = useArchivedThreadSnapshots(environmentIds);
  // Shells leave settled threads older than their cut out; the board wants all of them.
  const olderCut = useAtomValue(
    environmentId === null ? NO_OLDER_SETTLED : olderSettledThreads.olderSettledAtom(environmentId),
  );
  const older = useEnvironmentQuery(
    environmentId === null || olderCut == null
      ? null
      : serverEnvironment.boardOlderSettled({ environmentId, input: { before: olderCut.before } }),
  );
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const listing = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.boardList({ environmentId, input: {} }),
  );
  const moveCommand = useAtomCommand(serverEnvironment.boardMove, { reportFailure: false });
  const setColumnsCommand = useAtomCommand(serverEnvironment.boardSetColumns, {
    reportFailure: false,
  });
  const summarizeCommand = useAtomCommand(serverEnvironment.boardSummarize, {
    reportFailure: false,
  });
  const archiveCommand = useOrchestrationCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const { archiveThread, unarchiveThread } = useThreadActions();
  // Moves made here, shown before the store's next listing confirms them.
  const [moved, setMoved] = useState<ReadonlyMap<string, BoardCard>>(new Map());

  const live = liveShells.filter(
    (thread) => thread.environmentId === environmentId && thread.archivedAt === null,
  );
  // A thread's own board reads its whole family: shells leave idle sub-threads out.
  const family = useEnvironmentQuery(
    environmentId === null || scopeThreadId === null
      ? null
      : threadFamilies.familyAtom(environmentId, scopeThreadId as ThreadId),
  );
  const olderLive = [...(older.data ?? []), ...(family.data?.threads ?? [])]
    .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
    .map((thread) => presentThreadShell(environmentId!, thread));
  const liveIds = new Set<string>(live.map((thread) => thread.id));
  const shownLive = [...live];
  for (const thread of olderLive) {
    if (liveIds.has(thread.id)) continue;
    liveIds.add(thread.id);
    shownLive.push(thread);
  }
  const threads = [
    ...shownLive,
    ...archived.snapshots.flatMap((entry) =>
      entry.snapshot.threads
        .map((thread) => presentThreadShell(entry.environmentId, thread))
        .filter((thread) => !liveIds.has(thread.id)),
    ),
  ];
  // The newer of the store's card and one moved here wins, so an agent's later
  // move still shows after the user moved the same card.
  const latest = new Map<string, BoardCard>(moved);
  for (const card of listing.data?.cards ?? []) {
    const mine = latest.get(card.threadId);
    if (mine === undefined || card.movedAt >= mine.movedAt) latest.set(card.threadId, card);
  }
  const cards = [...latest.values()];

  const columns: ReadonlyArray<BoardColumn> = listing.data?.columns ?? DEFAULT_BOARD_COLUMNS;
  const isArchiving = (stage: BoardStage) =>
    columns.find((column) => column.id === stage)?.archives === true;
  const summaries = new Map(
    (listing.data?.summaries ?? []).map((summary) => [summary.threadId as string, summary]),
  );
  const summarizing = new Set<string>(listing.data?.summarizing ?? []);

  // Agents and the summarizer move cards; look again while the board is open,
  // sooner while summaries are being written.
  const refreshListing = listing.refresh;
  const busy = summarizing.size > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer keeping the listing in step with moves and summaries made on the server
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") refreshListing();
      },
      busy ? 4_000 : 15_000,
    );
    return () => window.clearInterval(timer);
  }, [refreshListing, busy]);

  const record = async (threadIds: ReadonlyArray<ThreadId>, stage: BoardStage) => {
    if (environmentId === null || threadIds.length === 0) return false;
    const [first, ...rest] = threadIds;
    const result = await moveCommand({
      environmentId,
      input: { threadIds: [first!, ...rest], stage },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not move the card",
          description: failureMessage(squashAtomCommandFailure(result)),
        });
      }
      return false;
    }
    setMoved((current) => {
      const next = new Map(current);
      for (const card of result.value.cards) next.set(card.threadId, card);
      return next;
    });
    // Sub-card counts are the server's; read them again.
    listing.refresh();
    return true;
  };

  /** Moves one card, archiving or unarchiving its thread on the way. */
  const move = async (threadId: ThreadId, stage: BoardStage) => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (environmentId === null || thread === undefined) return;
    const ref = scopeThreadRef(environmentId, threadId);
    const wasArchived = thread.archivedAt !== null;
    if (isArchiving(stage) && !wasArchived) {
      const result = await archiveThread(ref);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Could not archive the thread",
            description:
              thread.runtime?.status === "running"
                ? "It is still working. Stop it first, or wait for it to finish."
                : failureMessage(squashAtomCommandFailure(result)),
          });
        }
        return;
      }
    } else if (!isArchiving(stage) && wasArchived) {
      const result = await unarchiveThread(ref);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Could not bring the thread back",
            description: failureMessage(squashAtomCommandFailure(result)),
          });
        }
        return;
      }
    }
    await record([threadId], stage);
    if (isArchiving(stage) !== wasArchived) older.refresh();
  };

  /** Archives a batch at once, with one notice rather than one per thread. */
  /** `into` is the archiving column they land in; the last one by default. */
  const archiveMany = async (threadIds: ReadonlyArray<ThreadId>, into?: BoardStage) => {
    if (environmentId === null) return;
    const landing =
      columns.find((column) => column.id === into && column.archives) ??
      columns.findLast((column) => column.archives);
    const done: ThreadId[] = [];
    for (const threadId of threadIds) {
      const result = await archiveCommand({ environmentId, input: { threadId } });
      if (result._tag === "Success") done.push(threadId);
    }
    refreshArchivedThreadsForEnvironment(environmentId);
    if (landing !== undefined) await record(done, landing.id);
    older.refresh();
    toastManager.add({
      type: done.length === threadIds.length ? "success" : "warning",
      title: `Archived ${done.length} thread${done.length === 1 ? "" : "s"}`,
      description:
        done.length === threadIds.length
          ? `They are in ${landing?.title ?? "an archiving column"}; drag one out to bring it back.`
          : `${threadIds.length - done.length} could not be archived.`,
    });
  };

  /** Replaces the board's columns; true when the server took them. */
  const saveColumns = async (next: ReadonlyArray<BoardColumn>) => {
    if (environmentId === null) return false;
    const result = await setColumnsCommand({ environmentId, input: { columns: [...next] } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not save the columns",
          description: failureMessage(squashAtomCommandFailure(result)),
        });
      }
      return false;
    }
    listing.refresh();
    return true;
  };

  /** Asks the server for fresh summaries of these threads. */
  const summarize = async (threadIds: ReadonlyArray<ThreadId>) => {
    if (environmentId === null || threadIds.length === 0) return;
    const [first, ...rest] = threadIds.slice(0, 500);
    const result = await summarizeCommand({
      environmentId,
      input: { threadIds: [first!, ...rest] },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not summarize",
          description: failureMessage(squashAtomCommandFailure(result)),
        });
      }
      return;
    }
    listing.refresh();
  };

  return {
    environmentId,
    columns,
    saveColumns,
    summaries,
    summarizing,
    summarize,
    threads,
    cards,
    subCounts: listing.data?.subCards ?? [],
    projects,
    loading: listing.isPending && listing.data === null,
    error: listing.error ?? archived.error,
    move,
    archiveMany,
  };
}
