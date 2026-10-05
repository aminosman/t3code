import { describe, expect, it } from "vite-plus/test";

import { flattenOwnedThreads, groupOwnedThreads } from "./ownedThreads.ts";

const thread = (
  id: string,
  options: {
    owner?: string;
    fork?: string;
    status?: string;
    awaitingInput?: boolean;
  } = {},
) => ({
  id,
  lineage: {
    parentThreadId: options.owner ?? options.fork ?? null,
    relationshipToParent: options.owner
      ? ("subagent" as const)
      : options.fork
        ? ("fork" as const)
        : null,
  },
  hasPendingUserInput: options.awaitingInput ?? false,
  runtime: options.status ? { status: options.status } : null,
});

const rows = (
  threads: ReturnType<typeof thread>[],
  expandedByThreadId: Record<string, boolean> = {},
  activeThreadId: string | null = null,
) => {
  const { topLevel, childrenByOwner } = groupOwnedThreads(threads);
  return flattenOwnedThreads({
    roots: topLevel,
    childrenByOwner,
    expandedByThreadId,
    activeThreadId,
  }).map(
    (row) =>
      `${"  ".repeat(row.depth)}${row.thread.id}${row.childCount ? ` (${row.childCount}${row.expanded ? "" : ", closed"})` : ""}`,
  );
};

describe("owned threads in the legacy sidebar", () => {
  it("draws an owned thread under its owner, closed, and leaves the rest flat", () => {
    const threads = [
      thread("review", { owner: "plan" }),
      thread("plan"),
      thread("fork-of-plan", { fork: "plan" }),
      thread("support"),
    ];
    expect(rows(threads)).toEqual(["plan (1, closed)", "fork-of-plan", "support"]);
    expect(groupOwnedThreads(threads).topLevel.map((t) => t.id)).toEqual([
      "plan",
      "fork-of-plan",
      "support",
    ]);
  });

  it("opens an owner while a child works, waits on the user, or is on screen", () => {
    expect(rows([thread("plan"), thread("review", { owner: "plan", status: "running" })])).toEqual([
      "plan (1)",
      "  review",
    ]);
    expect(
      rows([thread("plan"), thread("review", { owner: "plan", awaitingInput: true })]),
    ).toEqual(["plan (1)", "  review"]);
    expect(rows([thread("plan"), thread("review", { owner: "plan" })], {}, "review")).toEqual([
      "plan (1)",
      "  review",
    ]);
  });

  it("follows the user's own open and close over the default", () => {
    const working = [thread("plan"), thread("review", { owner: "plan", status: "running" })];
    expect(rows(working, { plan: false })).toEqual(["plan (1, closed)"]);
    expect(rows([thread("plan"), thread("review", { owner: "plan" })], { plan: true })).toEqual([
      "plan (1)",
      "  review",
    ]);
  });

  it("nests a chain, and opens every owner above a working grandchild", () => {
    const threads = [
      thread("plan"),
      thread("review", { owner: "plan" }),
      thread("review-of-review", { owner: "review", status: "running" }),
    ];
    expect(rows(threads)).toEqual(["plan (1)", "  review (1)", "    review-of-review"]);
  });

  it("puts a child whose owner is not in the list at the top", () => {
    expect(rows([thread("review", { owner: "archived-plan" }), thread("other")])).toEqual([
      "review",
      "other",
    ]);
  });

  it("does not loop on a thread that names itself or a cycle", () => {
    expect(rows([thread("a", { owner: "a" })])).toEqual(["a"]);
    expect(rows([thread("a", { owner: "b" }), thread("b", { owner: "a" })])).toEqual(["a", "b"]);
  });
});
