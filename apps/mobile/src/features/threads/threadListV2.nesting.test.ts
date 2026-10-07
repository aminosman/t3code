import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items } from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-10-07T12:00:00.000Z";

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadShellFixture({ environmentId, id: ThreadId.make(id), title: id, ...overrides });
}

function ownedBy(parent: string): Partial<EnvironmentThreadShell> {
  return {
    lineage: {
      rootThreadId: ThreadId.make(parent),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
    },
  };
}

const running = {
  status: "running",
  activeRunId: "r",
} as unknown as EnvironmentThreadShell["runtime"];

describe("buildThreadListV2Items — Roost sorting and nesting", () => {
  it("orders the active block by the latest user message when asked, like a messages app", () => {
    const layout = buildThreadListV2Items({
      threads: [
        thread("old-but-busy", {
          createdAt: "2026-10-01T00:00:00.000Z",
          latestUserMessageAt: "2026-10-07T11:00:00.000Z",
        }),
        thread("new-and-quiet", {
          createdAt: "2026-10-06T00:00:00.000Z",
          latestUserMessageAt: "2026-10-06T00:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      sortOrder: "updated_at",
    });
    expect(layout.items.map((item) => item.thread.id)).toEqual(["old-but-busy", "new-and-quiet"]);
  });

  it("draws owned threads under their owner instead of hiding them, opened while one is working", () => {
    const layout = buildThreadListV2Items({
      threads: [
        thread("owner"),
        thread("idle-child", ownedBy("owner")),
        thread("busy-child", { ...ownedBy("owner"), runtime: running }),
        thread("grandchild", ownedBy("busy-child")),
        thread("other"),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      sortOrder: "created_at",
      nestOwnedThreads: true,
    });
    const rows = layout.items.map((item) => [item.thread.id, item.ownedDepth ?? 0] as const);
    expect(rows).toContainEqual(["owner", 0]);
    expect(rows).toContainEqual(["idle-child", 1]);
    expect(rows).toContainEqual(["busy-child", 1]);
    const owner = layout.items.find((item) => item.thread.id === "owner");
    expect(owner?.ownedChildCount).toBe(2);
    expect(owner?.ownedExpanded).toBe(true);
    // The owner comes before its children, and nothing owned stands at the top level.
    const ownerIndex = rows.findIndex(([id]) => id === "owner");
    expect(rows.findIndex(([id]) => id === "idle-child")).toBeGreaterThan(ownerIndex);
  });

  it("keeps owned threads folded when nothing under the owner is live, until opened", () => {
    const base = {
      threads: [thread("owner"), thread("child", ownedBy("owner"))],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      nestOwnedThreads: true,
    } as const;
    const folded = buildThreadListV2Items(base);
    expect(folded.items.map((item) => item.thread.id)).toEqual(["owner"]);
    expect(folded.items[0]?.ownedChildCount).toBe(1);
    const opened = buildThreadListV2Items({ ...base, ownedExpandedByThreadId: { owner: true } });
    expect(opened.items.map((item) => item.thread.id)).toEqual(["owner", "child"]);
  });
});
