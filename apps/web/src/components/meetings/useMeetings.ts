import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useActiveEnvironmentId, useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

const samePath = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * The environment whose server records meetings (it reports a meetings folder),
 * preferring the one in use; its Meetings project; the questions asked there;
 * and asking one. Every page of the Meetings section starts here.
 */
export function useMeetings() {
  const { environments } = useEnvironments();
  const activeEnvironmentId = useActiveEnvironmentId();
  const projects = useProjects();
  const threadShells = useThreadShells();
  const askCommand = useAtomCommand(serverEnvironment.askMeetings, { reportFailure: false });
  const [asking, setAsking] = useState(false);

  const offering = environments.filter(
    (entry) => entry.connection.phase === "connected" && entry.serverConfig?.meetingsWorkspaceRoot,
  );
  const environment =
    offering.find((entry) => entry.environmentId === activeEnvironmentId) ?? offering[0] ?? null;
  const environmentId: EnvironmentId | null = environment?.environmentId ?? null;
  const root = environment?.serverConfig?.meetingsWorkspaceRoot ?? null;

  const project = useMemo(
    () =>
      root === null
        ? null
        : (projects.find(
            (entry) => entry.environmentId === environmentId && samePath(entry.workspaceRoot, root),
          ) ?? null),
    [projects, environmentId, root],
  );

  /** Questions asked in the Meetings project, newest first. */
  const asks = useMemo(
    () =>
      project === null
        ? []
        : threadShells
            .filter(
              (thread) =>
                thread.environmentId === project.environmentId &&
                thread.projectId === project.id &&
                thread.archivedAt === null,
            )
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [project, threadShells],
  );

  /**
   * Ask; the answer is a thread in the Meetings project, shown in the chat
   * panel beside the page. Asked of a meeting, it continues that meeting's
   * chat (or starts it over, `fresh`); `threadId` follows up a chat across
   * all meetings. Resolves to the thread, null on failure.
   */
  const ask = useCallback(
    async (
      question: string,
      options?: {
        readonly meetingId?: string;
        readonly fresh?: boolean;
        /** Follow up this chat. */
        readonly threadId?: string | null;
      },
    ): Promise<string | null> => {
      const text = question.trim();
      if (text.length === 0 || environmentId === null || asking) return null;
      setAsking(true);
      const result = await askCommand({
        environmentId,
        input: {
          question: text,
          ...(options?.meetingId === undefined ? {} : { meetingId: options.meetingId }),
          ...(options?.fresh === true ? { fresh: true } : {}),
          ...(options?.threadId ? { threadId: options.threadId } : {}),
        },
      });
      setAsking(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not ask about your meetings",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return null;
      }
      return result.value.threadId;
    },
    [askCommand, asking, environmentId],
  );

  return { environmentId, root, project, asks, ask, asking };
}
