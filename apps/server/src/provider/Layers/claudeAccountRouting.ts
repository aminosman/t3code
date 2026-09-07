/**
 * Account rotation policy for Claude instances that share an `accountGroup`.
 *
 * Two Max subscriptions do not raise the ceiling on their own: alternating on
 * a timer keeps both 5-hour windows open and filling in parallel, so they
 * exhaust together and every switch re-pays prompt-cache cost on the account
 * being switched to. Draining one account to a threshold and then handing over
 * is strictly better — the sibling's window is untouched when it is needed,
 * the drained one recovers while it is idle, and switches happen roughly once
 * per session window instead of continuously.
 *
 * The policy is pure so the decision can be unit-tested against window shapes
 * that are painful to reproduce live; `ClaudeAccountRouter` supplies the
 * candidates.
 *
 * An elapsed window counts as empty. That is what makes the rotation work
 * without polling idle accounts: the last snapshot taken before switching away
 * carries `resetsAt`, and once that passes the account is known to be free
 * again without asking.
 *
 * @module provider/Layers/claudeAccountRouting
 */
import type { ProviderInstanceId, ServerProviderUsageLimits } from "@t3tools/contracts";

/** Applied when `switchAtPercent` is empty. Leaves room to finish a turn. */
export const DEFAULT_SWITCH_AT_PERCENT = 85;

/**
 * A sibling this close to its weekly cap is not worth switching to: the
 * weekly window recovers over days, so spending it to dodge a 5-hour window
 * trades a cheap wait for an expensive one.
 */
export const WEEKLY_EXHAUSTED_PERCENT = 98;

export interface ClaudeAccountCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly accountGroup: string;
  readonly switchAtPercent: number;
  readonly enabled: boolean;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
}

export type ClaudeStayReason =
  /** No group configured, so this instance is not in rotation. */
  | "ungrouped"
  /** No usable window data; never reroute on a guess. */
  | "noUsageData"
  /** Still below the hand-over threshold. */
  | "underThreshold"
  /** Over threshold, but the group has no other member. */
  | "soleMember";

export type ClaudeRoutingDecision =
  | {
      readonly _tag: "Stay";
      readonly instanceId: ProviderInstanceId;
      readonly reason: ClaudeStayReason;
      readonly sessionPercent: number | undefined;
    }
  | {
      readonly _tag: "Switch";
      readonly from: ProviderInstanceId;
      readonly to: ProviderInstanceId;
      readonly fromSessionPercent: number;
      readonly toSessionPercent: number;
      readonly toWeeklyPercent: number;
    }
  | {
      readonly _tag: "Exhausted";
      readonly instanceId: ProviderInstanceId;
      readonly sessionPercent: number;
      /** Earliest moment any group member frees up, when one is known. */
      readonly retryAt: string | undefined;
    };

/** Empty means "use the default"; the schema already bounds the digits. */
export function parseSwitchAtPercent(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_SWITCH_AT_PERCENT;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100
    ? parsed
    : DEFAULT_SWITCH_AT_PERCENT;
}

function millis(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

/** A window whose reset has passed is spent, whatever percentage it reports. */
function effectivePercent(
  window: { readonly usedPercent: number; readonly resetsAt?: string | undefined },
  nowMs: number,
): number {
  const resetsAtMs = millis(window.resetsAt);
  if (resetsAtMs !== undefined && resetsAtMs <= nowMs) return 0;
  return window.usedPercent;
}

function usableWindows(limits: ServerProviderUsageLimits | undefined) {
  if (!limits || limits.unavailable || limits.windows.length === 0) return undefined;
  return limits.windows;
}

export function sessionPercent(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): number | undefined {
  const windows = usableWindows(limits);
  if (!windows) return undefined;
  const session = windows.filter((window) => window.kind === "session");
  if (session.length === 0) return undefined;
  return Math.max(...session.map((window) => effectivePercent(window, nowMs)));
}

/**
 * The binding weekly constraint. Claude reports an account-wide weekly plus
 * model-scoped weeklies; the highest is the one that will stop a turn.
 */
export function weeklyPercent(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): number {
  const windows = usableWindows(limits);
  if (!windows) return 0;
  const weekly = windows.filter((window) => window.kind === "weekly");
  if (weekly.length === 0) return 0;
  return Math.max(...weekly.map((window) => effectivePercent(window, nowMs)));
}

/** Soonest session reset in the group, for telling the user when to retry. */
function earliestSessionReset(
  candidates: ReadonlyArray<ClaudeAccountCandidate>,
  nowMs: number,
): string | undefined {
  let best: { readonly at: number; readonly iso: string } | undefined;
  for (const candidate of candidates) {
    for (const window of usableWindows(candidate.usageLimits) ?? []) {
      if (window.kind !== "session" || !window.resetsAt) continue;
      const at = millis(window.resetsAt);
      if (at === undefined || at <= nowMs) continue;
      if (!best || at < best.at) best = { at, iso: window.resetsAt };
    }
  }
  return best?.iso;
}

/**
 * Rank by weekly first: the accounts' weekly windows drift out of alignment,
 * so the sibling with the freshest 5-hour window is often the one whose weekly
 * budget is nearly spent. Session percent breaks weekly ties, and instance id
 * makes the choice deterministic when both are equal.
 */
function preferFreshest(
  left: { readonly weekly: number; readonly session: number; readonly id: string },
  right: { readonly weekly: number; readonly session: number; readonly id: string },
): number {
  return (
    left.weekly - right.weekly || left.session - right.session || left.id.localeCompare(right.id)
  );
}

export function selectClaudeAccount(input: {
  readonly requestedInstanceId: ProviderInstanceId;
  readonly candidates: ReadonlyArray<ClaudeAccountCandidate>;
  readonly nowMs: number;
}): ClaudeRoutingDecision {
  const { requestedInstanceId, candidates, nowMs } = input;
  const requested = candidates.find((candidate) => candidate.instanceId === requestedInstanceId);

  const group = requested?.accountGroup.trim() ?? "";
  if (!requested || group.length === 0) {
    return {
      _tag: "Stay",
      instanceId: requestedInstanceId,
      reason: "ungrouped",
      sessionPercent: undefined,
    };
  }

  const current = sessionPercent(requested.usageLimits, nowMs);
  if (current === undefined) {
    return {
      _tag: "Stay",
      instanceId: requestedInstanceId,
      reason: "noUsageData",
      sessionPercent: undefined,
    };
  }
  if (current < requested.switchAtPercent) {
    return {
      _tag: "Stay",
      instanceId: requestedInstanceId,
      reason: "underThreshold",
      sessionPercent: current,
    };
  }

  const siblings = candidates.filter(
    (candidate) =>
      candidate.instanceId !== requestedInstanceId &&
      candidate.enabled &&
      candidate.accountGroup.trim() === group,
  );
  if (siblings.length === 0) {
    return {
      _tag: "Stay",
      instanceId: requestedInstanceId,
      reason: "soleMember",
      sessionPercent: current,
    };
  }

  const eligible = siblings
    .map((candidate) => ({
      candidate,
      // A sibling with no usage data yet is assumed fresh: it has either never
      // run or never reported, and the alternative is refusing to hand over.
      session: sessionPercent(candidate.usageLimits, nowMs) ?? 0,
      weekly: weeklyPercent(candidate.usageLimits, nowMs),
    }))
    .filter(
      (entry) =>
        entry.session < entry.candidate.switchAtPercent && entry.weekly < WEEKLY_EXHAUSTED_PERCENT,
    )
    .toSorted((left, right) =>
      preferFreshest(
        { weekly: left.weekly, session: left.session, id: left.candidate.instanceId },
        { weekly: right.weekly, session: right.session, id: right.candidate.instanceId },
      ),
    );

  const winner = eligible[0];
  if (!winner) {
    return {
      _tag: "Exhausted",
      instanceId: requestedInstanceId,
      sessionPercent: current,
      retryAt: earliestSessionReset([requested, ...siblings], nowMs),
    };
  }

  return {
    _tag: "Switch",
    from: requestedInstanceId,
    to: winner.candidate.instanceId,
    fromSessionPercent: current,
    toSessionPercent: winner.session,
    toWeeklyPercent: winner.weekly,
  };
}
