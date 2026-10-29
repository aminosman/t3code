import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";

/**
 * Removing a checkout force-deletes every thread it has on the server, including older settled
 * threads this client never loaded, so the count and the confirm name those too.
 */
export function planLegacyProjectRemoval<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
>(input: {
  readonly member: Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
    readonly environmentLabel?: string | null;
  };
  readonly groupMemberCount: number;
  readonly threads: ReadonlyArray<Thread>;
  readonly unloadedThreadCount: number;
  readonly archivedThreadCount?: number;
}) {
  const { projectThreads, confirmationMessage } = planProjectRemoval({
    members: [input.member],
    groupMemberCount: input.groupMemberCount,
    hasOtherMembers: false,
    displayName: input.member.title,
    threads: input.threads,
    unloadedThreadCount: input.unloadedThreadCount,
  });
  return {
    projectThreads,
    threadCount:
      projectThreads.length + input.unloadedThreadCount + (input.archivedThreadCount ?? 0),
    confirmationMessage,
  };
}

/** Older settled threads still on the server keep "Show more" up and the list from reading empty. */
export function legacyProjectThreadListTail(input: {
  readonly topLevelCount: number;
  readonly unloadedCount: number;
  readonly previewCount: number;
}) {
  return {
    hasOverflowingThreads: input.topLevelCount > input.previewCount || input.unloadedCount > 0,
    isEmpty: input.topLevelCount === 0 && input.unloadedCount === 0,
  };
}
