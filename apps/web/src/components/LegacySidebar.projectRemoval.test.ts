import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  legacyProjectThreadListTail,
  planLegacyProjectRemoval,
} from "./LegacySidebar.projectRemoval";

const environmentId = EnvironmentId.make("env-1");
const member = {
  id: ProjectId.make("project-1"),
  environmentId,
  title: "Old project",
  workspaceRoot: "/repo/old",
};
const thread = (projectId: string) => ({ environmentId, projectId: ProjectId.make(projectId) });

describe("planLegacyProjectRemoval", () => {
  it("counts older settled threads the client has not loaded", () => {
    const plan = planLegacyProjectRemoval({
      member,
      groupMemberCount: 1,
      threads: [thread("project-1"), thread("project-2")],
      unloadedThreadCount: 40,
    });
    expect(plan.projectThreads).toHaveLength(1);
    expect(plan.threadCount).toBe(41);
    expect(plan.confirmationMessage).toContain("and delete its 41 threads?");
  });

  it("names the unloaded threads when none are loaded", () => {
    const plan = planLegacyProjectRemoval({
      member,
      groupMemberCount: 1,
      threads: [],
      unloadedThreadCount: 3,
    });
    expect(plan.threadCount).toBe(3);
    expect(plan.confirmationMessage).toContain(
      'Remove project "Old project" and delete its 3 threads?',
    );
  });

  it("warns about archived history even when no thread is counted", () => {
    const plan = planLegacyProjectRemoval({
      member,
      groupMemberCount: 1,
      threads: [],
      unloadedThreadCount: 0,
    });
    expect(plan.threadCount).toBe(0);
    expect(plan.confirmationMessage).toContain("archived conversation history");
  });
});

describe("legacyProjectThreadListTail", () => {
  it("is not empty while older settled threads remain on the server", () => {
    expect(
      legacyProjectThreadListTail({ topLevelCount: 0, unloadedCount: 12, previewCount: 6 }),
    ).toEqual({ hasOverflowingThreads: true, isEmpty: false });
    expect(
      legacyProjectThreadListTail({ topLevelCount: 0, unloadedCount: 0, previewCount: 6 }),
    ).toEqual({ hasOverflowingThreads: false, isEmpty: true });
  });

  it("offers more when the loaded threads fit the preview but older ones remain", () => {
    expect(
      legacyProjectThreadListTail({ topLevelCount: 4, unloadedCount: 2, previewCount: 6 }),
    ).toEqual({ hasOverflowingThreads: true, isEmpty: false });
    expect(
      legacyProjectThreadListTail({ topLevelCount: 7, unloadedCount: 0, previewCount: 6 }),
    ).toEqual({ hasOverflowingThreads: true, isEmpty: false });
  });
});
