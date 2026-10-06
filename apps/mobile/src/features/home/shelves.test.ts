import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildShelves, shelfCardState, shortAgo } from "./shelves";

const environmentId = EnvironmentId.make("environment-1");
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    updatedAt: "2026-10-06T11:00:00.000Z",
    ...overrides,
  });
}

const run = (status: string, completedAt: string | null = "2026-10-06T11:30:00.000Z") =>
  ({
    runId: `run-${status}`,
    status,
    requestedAt: null,
    startedAt: null,
    completedAt,
  }) as unknown as EnvironmentThreadShell["latestRun"];

const runtime = (status: string) =>
  ({ status, activeRunId: "run-x" }) as unknown as EnvironmentThreadShell["runtime"];

function subagentOf(id: string, parent: string): Partial<EnvironmentThreadShell> {
  return {
    lineage: {
      rootThreadId: ThreadId.make(parent),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
    },
  };
}

describe("shelfCardState", () => {
  it("puts what needs the user ahead of a running turn", () => {
    expect(
      shelfCardState(thread("a", { runtime: runtime("running"), hasPendingApprovals: true })),
    ).toBe("needs-approval");
    expect(shelfCardState(thread("b", { hasPendingUserInput: true }))).toBe("needs-input");
  });

  it("reads running, finished, failed and stopped turns", () => {
    expect(shelfCardState(thread("a", { runtime: runtime("running") }))).toBe("working");
    expect(shelfCardState(thread("b", { runtime: runtime("queued") }))).toBe("connecting");
    expect(shelfCardState(thread("c", { latestRun: run("completed") }))).toBe("done");
    expect(shelfCardState(thread("d", { latestRun: run("failed") }))).toBe("error");
    expect(shelfCardState(thread("e", { latestRun: run("interrupted") }))).toBe("stopped");
    expect(shelfCardState(thread("f"))).toBe("new");
  });
});

describe("buildShelves", () => {
  it("sorts every top-level thread onto one shelf", () => {
    const shelves = buildShelves(
      [
        thread("working", { runtime: runtime("running") }),
        thread("done", { latestRun: run("completed") }),
        thread("asks", { hasPendingUserInput: true }),
        thread("failed", { latestRun: run("failed") }),
      ],
      NOW,
    );
    expect(shelves.working.map((card) => card.thread.title)).toEqual(["working"]);
    expect(shelves.done.map((card) => card.thread.title)).toEqual(["done"]);
    expect(shelves.needs.map((card) => card.thread.title)).toEqual(["asks"]);
    expect(shelves.failed.map((card) => card.thread.title)).toEqual(["failed"]);
    expect(shelves.stopped).toEqual([]);
  });

  it("counts subagents on the thread that started them, at any depth, and gives them no card", () => {
    const shelves = buildShelves(
      [
        thread("parent", { latestRun: run("completed") }),
        thread("child", { ...subagentOf("child", "parent"), latestRun: run("completed") }),
        thread("grandchild", { ...subagentOf("grandchild", "child"), runtime: runtime("running") }),
      ],
      NOW,
    );
    const all = Object.values(shelves).flat();
    expect(all.map((card) => card.thread.title)).toEqual(["parent"]);
    // Its own turn finished, but an agent under it is still at work.
    expect(shelves.working[0]?.agentCount).toBe(2);
    expect(shelves.working[0]?.agentsWorking).toBe(1);
  });

  it("leaves archived, snoozed, settled and old finished work off the home screen", () => {
    const shelves = buildShelves(
      [
        thread("archived", { archivedAt: "2026-10-06T10:00:00.000Z", runtime: runtime("running") }),
        thread("snoozed", { snoozedUntil: "2026-10-07T10:00:00.000Z", hasPendingUserInput: true }),
        thread("settled", { settledOverride: "settled", latestRun: run("failed") }),
        thread("old", { latestRun: run("completed", "2026-09-20T10:00:00.000Z") }),
      ],
      NOW,
    );
    expect(Object.values(shelves).flat()).toEqual([]);
  });

  it("orders each shelf newest first", () => {
    const shelves = buildShelves(
      [
        thread("older", { latestRun: run("completed", "2026-10-06T09:00:00.000Z") }),
        thread("newer", { latestRun: run("completed", "2026-10-06T11:00:00.000Z") }),
      ],
      NOW,
    );
    expect(shelves.done.map((card) => card.thread.title)).toEqual(["newer", "older"]);
  });
});

describe("shortAgo", () => {
  it("fits a card corner", () => {
    expect(shortAgo("2026-10-06T11:59:30.000Z", NOW)).toBe("now");
    expect(shortAgo("2026-10-06T11:56:00.000Z", NOW)).toBe("4m");
    expect(shortAgo("2026-10-06T10:00:00.000Z", NOW)).toBe("2h");
    expect(shortAgo("2026-10-03T12:00:00.000Z", NOW)).toBe("3d");
  });
});
