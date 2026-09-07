import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerSettings,
} from "@t3tools/contracts";

import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ClaudeAccountRouter, ClaudeAccountRouterLive } from "./ClaudeAccountRouter.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

const sessionLimits = (session: number, weekly: number): ServerProviderUsageLimits => ({
  checkedAt: "2026-09-06T20:00:00.000Z",
  windows: [
    { id: "five_hour", kind: "session", label: "Session", usedPercent: session },
    { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: weekly },
  ],
});

/** Only the fields the router reads; the rest of the driver surface is unused. */
const fakeInstance = (input: {
  readonly id: string;
  readonly driverKind?: ProviderDriverKind;
  readonly enabled?: boolean;
  readonly usageLimits?: ServerProviderUsageLimits;
}): ProviderInstance =>
  ({
    instanceId: ProviderInstanceId.make(input.id),
    driverKind: input.driverKind ?? CLAUDE,
    enabled: input.enabled ?? true,
    snapshot: {
      getSnapshot: Effect.succeed(
        (input.usageLimits ? { usageLimits: input.usageLimits } : {}) as unknown as ServerProvider,
      ),
    },
  }) as unknown as ProviderInstance;

const settingsWith = (
  instances: Record<string, { readonly accountGroup?: string; readonly switchAtPercent?: string }>,
): ServerSettings =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: Object.fromEntries(
      Object.entries(instances).map(([id, config]) => [
        id,
        { driver: CLAUDE, config: { ...config } },
      ]),
    ),
  }) as ServerSettings;

const harness = (input: {
  readonly settings: ServerSettings;
  readonly instances: ReadonlyArray<ProviderInstance>;
}) =>
  Layer.provide(
    ClaudeAccountRouterLive,
    Layer.mergeAll(
      Layer.succeed(
        ServerSettingsService,
        ServerSettingsService.of({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(input.settings),
          updateSettings: () => Effect.die(new Error("unused")),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.succeed(Stream.empty),
        }),
      ),
      Layer.succeed(
        ProviderInstanceRegistry,
        ProviderInstanceRegistry.of({
          getInstance: () => Effect.succeed(undefined),
          listInstances: Effect.succeed(input.instances),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.die(new Error("unused")),
        }),
      ),
    ),
  );

describe("ClaudeAccountRouter", () => {
  it.effect("pairs grouped Claude instances with their usage windows", () =>
    Effect.gen(function* () {
      const router = yield* ClaudeAccountRouter;
      const candidates = yield* router.listCandidates;

      expect(candidates).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.instanceId)).toEqual(["a", "b"]);
      expect(candidates[0]).toMatchObject({ accountGroup: "max", switchAtPercent: 85 });
      expect(candidates[1]).toMatchObject({ switchAtPercent: 60 });
    }).pipe(
      Effect.provide(
        harness({
          settings: settingsWith({
            a: { accountGroup: "max" },
            b: { accountGroup: "max", switchAtPercent: "60" },
          }),
          instances: [
            fakeInstance({ id: "a", usageLimits: sessionLimits(10, 5) }),
            fakeInstance({ id: "b", usageLimits: sessionLimits(20, 8) }),
          ],
        }),
      ),
    ),
  );

  it.effect("ignores ungrouped instances and other drivers", () =>
    Effect.gen(function* () {
      const router = yield* ClaudeAccountRouter;
      expect(yield* router.listCandidates).toHaveLength(0);
    }).pipe(
      Effect.provide(
        harness({
          settings: settingsWith({ a: {}, codex: { accountGroup: "max" } }),
          instances: [fakeInstance({ id: "a" }), fakeInstance({ id: "codex", driverKind: CODEX })],
        }),
      ),
    ),
  );

  it.effect("routes the next turn to the freshest sibling", () =>
    Effect.gen(function* () {
      const router = yield* ClaudeAccountRouter;
      const decision = yield* router.resolve(ProviderInstanceId.make("a"));

      expect(decision).toMatchObject({ _tag: "Switch", from: "a", to: "b" });
    }).pipe(
      Effect.provide(
        harness({
          settings: settingsWith({ a: { accountGroup: "max" }, b: { accountGroup: "max" } }),
          instances: [
            fakeInstance({ id: "a", usageLimits: sessionLimits(91, 20) }),
            fakeInstance({ id: "b", usageLimits: sessionLimits(4, 30) }),
          ],
        }),
      ),
    ),
  );

  it.effect("stays put while the current account is under threshold", () =>
    Effect.gen(function* () {
      const router = yield* ClaudeAccountRouter;
      const decision = yield* router.resolve(ProviderInstanceId.make("a"));

      expect(decision).toMatchObject({ _tag: "Stay", reason: "underThreshold" });
    }).pipe(
      Effect.provide(
        harness({
          settings: settingsWith({ a: { accountGroup: "max" }, b: { accountGroup: "max" } }),
          instances: [
            fakeInstance({ id: "a", usageLimits: sessionLimits(30, 20) }),
            fakeInstance({ id: "b", usageLimits: sessionLimits(4, 30) }),
          ],
        }),
      ),
    ),
  );

  // A routing layer must never be why a turn fails to run.
  it.effect("stays put when settings cannot be read", () =>
    Effect.gen(function* () {
      const router = yield* ClaudeAccountRouter;
      const decision = yield* router.resolve(ProviderInstanceId.make("a"));

      expect(decision).toMatchObject({ _tag: "Stay", instanceId: "a" });
    }).pipe(
      Effect.provide(
        Layer.provide(
          ClaudeAccountRouterLive,
          Layer.mergeAll(
            Layer.succeed(
              ServerSettingsService,
              ServerSettingsService.of({
                start: Effect.void,
                ready: Effect.void,
                getSettings: Effect.die(new Error("settings unavailable")),
                updateSettings: () => Effect.die(new Error("unused")),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.succeed(Stream.empty),
              }),
            ),
            Layer.succeed(
              ProviderInstanceRegistry,
              ProviderInstanceRegistry.of({
                getInstance: () => Effect.succeed(undefined),
                listInstances: Effect.succeed([]),
                listUnavailable: Effect.succeed([]),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.die(new Error("unused")),
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
