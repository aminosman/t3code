/**
 * ClaudeAccountRouter — answers "which Claude instance should run this turn?"
 *
 * Pairs each Claude instance's published usage windows with its
 * `accountGroup` / `switchAtPercent` settings and applies the pure policy in
 * `claudeAccountRouting`. Reads only; deciding to switch and acting on it are
 * separate so a caller can surface the decision without moving a live turn.
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
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  parseSwitchAtPercent,
  selectClaudeAccount,
  type ClaudeAccountCandidate,
  type ClaudeRoutingDecision,
} from "./claudeAccountRouting.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export class ClaudeAccountRouter extends Context.Service<
  ClaudeAccountRouter,
  {
    /** Every Claude instance paired with its group settings and usage. */
    readonly listCandidates: Effect.Effect<ReadonlyArray<ClaudeAccountCandidate>>;
    /**
     * Which instance should serve the next turn. Falls back to staying put
     * whenever settings or usage cannot be read: a routing layer must never
     * be the reason a turn does not run.
     */
    readonly resolve: (
      requestedInstanceId: ProviderInstanceId,
    ) => Effect.Effect<ClaudeRoutingDecision>;
  }
>()("t3/provider/Layers/ClaudeAccountRouter") {}

const makeClaudeAccountRouter = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const settingsService = yield* ServerSettingsService;

  const listCandidates: Effect.Effect<ReadonlyArray<ClaudeAccountCandidate>> = Effect.gen(
    function* () {
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

        // Snapshot reads are per-instance and cached; a failure here means one
        // account is unreadable, which must not hide the rest of the group.
        const usageLimits: ServerProviderUsageLimits | undefined =
          yield* instance.snapshot.getSnapshot.pipe(
            Effect.map((snapshot) => snapshot.usageLimits),
            Effect.catchCause(() => Effect.succeed(undefined)),
          );

        candidates.push({
          instanceId: instance.instanceId,
          accountGroup: config.accountGroup,
          switchAtPercent: parseSwitchAtPercent(config.switchAtPercent),
          enabled: instance.enabled,
          usageLimits,
        });
      }
      return candidates;
    },
  ).pipe(Effect.catchCause(() => Effect.succeed([])));

  const resolve = (requestedInstanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const candidates = yield* listCandidates;
      const nowMs = yield* Clock.currentTimeMillis;
      return selectClaudeAccount({ requestedInstanceId, candidates, nowMs });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed<ClaudeRoutingDecision>({
          _tag: "Stay",
          instanceId: requestedInstanceId,
          reason: "ungrouped",
          sessionPercent: undefined,
        }),
      ),
    );

  return { listCandidates, resolve } as const;
});

export const ClaudeAccountRouterLive = Layer.effect(ClaudeAccountRouter, makeClaudeAccountRouter);

export { makeClaudeAccountRouter };
