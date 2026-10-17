/**
 * ClaudeAccountRouter — answers "which Claude instance should run this turn?"
 *
 * Pairs each grouped Claude instance's live usage windows with its
 * `accountGroup` / `switchAtPercent` settings and applies the pure policy in
 * `claudeAccountRouting`. Reads only; deciding to switch and acting on it are
 * separate so a caller can surface the decision without moving a live turn.
 *
 * Usage comes from `ClaudeUsageReader` (the OAuth usage endpoint, read with
 * the account's own token) and falls back to the windows the status probe
 * last published, so an instance is never routed on a guess when a direct
 * read is unavailable.
 *
 * A turn the provider refused on its limit is remembered against that account
 * and model until the limit resets (`noteLimited`). Usage reads lag and a
 * throughput 429 can arrive with the windows nowhere near the threshold, so
 * without this the router would send the retry straight back to the account
 * that just refused it.
 *
 * Config comes from `deriveProviderInstanceConfigMap` rather than
 * `settings.providerInstances` directly, so the default instance's legacy
 * `providers.claudeAgent` blob resolves the same way the registry resolves it.
 *
 * @module provider/Layers/ClaudeAccountRouter
 */
import {
  ClaudeSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveClaudeHomeLayout } from "../Drivers/ClaudeHomeLayout.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  modelFamily,
  parseSwitchAtPercent,
  selectClaudeAccount,
  type ClaudeAccountCandidate,
  type ClaudeRoutingDecision,
  type ClaudeUsageWindow,
} from "./claudeAccountRouting.ts";
import { ClaudeUsageReader } from "./claudeUsageReader.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

/** How long a refusal that names no reset keeps its account out. */
export const LIMITED_COOLDOWN_MS = 5 * 60 * 1000;

interface LimitedMark {
  readonly family: string | undefined;
  readonly untilMs: number;
}

/**
 * A remembered refusal as a window the policy already understands: blocked
 * for the model's family (or the whole account when the family is unknown),
 * elapsing when the limit resets.
 */
export function limitedMarkWindow(mark: LimitedMark): ClaudeUsageWindow {
  const base = {
    usedPercent: 100,
    severity: "blocked" as const,
    resetsAt: DateTime.formatIso(DateTime.makeUnsafe(mark.untilMs)),
  };
  return mark.family === undefined
    ? { kind: "session", ...base }
    : { kind: "weeklyScoped", model: mark.family, ...base };
}
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/**
 * The probe's published windows, in the policy's shape. Scoped weeklies carry
 * the model name in their id (`seven_day_fable`); the probe has no severity.
 */
export function snapshotUsageToWindows(
  limits: ServerProviderUsageLimits | undefined,
): ReadonlyArray<ClaudeUsageWindow> | undefined {
  if (!limits || limits.unavailable || limits.windows.length === 0) return undefined;
  const windows: ClaudeUsageWindow[] = [];
  for (const window of limits.windows) {
    const base = { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
    if (window.kind === "session") {
      windows.push({ kind: "session", ...base });
    } else if (window.kind === "weekly" && window.id === "seven_day") {
      windows.push({ kind: "weekly", ...base });
    } else if (window.kind === "weekly" && window.id.startsWith("seven_day_")) {
      windows.push({ kind: "weeklyScoped", model: window.id.slice("seven_day_".length), ...base });
    }
  }
  return windows;
}

export class ClaudeAccountRouter extends Context.Service<
  ClaudeAccountRouter,
  {
    /** Every grouped Claude instance paired with its settings and usage. */
    readonly listCandidates: (
      requestedModel: string | undefined,
    ) => Effect.Effect<ReadonlyArray<ClaudeAccountCandidate>>;
    /**
     * Which instance should serve the next turn on `requestedModel`. Falls
     * back to staying put whenever settings or usage cannot be read: a routing
     * layer must never be the reason a turn does not run.
     */
    readonly resolve: (
      requestedInstanceId: ProviderInstanceId,
      requestedModel: string | undefined,
    ) => Effect.Effect<ClaudeRoutingDecision>;
    /**
     * The provider refused a turn on `instanceId` for `model` on its limit.
     * Keeps that account out for the model until `resetAt`, or for
     * `LIMITED_COOLDOWN_MS` when the refusal names no reset.
     */
    readonly noteLimited: (
      instanceId: ProviderInstanceId,
      model: string | undefined,
      resetAt: string | null | undefined,
    ) => Effect.Effect<void>;
  }
>()("t3/provider/Layers/ClaudeAccountRouter") {}

const makeClaudeAccountRouter = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const settingsService = yield* ServerSettingsService;
  const usageReader = yield* ClaudeUsageReader;
  const path = yield* Path.Path;
  const limited = yield* Ref.make(new Map<ProviderInstanceId, ReadonlyArray<LimitedMark>>());

  const noteLimited = (
    instanceId: ProviderInstanceId,
    model: string | undefined,
    resetAt: string | null | undefined,
  ) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
      const untilMs =
        Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : nowMs + LIMITED_COOLDOWN_MS;
      const family = modelFamily(model);
      yield* Ref.update(limited, (marks) => {
        const next = new Map(marks);
        const kept = (marks.get(instanceId) ?? []).filter(
          (mark) => mark.untilMs > nowMs && mark.family !== family,
        );
        next.set(instanceId, [...kept, { family, untilMs }]);
        return next;
      });
    });

  const listCandidates = (_requestedModel: string | undefined) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const configMap = deriveProviderInstanceConfigMap(settings);
      const instances = yield* registry.listInstances;
      const limitedMarks = yield* Ref.get(limited);
      const nowMs = yield* Clock.currentTimeMillis;

      const candidates: ClaudeAccountCandidate[] = [];
      for (const instance of instances) {
        if (instance.driverKind !== CLAUDE_DRIVER_KIND) continue;

        const decoded = decodeClaudeSettings(configMap[instance.instanceId]?.config ?? {});
        if (Option.isNone(decoded)) continue;
        const config = decoded.value;
        if (config.accountGroup.trim().length === 0) continue;

        const layout = yield* resolveClaudeHomeLayout(config).pipe(
          Effect.provideService(Path.Path, path),
        );
        const direct = yield* usageReader.read(layout.effectiveHomePath);
        // A failed read for one account must not hide the rest of the group.
        const published = yield* instance.snapshot.getSnapshot.pipe(
          Effect.map((snapshot) => snapshotUsageToWindows(snapshot.usageLimits)),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );

        const read = direct ?? published;
        const marks = (limitedMarks.get(instance.instanceId) ?? []).filter(
          (mark) => mark.untilMs > nowMs,
        );
        candidates.push({
          instanceId: instance.instanceId,
          accountGroup: config.accountGroup,
          switchAtPercent: parseSwitchAtPercent(config.switchAtPercent),
          enabled: instance.enabled,
          windows: marks.length === 0 ? read : [...(read ?? []), ...marks.map(limitedMarkWindow)],
        });
      }
      return candidates;
    }).pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ClaudeAccountCandidate>)));

  const resolve = (requestedInstanceId: ProviderInstanceId, requestedModel: string | undefined) =>
    Effect.gen(function* () {
      const candidates = yield* listCandidates(requestedModel);
      const nowMs = yield* Clock.currentTimeMillis;
      return selectClaudeAccount({ requestedInstanceId, requestedModel, candidates, nowMs });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed<ClaudeRoutingDecision>({
          _tag: "Stay",
          instanceId: requestedInstanceId,
          reason: "ungrouped",
          standing: undefined,
        }),
      ),
    );

  return { listCandidates, resolve, noteLimited } as const;
});

export const ClaudeAccountRouterLive = Layer.effect(ClaudeAccountRouter, makeClaudeAccountRouter);

export { makeClaudeAccountRouter };
