import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ServerProviderUsageLimits } from "@t3tools/contracts";

import {
  DEFAULT_SWITCH_AT_PERCENT,
  parseSwitchAtPercent,
  selectClaudeAccount,
  sessionPercent,
  weeklyPercent,
  type ClaudeAccountCandidate,
} from "./claudeAccountRouting.ts";

const NOW = Date.parse("2026-09-06T20:00:00.000Z");
const IN_AN_HOUR = "2026-09-06T21:00:00.000Z";
const AN_HOUR_AGO = "2026-09-06T19:00:00.000Z";
const NEXT_WEEK = "2026-09-13T17:00:00.000Z";

const limits = (input: {
  readonly session?: number;
  readonly sessionResetsAt?: string;
  readonly weekly?: number;
  readonly weeklyResetsAt?: string;
  readonly scopedWeekly?: number;
}): ServerProviderUsageLimits => ({
  checkedAt: "2026-09-06T20:00:00.000Z",
  windows: [
    ...(input.session === undefined
      ? []
      : [
          {
            id: "five_hour",
            kind: "session" as const,
            label: "Session",
            usedPercent: input.session,
            ...(input.sessionResetsAt ? { resetsAt: input.sessionResetsAt } : {}),
          },
        ]),
    ...(input.weekly === undefined
      ? []
      : [
          {
            id: "seven_day",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: input.weekly,
            ...(input.weeklyResetsAt ? { resetsAt: input.weeklyResetsAt } : {}),
          },
        ]),
    ...(input.scopedWeekly === undefined
      ? []
      : [
          {
            id: "seven_day_fable",
            kind: "weekly" as const,
            label: "Weekly · Fable",
            usedPercent: input.scopedWeekly,
          },
        ]),
  ],
});

const candidate = (
  id: string,
  overrides: Partial<Omit<ClaudeAccountCandidate, "instanceId">> = {},
): ClaudeAccountCandidate => ({
  instanceId: ProviderInstanceId.make(id),
  accountGroup: "max",
  switchAtPercent: DEFAULT_SWITCH_AT_PERCENT,
  enabled: true,
  usageLimits: limits({ session: 10, weekly: 10 }),
  ...overrides,
});

const select = (requested: string, candidates: ReadonlyArray<ClaudeAccountCandidate>) =>
  selectClaudeAccount({
    requestedInstanceId: ProviderInstanceId.make(requested),
    candidates,
    nowMs: NOW,
  });

describe("parseSwitchAtPercent", () => {
  it("falls back to the default for empty or unusable input", () => {
    expect(parseSwitchAtPercent("")).toBe(DEFAULT_SWITCH_AT_PERCENT);
    expect(parseSwitchAtPercent("   ")).toBe(DEFAULT_SWITCH_AT_PERCENT);
    expect(parseSwitchAtPercent("0")).toBe(DEFAULT_SWITCH_AT_PERCENT);
    expect(parseSwitchAtPercent("101")).toBe(DEFAULT_SWITCH_AT_PERCENT);
  });

  it("takes a configured percentage", () => {
    expect(parseSwitchAtPercent("60")).toBe(60);
    expect(parseSwitchAtPercent("100")).toBe(100);
  });
});

describe("window readings", () => {
  it("reads the session window and the highest weekly window", () => {
    const value = limits({ session: 42, weekly: 30, scopedWeekly: 77 });
    expect(sessionPercent(value, NOW)).toBe(42);
    expect(weeklyPercent(value, NOW)).toBe(77);
  });

  // Lets the rotation work without polling the idle account: the snapshot
  // taken before switching away is enough to know when it frees up.
  it("treats an elapsed window as spent", () => {
    const value = limits({ session: 99, sessionResetsAt: AN_HOUR_AGO });
    expect(sessionPercent(value, NOW)).toBe(0);
  });

  it("keeps a window that has not reset yet", () => {
    const value = limits({ session: 99, sessionResetsAt: IN_AN_HOUR });
    expect(sessionPercent(value, NOW)).toBe(99);
  });

  it("reports no reading when limits are missing or unavailable", () => {
    expect(sessionPercent(undefined, NOW)).toBeUndefined();
    expect(
      sessionPercent({ checkedAt: "2026-09-06T20:00:00.000Z", windows: [] }, NOW),
    ).toBeUndefined();
    expect(
      sessionPercent(
        {
          checkedAt: "2026-09-06T20:00:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported" },
        },
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("selectClaudeAccount", () => {
  it("stays put when the instance is not in a group", () => {
    const decision = select("a", [candidate("a", { accountGroup: "" })]);
    expect(decision).toMatchObject({ _tag: "Stay", reason: "ungrouped" });
  });

  it("stays put when the instance is unknown", () => {
    expect(select("ghost", [candidate("a")])).toMatchObject({
      _tag: "Stay",
      reason: "ungrouped",
    });
  });

  // Rerouting on a guess would move work to an account for no reason.
  it("stays put when the current account has no usage data", () => {
    const decision = select("a", [candidate("a", { usageLimits: undefined }), candidate("b")]);
    expect(decision).toMatchObject({ _tag: "Stay", reason: "noUsageData" });
  });

  it("stays put below the threshold", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 84, weekly: 5 }) }),
      candidate("b"),
    ]);
    expect(decision).toMatchObject({ _tag: "Stay", reason: "underThreshold", sessionPercent: 84 });
  });

  it("stays put when nothing else shares the group", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("b", { accountGroup: "other" }),
    ]);
    expect(decision).toMatchObject({ _tag: "Stay", reason: "soleMember" });
  });

  it("hands over at the threshold", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 85, weekly: 5 }) }),
      candidate("b", { usageLimits: limits({ session: 3, weekly: 12 }) }),
    ]);
    expect(decision).toMatchObject({
      _tag: "Switch",
      from: "a",
      to: "b",
      fromSessionPercent: 85,
      toSessionPercent: 3,
    });
  });

  it("honours a custom threshold", () => {
    const decision = select("a", [
      candidate("a", { switchAtPercent: 50, usageLimits: limits({ session: 55, weekly: 5 }) }),
      candidate("b"),
    ]);
    expect(decision).toMatchObject({ _tag: "Switch", to: "b" });
  });

  // The real accounts' weekly windows are not aligned, so the sibling with the
  // emptiest session window can be the one whose weekly budget is nearly gone.
  it("prefers the lower weekly even when its session window is fuller", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("b", { usageLimits: limits({ session: 1, weekly: 92 }) }),
      candidate("c", { usageLimits: limits({ session: 40, weekly: 20 }) }),
    ]);
    expect(decision).toMatchObject({ _tag: "Switch", to: "c", toWeeklyPercent: 20 });
  });

  it("skips a sibling that is over its own session threshold", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("b", { usageLimits: limits({ session: 95, sessionResetsAt: IN_AN_HOUR }) }),
      candidate("c", { usageLimits: limits({ session: 20, weekly: 30 }) }),
    ]);
    expect(decision).toMatchObject({ _tag: "Switch", to: "c" });
  });

  it("skips a sibling that is nearly out of weekly budget", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("b", { usageLimits: limits({ session: 0, weekly: 99 }) }),
    ]);
    expect(decision).toMatchObject({ _tag: "Exhausted" });
  });

  // A group whose only other member is switched off has no alternative at
  // all, which is a different state from "every alternative is spent".
  it("treats a group whose only sibling is disabled as sole member", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("b", { enabled: false }),
    ]);
    expect(decision).toMatchObject({ _tag: "Stay", reason: "soleMember" });
  });

  it("never routes to a disabled sibling", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("b", { enabled: false, usageLimits: limits({ session: 0, weekly: 0 }) }),
      candidate("c", { usageLimits: limits({ session: 40, weekly: 25 }) }),
    ]);
    expect(decision).toMatchObject({ _tag: "Switch", to: "c" });
  });

  // The whole point of the design: the drained account becomes eligible again
  // on its own, with no probe of the idle side.
  it("returns to an account whose session window has elapsed", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, sessionResetsAt: IN_AN_HOUR }) }),
      candidate("b", {
        usageLimits: limits({ session: 100, sessionResetsAt: AN_HOUR_AGO, weekly: 40 }),
      }),
    ]);
    expect(decision).toMatchObject({ _tag: "Switch", to: "b", toSessionPercent: 0 });
  });

  it("reports when to retry once every account is spent", () => {
    const decision = select("a", [
      candidate("a", {
        usageLimits: limits({ session: 99, sessionResetsAt: NEXT_WEEK, weekly: 5 }),
      }),
      candidate("b", {
        usageLimits: limits({ session: 99, sessionResetsAt: IN_AN_HOUR, weekly: 5 }),
      }),
    ]);
    expect(decision).toMatchObject({
      _tag: "Exhausted",
      instanceId: "a",
      retryAt: IN_AN_HOUR,
    });
  });

  it("treats a sibling that has never reported as fresh", () => {
    const decision = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("b", { usageLimits: undefined }),
    ]);
    expect(decision).toMatchObject({ _tag: "Switch", to: "b", toSessionPercent: 0 });
  });

  it("breaks exact ties deterministically", () => {
    const even = limits({ session: 10, weekly: 10 });
    const first = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("c", { usageLimits: even }),
      candidate("b", { usageLimits: even }),
    ]);
    const second = select("a", [
      candidate("a", { usageLimits: limits({ session: 90, weekly: 5 }) }),
      candidate("b", { usageLimits: even }),
      candidate("c", { usageLimits: even }),
    ]);
    expect(first).toMatchObject({ _tag: "Switch", to: "b" });
    expect(second).toMatchObject({ _tag: "Switch", to: "b" });
  });
});
