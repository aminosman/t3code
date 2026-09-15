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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveClaudeHomeLayout } from "../Drivers/ClaudeHomeLayout.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  parseSwitchAtPercent,
  selectClaudeAccount,
  type ClaudeAccountCandidate,
  type ClaudeRoutingDecision,
  type ClaudeUsageWindow,
} from "./claudeAccountRouting.ts";
import { ClaudeUsageReader } from "./claudeUsageReader.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
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
  }
>()("t3/provider/Layers/ClaudeAccountRouter") {}

const makeClaudeAccountRouter = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const settingsService = yield* ServerSettingsService;
  const usageReader = yield* ClaudeUsageReader;
  const path = yield* Path.Path;

  const listCandidates = (_requestedModel: string | undefined) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const configMap = deriveProviderInstanceConfigMap(settings);
      const instances = yield* registry.listInstances;

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

        candidates.push({
          instanceId: instance.instanceId,
          accountGroup: config.accountGroup,
          switchAtPercent: parseSwitchAtPercent(config.switchAtPercent),
          enabled: instance.enabled,
          windows: direct ?? published,
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

  return { listCandidates, resolve } as const;
});

export const ClaudeAccountRouterLive = Layer.effect(ClaudeAccountRouter, makeClaudeAccountRouter);

export { makeClaudeAccountRouter };
