import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";

const trimSlash = (path: string) => path.replace(/\/+$/, "");

/**
 * The projects and threads the sidebar lists: everything but each server's
 * Meetings project. Its chats live on the meetings they are about (and the
 * Meetings home), so in the sidebar they would be a second, stranger copy.
 */
export function useSidebarProjectsAndThreads(): {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
} {
  const allProjects = useProjects();
  const allThreads = useThreadShells();
  const serverConfigs = useServerConfigs();
  return useMemo(() => {
    const hidden = new Set(
      allProjects
        .filter((project) => {
          const root = serverConfigs.get(project.environmentId)?.meetingsWorkspaceRoot;
          return root !== undefined && trimSlash(project.workspaceRoot) === trimSlash(root);
        })
        .map((project) => `${project.environmentId}:${project.id}`),
    );
    if (hidden.size === 0) return { projects: allProjects, threads: allThreads };
    return {
      projects: allProjects.filter(
        (project) => !hidden.has(`${project.environmentId}:${project.id}`),
      ),
      threads: allThreads.filter(
        (thread) => !hidden.has(`${thread.environmentId}:${thread.projectId}`),
      ),
    };
  }, [allProjects, allThreads, serverConfigs]);
}
