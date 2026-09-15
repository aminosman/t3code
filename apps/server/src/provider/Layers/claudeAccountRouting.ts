/**
 * Account rotation policy for Claude instances that share an `accountGroup`.
 *
 * The model the user picked decides which windows matter: the session and
 * overall weekly windows always apply, and a model-scoped weekly (Claude
 * reports one for Fable today) applies when it names that model's family.
 * An account is out for a model when any of those windows is at the switch
 * threshold or reported critical/blocked.
 *
 * Among accounts that still have budget for the model, the one whose binding
 * window resets soonest is drained first: budget that is about to reset is
 * lost if unused, while the other account's keeps. Once that window resets it
 * moves a week out, the other account becomes the soonest, and the rotation
 * alternates on its own.
 *
 * An elapsed window counts as empty, so an account that was drained and left
 * idle is known to be fresh again without probing it.
 *
 * Pure, so the decision can be tested against window shapes that are painful
 * to reproduce live; `ClaudeAccountRouter` supplies the candidates.
 *
 * @module provider/Layers/claudeAccountRouting
 */
import type { ProviderInstanceId } from "@t3tools/contracts";

/** Applied when `switchAtPercent` is empty. Leaves room to finish a turn. */
export const DEFAULT_SWITCH_AT_PERCENT = 85;

export type ClaudeUsageSeverity = "normal" | "warning" | "critical" | "blocked";

export interface ClaudeUsageWindow {
  readonly kind: "session" | "weekly" | "weeklyScoped";
  /** Lower-cased model family a `weeklyScoped` window applies to, e.g. `fable`. */
  readonly model?: string | undefined;
  readonly usedPercent: number;
  readonly severity?: ClaudeUsageSeverity | undefined;
  readonly resetsAt?: string | undefined;
}

export interface ClaudeAccountCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly accountGroup: string;
  readonly switchAtPercent: number;
  readonly enabled: boolean;
  /** `undefined` when nothing could be read; an empty array means "no limits". */
  readonly windows: ReadonlyArray<ClaudeUsageWindow> | undefined;
}

export type ClaudeStayReason =
  /** No group configured, so this instance is not in rotation. */
  | "ungrouped"
  /** No usable window data for the requested instance; never reroute on a guess. */
  | "noUsageData"
  /** The requested instance is the one to drain right now. */
  | "preferred";

export type ClaudeSwitchReason =
  /** The requested instance is out for this model. */
  | "blocked"
  /** Both have budget; the sibling's window resets sooner, so it is drained first. */
  | "resetsSooner";

export interface ClaudeAccountStanding {
  readonly instanceId: ProviderInstanceId;
  /** Highest effective percent among the windows that bind this model. */
  readonly pressurePercent: number;
  /** When the model's binding weekly window resets, if known and still ahead. */
  readonly resetsAt: string | undefined;
  /** Which window put the account out, when it is out. */
  readonly blockedBy: ClaudeUsageWindow["kind"] | undefined;
}

export type ClaudeRoutingDecision =
  | {
      readonly _tag: "Stay";
      readonly instanceId: ProviderInstanceId;
      readonly reason: ClaudeStayReason;
      readonly standing: ClaudeAccountStanding | undefined;
    }
  | {
      readonly _tag: "Switch";
      readonly from: ProviderInstanceId;
      readonly to: ProviderInstanceId;
      readonly reason: ClaudeSwitchReason;
      readonly fromStanding: ClaudeAccountStanding;
      readonly toStanding: ClaudeAccountStanding;
    }
  | {
      readonly _tag: "Exhausted";
      readonly instanceId: ProviderInstanceId;
      readonly standing: ClaudeAccountStanding;
      /** Earliest moment any group member frees up for this model, when known. */
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

/**
 * `claude-fable-5-1[1m]` → `fable`, `claude-opus-5` → `opus`. Claude names
 * scoped windows by the model's display name, which matches the family token.
 */
export function modelFamily(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const match = /^claude-([a-z]+)/i.exec(model.trim());
  return match?.[1]?.toLowerCase();
}

function millis(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

function elapsed(window: ClaudeUsageWindow, nowMs: number): boolean {
  const resetsAtMs = millis(window.resetsAt);
  return resetsAtMs !== undefined && resetsAtMs <= nowMs;
}

/** A window whose reset has passed is spent, whatever it last reported. */
function effectivePercent(window: ClaudeUsageWindow, nowMs: number): number {
  return elapsed(window, nowMs) ? 0 : window.usedPercent;
}

/** The windows that can stop a turn on this model. */
function bindingWindows(
  windows: ReadonlyArray<ClaudeUsageWindow>,
  family: string | undefined,
): ReadonlyArray<ClaudeUsageWindow> {
  return windows.filter(
    (window) => window.kind !== "weeklyScoped" || (family !== undefined && window.model === family),
  );
}

export function accountStanding(
  candidate: ClaudeAccountCandidate,
  family: string | undefined,
  nowMs: number,
): ClaudeAccountStanding | undefined {
  if (candidate.windows === undefined) return undefined;
  const binding = bindingWindows(candidate.windows, family);

  let pressurePercent = 0;
  let blockedBy: ClaudeUsageWindow["kind"] | undefined;
  for (const window of binding) {
    if (elapsed(window, nowMs)) continue;
    const percent = effectivePercent(window, nowMs);
    pressurePercent = Math.max(pressurePercent, percent);
    const hard = window.severity === "critical" || window.severity === "blocked";
    if ((hard || percent >= candidate.switchAtPercent) && blockedBy === undefined) {
      blockedBy = window.kind;
    }
  }

  // The model's own weekly decides when this account is worth draining; the
  // overall weekly stands in when the model has no scoped window.
  const weekly =
    binding.find((window) => window.kind === "weeklyScoped") ??
    binding.find((window) => window.kind === "weekly");
  const resetsAt = weekly && !elapsed(weekly, nowMs) ? weekly.resetsAt : undefined;

  return { instanceId: candidate.instanceId, pressurePercent, resetsAt, blockedBy };
}

/**
 * Soonest reset first; an unknown reset means a fresh window with a week
 * ahead, so it sorts last. Ties go to the fuller account (drain it out), then
 * to instance id so the choice is deterministic.
 */
function drainFirst(left: ClaudeAccountStanding, right: ClaudeAccountStanding): number {
  const l = millis(left.resetsAt) ?? Number.POSITIVE_INFINITY;
  const r = millis(right.resetsAt) ?? Number.POSITIVE_INFINITY;
  return (
    l - r ||
    right.pressurePercent - left.pressurePercent ||
    left.instanceId.localeCompare(right.instanceId)
  );
}

function earliestReset(
  standings: ReadonlyArray<ClaudeAccountStanding>,
  nowMs: number,
): string | undefined {
  let best: { readonly at: number; readonly iso: string } | undefined;
  for (const standing of standings) {
    const at = millis(standing.resetsAt);
    if (at === undefined || at <= nowMs) continue;
    if (!best || at < best.at) best = { at, iso: standing.resetsAt! };
  }
  return best?.iso;
}

export function selectClaudeAccount(input: {
  readonly requestedInstanceId: ProviderInstanceId;
  readonly requestedModel: string | undefined;
  readonly candidates: ReadonlyArray<ClaudeAccountCandidate>;
  readonly nowMs: number;
}): ClaudeRoutingDecision {
  const { requestedInstanceId, candidates, nowMs } = input;
  const family = modelFamily(input.requestedModel);
  const requested = candidates.find((candidate) => candidate.instanceId === requestedInstanceId);

  const group = requested?.accountGroup.trim() ?? "";
  if (!requested || group.length === 0) {
    return {
      _tag: "Stay",
      instanceId: requestedInstanceId,
      reason: "ungrouped",
      standing: undefined,
    };
  }

  const requestedStanding = accountStanding(requested, family, nowMs);
  if (requestedStanding === undefined) {
    return {
      _tag: "Stay",
      instanceId: requestedInstanceId,
      reason: "noUsageData",
      standing: undefined,
    };
  }

  const members = candidates.filter(
    (candidate) => candidate.enabled && candidate.accountGroup.trim() === group,
  );
  const standings = new Map<ProviderInstanceId, ClaudeAccountStanding>();
  for (const member of members) {
    // A sibling that has never reported is assumed fresh: it has either never
    // run or never been read, and the alternative is refusing to hand over.
    const standing =
      accountStanding(member, family, nowMs) ??
      ({
        instanceId: member.instanceId,
        pressurePercent: 0,
        resetsAt: undefined,
        blockedBy: undefined,
      } satisfies ClaudeAccountStanding);
    standings.set(member.instanceId, standing);
  }
  standings.set(requestedInstanceId, requestedStanding);

  const eligible = [...standings.values()]
    .filter((standing) => standing.blockedBy === undefined)
    .toSorted(drainFirst);

  const winner = eligible[0];
  if (!winner) {
    return {
      _tag: "Exhausted",
      instanceId: requestedInstanceId,
      standing: requestedStanding,
      retryAt: earliestReset([...standings.values()], nowMs),
    };
  }
  if (winner.instanceId === requestedInstanceId) {
    return {
      _tag: "Stay",
      instanceId: requestedInstanceId,
      reason: "preferred",
      standing: requestedStanding,
    };
  }
  return {
    _tag: "Switch",
    from: requestedInstanceId,
    to: winner.instanceId,
    reason: requestedStanding.blockedBy === undefined ? "resetsSooner" : "blocked",
    fromStanding: requestedStanding,
    toStanding: winner,
  };
}
