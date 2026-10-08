import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { ownedThreadRows } from "./owned-thread-rows";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, parent: string | null, createdAt: string): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    createdAt,
    lineage: {
      rootThreadId: ThreadId.make(parent ?? id),
      parentThreadId: parent === null ? null : ThreadId.make(parent),
      relationshipToParent: parent === null ? null : "subagent",
    },
  });
}

describe("ownedThreadRows", () => {
  it("lists every agent under a thread, nested, in the order they were started", () => {
    const rows = ownedThreadRows(
      [
        thread("owner", null, "2026-10-07T10:00:00.000Z"),
        thread("second", "owner", "2026-10-07T10:05:00.000Z"),
        thread("first", "owner", "2026-10-07T10:01:00.000Z"),
        thread("grandchild", "first", "2026-10-07T10:02:00.000Z"),
        thread("elsewhere", null, "2026-10-07T10:03:00.000Z"),
      ],
      environmentId,
      "owner",
    );
    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["first", 0],
      ["grandchild", 1],
      ["second", 0],
    ]);
  });
});
