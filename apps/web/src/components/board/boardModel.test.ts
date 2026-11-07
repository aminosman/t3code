import type { BoardCard, BoardStage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type BoardThread,
  buildBoard,
  columnOf,
  idleCards,
  passesFilter,
  summaryIsStale,
  turnStatus,
} from "./boardModel";

const thread = (id: string, overrides: Partial<BoardThread> = {}): BoardThread => ({
  id,
  environmentId: "env",
  projectId: "p1",
  title: id,
  updatedAt: "2026-11-01T00:00:00.000Z",
  archivedAt: null,
  lineage: { parentThreadId: null, relationshipToParent: null },
  delegatedFrom: null,
  runtime: null,
  ...overrides,
});

const card = (threadId: string, stage: BoardStage): BoardCard =>
  ({ threadId, stage, movedAt: "2026-11-01T00:00:00.000Z", movedBy: "user" }) as BoardCard;

const ids = (board: ReturnType<typeof buildBoard>, stage: BoardStage) =>
  board.columns.get(stage)?.map((view) => view.thread.id);

describe("columnOf", () => {
  it("starts unplaced threads in Research and sorts archived ones by whether they shipped", () => {
    expect(columnOf(undefined, false)).toBe("research");
    expect(columnOf("review", false)).toBe("review");
    expect(columnOf(undefined, true)).toBe("archived");
    expect(columnOf("fix", true)).toBe("archived");
    expect(columnOf("deployed", true)).toBe("deployed");
  });
});

describe("buildBoard", () => {
  const sub = (id: string, parent: string, overrides: Partial<BoardThread> = {}) =>
    thread(id, {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
      ...overrides,
    });
  const threads = [
    thread("a"),
    thread("b", { projectId: "p2" }),
    thread("old", { archivedAt: "2026-10-01T00:00:00.000Z" }),
    sub("a1", "a"),
    sub("a2", "a", { archivedAt: "2026-10-02T00:00:00.000Z" }),
    sub("old1", "old"),
  ];
  const cards = [card("a", "fix"), card("a1", "deployed"), card("old", "deployed")];

  it("shows top-level threads on the whole board, with their sub-card progress", () => {
    const board = buildBoard(threads, cards, { kind: "all" });
    expect(ids(board, "research")).toEqual(["b"]);
    expect(ids(board, "fix")).toEqual(["a"]);
    expect(ids(board, "deployed")).toEqual(["old"]);
    const a = board.columns.get("fix")?.[0];
    expect([a?.subCards, a?.subCardsDone]).toEqual([2, 2]);
    // The server also counts the idle sub-threads the shell left out.
    const counted = buildBoard(threads, cards, { kind: "all" }, [
      { threadId: "a", total: 5, done: 3 },
    ] as never);
    const b = counted.columns.get("fix")?.[0];
    expect([b?.subCards, b?.subCardsDone]).toEqual([5, 3]);
  });

  it("narrows to one project, and to one thread's own sub-threads", () => {
    expect(
      ids(buildBoard(threads, cards, { kind: "project", projectId: "p2" }), "research"),
    ).toEqual(["b"]);
    const own = buildBoard(threads, cards, { kind: "thread", threadId: "a" });
    expect(own.owner?.thread.id).toBe("a");
    // a1 was marked deployed but is still open; a2 was archived without a stage.
    expect(ids(own, "deployed")).toEqual(["a1"]);
    expect(ids(own, "archived")).toEqual(["a2"]);
    // An archived owner keeps its children under it.
    expect(
      ids(buildBoard(threads, cards, { kind: "thread", threadId: "old" }), "research"),
    ).toEqual(["old1"]);
  });

  it("puts a thread waiting on you above a working one, above the rest", () => {
    const board = buildBoard(
      [
        thread("quiet", { updatedAt: "2026-11-05T00:00:00.000Z" }),
        thread("working", { runtime: { status: "running" } }),
        thread("asks", { hasPendingUserInput: true }),
      ],
      [],
      { kind: "all" },
    );
    expect(ids(board, "research")).toEqual(["asks", "working", "quiet"]);
  });
});

describe("idleCards", () => {
  it("offers only open, stopped threads untouched for long enough", () => {
    const now = Date.parse("2026-11-20T00:00:00.000Z");
    const board = buildBoard(
      [
        thread("stale"),
        thread("fresh", { updatedAt: "2026-11-19T00:00:00.000Z" }),
        thread("running", { runtime: { status: "running" } }),
      ],
      [],
      { kind: "all" },
    );
    expect(idleCards(board.columns.get("research") ?? [], now, 14).map((v) => v.thread.id)).toEqual(
      ["stale"],
    );
  });
});

describe("turnStatus", () => {
  it("reads waiting on you first, then live work, then how the last turn ended", () => {
    expect(
      turnStatus(thread("a", { hasPendingApprovals: true, runtime: { status: "running" } })),
    ).toBe("needs-you");
    expect(turnStatus(thread("a", { runtime: { status: "running" } }))).toBe("working");
    expect(turnStatus(thread("a", { runtime: { status: "queued" } }))).toBe("queued");
    expect(turnStatus(thread("a", { latestRun: { status: "completed" } }))).toBe("done");
    expect(turnStatus(thread("a", { latestRun: { status: "failed" } }))).toBe("failed");
    expect(turnStatus(thread("a", { latestRun: { status: "interrupted" } }))).toBe("stopped");
    expect(turnStatus(thread("a"))).toBe("none");
  });
});

describe("passesFilter and summaryIsStale", () => {
  const now = Date.parse("2026-11-20T00:00:00.000Z");
  const view = (t: BoardThread) =>
    buildBoard([t], [], { kind: "all" }).columns.get("research")![0]!;

  it("filters by who acts and by staleness", () => {
    const asks = view(thread("asks", { hasPendingUserInput: true }));
    expect(passesFilter(asks, "needs-you", now, true)).toBe(true);
    expect(passesFilter(asks, "working", now, true)).toBe(false);
    expect(passesFilter(view(thread("old")), "stale", now, true)).toBe(true);
    expect(passesFilter(view(thread("old")), "unsummarized", now, false)).toBe(true);
  });

  it("calls a summary stale once the thread moved on after it", () => {
    const t = thread("a", { latestUserMessageAt: "2026-11-02T00:00:00.000Z" });
    expect(summaryIsStale(t, undefined)).toBe(true);
    expect(summaryIsStale(t, "2026-11-01T00:00:00.000Z")).toBe(true);
    expect(summaryIsStale(t, "2026-11-03T00:00:00.000Z")).toBe(false);
  });
});
