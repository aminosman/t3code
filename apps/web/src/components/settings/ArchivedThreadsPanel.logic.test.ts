import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { flattenOwnedThreads } from "@t3tools/client-runtime/state/ownedThreads";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  archiveProjectFixture as v2Project,
  archivedThreadFixture as v2ThreadShell,
} from "./ArchivedThreadsPanel.testFixtures";
import { groupArchivedThreads } from "./ArchivedThreadsPanel.logic";

const environmentId = EnvironmentId.make("archive-environment");
const archivedAt = DateTime.makeUnsafe("2026-10-20T12:00:00.000Z");

function thread(
  id: string,
  options: {
    owner?: string;
    fork?: string;
    archived?: boolean;
    archivedAt?: DateTime.Utc;
    projectId?: ProjectId;
  } = {},
): OrchestrationV2ThreadShell {
  return {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    archivedAt: options.archived === false ? null : (options.archivedAt ?? archivedAt),
    projectId: options.projectId ?? v2Project.id,
    lineage: {
      rootThreadId: ThreadId.make(options.owner ?? options.fork ?? id),
      parentThreadId:
        options.owner || options.fork ? ThreadId.make((options.owner ?? options.fork)!) : null,
      relationshipToParent: options.owner ? "subagent" : options.fork ? "fork" : null,
    },
  };
}

function snapshot(threads: OrchestrationV2ThreadShell[], environment = environmentId) {
  return {
    environmentId: environment,
    snapshot: { schemaVersion: 1, snapshotSequence: 1, projects: [v2Project], threads },
  };
}

function rows(
  threads: OrchestrationV2ThreadShell[],
  expandedByThreadId: Record<string, boolean> = {},
) {
  return groupArchivedThreads([snapshot(threads)], null).flatMap((group) =>
    flattenOwnedThreads({
      roots: group.topLevel,
      childrenByOwner: group.childrenByOwner,
      expandedByThreadId,
      activeThreadId: null,
    }).map(({ thread, depth, childCount }) => [thread.id, depth, childCount]),
  );
}

describe("archive hierarchy", () => {
  it("keeps delegated children collapsed under their owner and forks at the top", () => {
    const threads = [
      thread("parent"),
      thread("child", { owner: "parent" }),
      thread("fork", { fork: "parent" }),
    ];
    expect(rows(threads)).toEqual([
      ["parent", 0, 1],
      ["fork", 0, 0],
    ]);
    expect(rows(threads, { parent: true })).toEqual([
      ["parent", 0, 1],
      ["child", 1, 0],
      ["fork", 0, 0],
    ]);
  });

  it("expands nested owners independently", () => {
    const threads = [
      thread("parent"),
      thread("child", { owner: "parent" }),
      thread("grandchild", { owner: "child" }),
    ];
    expect(rows(threads, { parent: true })).toEqual([
      ["parent", 0, 1],
      ["child", 1, 1],
    ]);
    expect(rows(threads, { parent: true, child: true })).toEqual([
      ["parent", 0, 1],
      ["child", 1, 1],
      ["grandchild", 2, 0],
    ]);
    expect(rows(threads, { parent: false, child: true })).toEqual([["parent", 0, 1]]);
  });

  it("preserves archive date ordering for roots and siblings", () => {
    const older = DateTime.makeUnsafe("2026-10-19T12:00:00.000Z");
    expect(
      rows(
        [
          thread("parent", { archivedAt: older }),
          thread("child-a", { owner: "parent", archivedAt: older }),
          thread("child-b", { owner: "parent" }),
          thread("other"),
        ],
        { parent: true },
      ),
    ).toEqual([
      ["other", 0, 0],
      ["parent", 0, 2],
      ["child-b", 1, 0],
      ["child-a", 1, 0],
    ]);
  });

  it("keeps archived children visible when their parent is active or absent", () => {
    expect(
      rows([
        thread("active-parent", { archived: false }),
        thread("child", { owner: "active-parent" }),
        thread("orphan", { owner: "missing-parent" }),
      ]),
    ).toEqual([
      ["orphan", 0, 0],
      ["child", 0, 0],
    ]);
  });

  it("excludes active descendants and preserves the remaining archived subtree", () => {
    expect(
      rows(
        [
          thread("parent"),
          thread("active-child", { owner: "parent", archived: false }),
          thread("grandchild", { owner: "active-child" }),
          thread("great-grandchild", { owner: "grandchild" }),
        ],
        { parent: true, grandchild: true },
      ),
    ).toEqual([
      ["parent", 0, 0],
      ["grandchild", 0, 1],
      ["great-grandchild", 1, 0],
    ]);
  });

  it("keeps malformed cycles and self-owned threads visible", () => {
    expect(
      rows([
        thread("a", { owner: "b" }),
        thread("b", { owner: "a" }),
        thread("self", { owner: "self" }),
      ]),
    ).toEqual([
      ["self", 0, 0],
      ["b", 0, 0],
      ["a", 0, 0],
    ]);
  });

  it("never groups a child under an owner in another project or environment", () => {
    const otherProject = { ...v2Project, id: ProjectId.make("other-project") };
    const first = snapshot([
      thread("parent"),
      thread("child", { owner: "parent", projectId: otherProject.id }),
    ]);
    const firstWithBothProjects = {
      ...first,
      snapshot: { ...first.snapshot, projects: [v2Project, otherProject] },
    };
    const groups = groupArchivedThreads(
      [
        firstWithBothProjects,
        snapshot([thread("child", { owner: "parent" })], EnvironmentId.make("other-environment")),
      ],
      null,
    );
    expect(groups.map((group) => group.topLevel.map((thread) => thread.id))).toEqual([
      ["parent"],
      ["child"],
      ["child"],
    ]);
    expect(
      groupArchivedThreads(
        [firstWithBothProjects],
        new Set([`${environmentId}:${otherProject.id}`]),
      ).map((group) => group.topLevel.map((thread) => thread.id)),
    ).toEqual([["child"]]);
  });
});
