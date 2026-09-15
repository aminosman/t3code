import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";

import {
  DEFAULT_SWITCH_AT_PERCENT,
  accountStanding,
  modelFamily,
  parseSwitchAtPercent,
  selectClaudeAccount,
  type ClaudeAccountCandidate,
  type ClaudeUsageWindow,
} from "./claudeAccountRouting.ts";

// A Tuesday. Sunday resets Sep 13, Thursday resets Sep 10 — the real accounts.
const NOW = Date.parse("2026-09-08T20:00:00.000Z");
const THURSDAY = "2026-09-10T20:00:00.000Z";
const SUNDAY = "2026-09-13T17:00:00.000Z";
const LAST_WEEK = "2026-09-06T20:00:00.000Z";
const IN_AN_HOUR = "2026-09-08T21:00:00.000Z";

const FABLE = "claude-fable-5-1[1m]";
const OPUS = "claude-opus-5[1m]";

const windows = (input: {
  readonly session?: number;
  readonly sessionResetsAt?: string;
  readonly weekly?: number;
  readonly weeklyResetsAt?: string;
  readonly fable?: number;
  readonly fableSeverity?: ClaudeUsageWindow["severity"];
  readonly fableResetsAt?: string;
}): ReadonlyArray<ClaudeUsageWindow> => [
  ...(input.session === undefined
    ? []
    : [{ kind: "session" as const, usedPercent: input.session, resetsAt: input.sessionResetsAt }]),
  ...(input.weekly === undefined
    ? []
    : [{ kind: "weekly" as const, usedPercent: input.weekly, resetsAt: input.weeklyResetsAt }]),
  ...(input.fable === undefined
    ? []
    : [
        {
          kind: "weeklyScoped" as const,
          model: "fable",
          usedPercent: input.fable,
          severity: input.fableSeverity,
          resetsAt: input.fableResetsAt ?? input.weeklyResetsAt,
        },
      ]),
];

const candidate = (
  id: string,
  overrides: Partial<Omit<ClaudeAccountCandidate, "instanceId">> = {},
): ClaudeAccountCandidate => ({
  instanceId: ProviderInstanceId.make(id),
  accountGroup: "max",
  switchAtPercent: DEFAULT_SWITCH_AT_PERCENT,
  enabled: true,
  windows: windows({ session: 10, weekly: 10 }),
  ...overrides,
});

/** The real Sunday/Thursday pair on a Tuesday, Fable blocked on Sunday. */
const sunday = (o: Parameters<typeof windows>[0] = {}) =>
  candidate("sunday", {
    windows: windows({
      session: 9,
      weekly: 67,
      weeklyResetsAt: SUNDAY,
      fable: 100,
      fableSeverity: "critical",
      ...o,
    }),
  });
const thursday = (o: Parameters<typeof windows>[0] = {}) =>
  candidate("thursday", {
    windows: windows({ session: 3, weekly: 35, weeklyResetsAt: THURSDAY, fable: 60, ...o }),
  });

const select = (
  requested: string,
  model: string | undefined,
  candidates: ReadonlyArray<ClaudeAccountCandidate>,
) =>
  selectClaudeAccount({
    requestedInstanceId: ProviderInstanceId.make(requested),
    requestedModel: model,
    candidates,
    nowMs: NOW,
  });

describe("parseSwitchAtPercent", () => {
  it("falls back to the default for empty or unusable input", () => {
    expect(parseSwitchAtPercent("")).toBe(DEFAULT_SWITCH_AT_PERCENT);
    expect(parseSwitchAtPercent("0")).toBe(DEFAULT_SWITCH_AT_PERCENT);
    expect(parseSwitchAtPercent("101")).toBe(DEFAULT_SWITCH_AT_PERCENT);
  });

  it("takes a configured percentage", () => {
    expect(parseSwitchAtPercent("60")).toBe(60);
    expect(parseSwitchAtPercent("100")).toBe(100);
  });
});

describe("modelFamily", () => {
  it("reads the family token Claude names scoped windows by", () => {
    expect(modelFamily(FABLE)).toBe("fable");
    expect(modelFamily(OPUS)).toBe("opus");
    expect(modelFamily("claude-sonnet-5")).toBe("sonnet");
    expect(modelFamily(undefined)).toBeUndefined();
    expect(modelFamily("gpt-5-codex")).toBeUndefined();
  });
});

describe("accountStanding", () => {
  it("binds the model's scoped weekly and ignores other models' scoped windows", () => {
    const s = accountStanding(sunday(), "fable", NOW);
    expect(s).toMatchObject({ pressurePercent: 100, blockedBy: "weeklyScoped", resetsAt: SUNDAY });
    const o = accountStanding(sunday(), "opus", NOW);
    expect(o).toMatchObject({ pressurePercent: 67, blockedBy: undefined, resetsAt: SUNDAY });
  });

  it("treats critical severity as blocked regardless of percent", () => {
    const c = candidate("x", {
      windows: windows({ session: 5, fable: 40, fableSeverity: "critical" }),
    });
    expect(accountStanding(c, "fable", NOW)?.blockedBy).toBe("weeklyScoped");
  });

  // Lets the rotation work without polling the idle account.
  it("treats an elapsed window as spent, with no reset ahead", () => {
    const c = candidate("x", {
      windows: windows({
        session: 99,
        sessionResetsAt: LAST_WEEK,
        fable: 100,
        fableSeverity: "critical",
        fableResetsAt: LAST_WEEK,
        weekly: 90,
        weeklyResetsAt: LAST_WEEK,
      }),
    });
    expect(accountStanding(c, "fable", NOW)).toMatchObject({
      pressurePercent: 0,
      blockedBy: undefined,
      resetsAt: undefined,
    });
  });

  it("falls back to the overall weekly's reset when the model has no scoped window", () => {
    expect(accountStanding(thursday(), "opus", NOW)?.resetsAt).toBe(THURSDAY);
  });

  it("is undefined when nothing was read", () => {
    expect(accountStanding(candidate("x", { windows: undefined }), "fable", NOW)).toBeUndefined();
  });
});

describe("selectClaudeAccount", () => {
  it("stays put when the instance is not in a group or is unknown", () => {
    expect(select("a", FABLE, [candidate("a", { accountGroup: "" })])).toMatchObject({
      _tag: "Stay",
      reason: "ungrouped",
    });
    expect(select("ghost", FABLE, [candidate("a")])).toMatchObject({
      _tag: "Stay",
      reason: "ungrouped",
    });
  });

  // Rerouting on a guess would move work to an account for no reason.
  it("stays put when the requested account has no usage data", () => {
    const d = select("a", FABLE, [candidate("a", { windows: undefined }), candidate("b")]);
    expect(d).toMatchObject({ _tag: "Stay", reason: "noUsageData" });
  });

  // The incident: Fable blocked on Sunday, session barely used, Thursday has Fable.
  it("switches off an account whose Fable weekly is blocked even though its session is low", () => {
    const d = select("sunday", FABLE, [sunday(), thursday()]);
    expect(d).toMatchObject({ _tag: "Switch", from: "sunday", to: "thursday", reason: "blocked" });
    expect(d._tag === "Switch" && d.fromStanding.blockedBy).toBe("weeklyScoped");
  });

  // The same Sunday account is fine for Opus: its Fable block is irrelevant.
  it("keeps using an account for a model it still has budget for", () => {
    // Thursday resets sooner, so Thursday is still preferred for Opus...
    expect(select("sunday", OPUS, [sunday(), thursday()])).toMatchObject({
      _tag: "Switch",
      to: "thursday",
      reason: "resetsSooner",
    });
    // ...but once Thursday is out of overall weekly, Sunday serves Opus.
    expect(select("sunday", OPUS, [sunday(), thursday({ weekly: 99 })])).toMatchObject({
      _tag: "Stay",
      reason: "preferred",
    });
  });

  // Use-it-or-lose-it: drain the window that resets first.
  it("prefers the account whose window resets soonest when both have budget", () => {
    const d = select("sunday", FABLE, [sunday({ fable: 30, fableSeverity: "normal" }), thursday()]);
    expect(d).toMatchObject({ _tag: "Switch", to: "thursday", reason: "resetsSooner" });
    expect(
      select("thursday", FABLE, [sunday({ fable: 30, fableSeverity: "normal" }), thursday()]),
    ).toMatchObject({ _tag: "Stay", reason: "preferred" });
  });

  // After Thursday's window rolls over, Sunday becomes the soonest and gets drained.
  it("alternates once the soonest window has reset", () => {
    const rolled = thursday({ weeklyResetsAt: LAST_WEEK, fable: 60 });
    const d = select("thursday", FABLE, [sunday({ fable: 30, fableSeverity: "normal" }), rolled]);
    expect(d).toMatchObject({ _tag: "Switch", to: "sunday", reason: "resetsSooner" });
  });

  it("does not switch to a sibling that is blocked for the same model", () => {
    const d = select("sunday", FABLE, [
      sunday(),
      thursday({ fable: 100, fableSeverity: "critical" }),
    ]);
    expect(d).toMatchObject({ _tag: "Exhausted", instanceId: "sunday", retryAt: THURSDAY });
  });

  it("switches to a sibling blocked only for a different model", () => {
    // Thursday out of Fable but fine for Opus; Sunday's Opus budget resets later.
    const d = select("sunday", OPUS, [
      sunday(),
      thursday({ fable: 100, fableSeverity: "critical" }),
    ]);
    expect(d).toMatchObject({ _tag: "Switch", to: "thursday", reason: "resetsSooner" });
  });

  it("honours the session window and a custom threshold", () => {
    const d = select("a", FABLE, [
      candidate("a", {
        switchAtPercent: 50,
        windows: windows({ session: 55, sessionResetsAt: IN_AN_HOUR, weekly: 5 }),
      }),
      candidate("b", { windows: windows({ session: 5, weekly: 5 }) }),
    ]);
    expect(d).toMatchObject({ _tag: "Switch", to: "b", reason: "blocked" });
    expect(d._tag === "Switch" && d.fromStanding.blockedBy).toBe("session");
  });

  it("never routes to a disabled sibling", () => {
    const d = select("sunday", FABLE, [sunday(), thursday(), candidate("off", { enabled: false })]);
    expect(d).toMatchObject({ _tag: "Switch", to: "thursday" });
    expect(
      select("sunday", FABLE, [
        sunday(),
        thursday({ fable: 100, fableSeverity: "critical" }),
        candidate("off", { enabled: false }),
      ]),
    ).toMatchObject({ _tag: "Exhausted" });
  });

  it("treats a sibling that has never reported as fresh but least urgent", () => {
    const d = select("a", FABLE, [
      candidate("a", { windows: windows({ session: 90, sessionResetsAt: IN_AN_HOUR, weekly: 5 }) }),
      candidate("b", { windows: undefined }),
    ]);
    expect(d).toMatchObject({ _tag: "Switch", to: "b", reason: "blocked" });
  });

  it("breaks ties deterministically", () => {
    const even = windows({ session: 10, weekly: 10, weeklyResetsAt: SUNDAY });
    const first = select("c", FABLE, [
      candidate("c", { windows: even }),
      candidate("b", { windows: even }),
    ]);
    const second = select("b", FABLE, [
      candidate("b", { windows: even }),
      candidate("c", { windows: even }),
    ]);
    expect(first).toMatchObject({ _tag: "Switch", to: "b" });
    expect(second).toMatchObject({ _tag: "Stay", reason: "preferred" });
  });
});
