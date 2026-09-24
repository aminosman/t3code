import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { describeUpdateThreadModelResult, planUpdateThreadModel } from "./UpdateThreadModel.logic";

const NOW = Date.parse("2026-09-24T20:00:00.000Z");
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const providers = [
  {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: claude,
    continuation: { groupKey: "claude:home" },
  },
  {
    instanceId: ProviderInstanceId.make("claudeAgent_claude_2"),
    driver: claude,
    continuation: { groupKey: "claude:home" },
  },
  {
    instanceId: ProviderInstanceId.make("claudeAgent_work"),
    driver: claude,
    continuation: { groupKey: "claude:work" },
  },
  { instanceId: ProviderInstanceId.make("codex"), driver: codex },
];
const target = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

function thread(input: {
  id: string;
  instanceId?: string;
  model?: string;
  lastMessage?: string | null;
  archived?: boolean;
}) {
  return {
    id: ThreadId.make(input.id),
    modelSelection: {
      instanceId: ProviderInstanceId.make(input.instanceId ?? "claudeAgent"),
      model: input.model ?? "claude-fable-5-1",
    },
    session: null,
    latestTurn: null,
    latestUserMessageAt:
      input.lastMessage === undefined ? "2026-09-24T12:00:00.000Z" : input.lastMessage,
    createdAt: "2026-09-01T00:00:00.000Z",
    archivedAt: input.archived ? "2026-09-24T00:00:00.000Z" : null,
  };
}

const plan = (threads: ReturnType<typeof thread>[]) =>
  planUpdateThreadModel({
    threads,
    providers,
    target,
    nowMs: NOW,
    sameAccountsAsTarget: new Set(["claudeAgent", "claudeAgent_claude_2"]),
  });

const ids = (list: ReadonlyArray<{ id: string }>) => list.map((entry) => entry.id);

describe("planUpdateThreadModel", () => {
  it("moves threads used in the last three days, including across a Max account", () => {
    const result = plan([
      thread({ id: "recent" }),
      thread({ id: "thursday", instanceId: "claudeAgent_claude_2" }),
      thread({ id: "old", lastMessage: "2026-09-20T00:00:00.000Z" }),
      thread({ id: "archived", archived: true }),
    ]);
    expect(ids(result.update)).toEqual(["recent", "thursday"]);
    expect(result.skipped).toEqual([]);
  });

  it("counts a thread on the other account of the group, same model, as already there", () => {
    const result = plan([
      thread({ id: "same", instanceId: "claudeAgent_claude_2", model: "claude-opus-5-5" }),
    ]);
    expect(ids(result.unchanged)).toEqual(["same"]);
    expect(result.update).toEqual([]);
  });

  it("leaves started threads on another agent or another history alone", () => {
    const result = plan([
      thread({ id: "codex", instanceId: "codex", model: "gpt-6" }),
      thread({ id: "work", instanceId: "claudeAgent_work" }),
    ]);
    expect(result.skipped.map((entry) => [entry.thread.id, entry.reason])).toEqual([
      ["codex", "otherAgent"],
      ["work", "otherHistory"],
    ]);
  });

  it("moves a thread that never started to any agent", () => {
    const result = plan([
      thread({ id: "fresh", instanceId: "codex", model: "gpt-6", lastMessage: null }),
    ]);
    // Never started: judged by creation time, which is weeks ago here.
    expect(result.update).toEqual([]);
    const created = planUpdateThreadModel({
      threads: [
        {
          ...thread({ id: "fresh", instanceId: "codex", lastMessage: null }),
          createdAt: "2026-09-24T10:00:00.000Z",
        },
      ],
      providers,
      target,
      nowMs: NOW,
    });
    expect(ids(created.update)).toEqual(["fresh"]);
  });
});

describe("describeUpdateThreadModelResult", () => {
  it("says what moved and what was left", () => {
    expect(
      describeUpdateThreadModelResult({
        modelLabel: "Opus 5.5",
        updated: 12,
        unchanged: 1,
        failed: 0,
        skipped: [{ reason: "otherAgent" }, { reason: "otherAgent" }],
        projectDefaults: 1,
      }),
    ).toEqual({
      title: "12 threads moved to Opus 5.5",
      description:
        "New threads start on Opus 5.5, as do 1 project default. 1 thread already on it. 2 threads left as is, on another agent.",
    });
  });
});
