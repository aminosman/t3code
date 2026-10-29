import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import {
  claudeSupportsInteractiveAuth,
  makeClaudeAuth,
  parseClaudeAuthStatus,
} from "./ClaudeAuth.ts";

const decodeSettings = Schema.decodeSync(ClaudeSettings);

it("parses signed-out and account status without retaining unrelated CLI fields", () => {
  assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":false}'), { loggedIn: false });
  assert.deepEqual(
    parseClaudeAuthStatus(
      '{"loggedIn":true,"email":"sunday@example.com","subscriptionType":"max","authMethod":"claude.ai","apiProvider":"firstParty","accessToken":"not-retained"}',
    ),
    {
      loggedIn: true,
      email: "sunday@example.com",
      subscriptionType: "max",
      authMethod: "claude.ai",
      apiProvider: "firstParty",
    },
  );
  assert.isUndefined(parseClaudeAuthStatus("not json"));
});

it("offers subscription login despite an inherited key, but not for explicit custom instances", () => {
  assert.isTrue(claudeSupportsInteractiveAuth({ ANTHROPIC_API_KEY: "inherited" }, undefined));
  assert.isFalse(
    claudeSupportsInteractiveAuth({ ANTHROPIC_API_KEY: "configured" }, [
      { name: "ANTHROPIC_API_KEY", value: "configured", sensitive: true },
    ]),
  );
  assert.isFalse(
    claudeSupportsInteractiveAuth({ ANTHROPIC_BASE_URL: "https://example.com" }, undefined),
  );
});

const makeHarness = (input: {
  readonly name: string;
  readonly homePath: string;
  readonly initiallyLoggedIn?: boolean;
}) =>
  Effect.gen(function* () {
    let loggedIn = input.initiallyLoggedIn ?? false;
    let terminalSpawn: PtyAdapter.PtySpawnInput | undefined;
    let data: ((data: string) => void) | undefined;
    let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    let killed = false;
    const changed: boolean[] = [];
    const stopped: string[] = [];
    const written: string[] = [];
    const sizes: number[][] = [];
    const controller = yield* makeClaudeAuth({
      instanceId: ProviderInstanceId.make(input.name),
      displayName: input.name,
      enabled: true,
      config: decodeSettings({ binaryPath: "claude", homePath: input.homePath }),
      configDir: input.homePath,
      cwd: "/workspace",
      environment: { PATH: "/tools", ANTHROPIC_API_KEY: "inherited" },
      onChanged: (signedIn) =>
        Effect.sync(() => {
          changed.push(signedIn);
        }),
      probeStatus: Effect.sync(() => ({ loggedIn })),
      logoutCommand: Effect.sync(() => {
        loggedIn = false;
      }),
    }).pipe(
      Effect.provideService(PtyAdapter.PtyAdapter, {
        spawn: (spawnInput) =>
          Effect.sync(() => {
            terminalSpawn = spawnInput;
            return {
              pid: 123,
              write: (value) => {
                written.push(value);
              },
              resize: (cols, rows) => {
                sizes.push([cols, rows]);
              },
              kill: () => {
                killed = true;
              },
              onData: (callback) => {
                data = callback;
                return () => {
                  data = undefined;
                };
              },
              onExit: (callback) => {
                exit = callback;
                return () => {
                  exit = undefined;
                };
              },
            };
          }),
      }),
    );
    const state = (predicate: (state: ProviderAuthState) => boolean) =>
      controller
        .subscribe("owner")
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
    const phase = (phase: ProviderAuthState["phase"]) => state((value) => value.phase === phase);
    yield* state((value) => (value.methods?.length ?? 0) > 0);
    return {
      controller,
      changed,
      stopped,
      written,
      sizes,
      phase,
      state,
      terminalSpawn: () => terminalSpawn,
      data: (value: string) => data?.(value),
      exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
      killed: () => killed,
      setLoggedIn: (value: boolean) => {
        loggedIn = value;
      },
    };
  });

it.effect("uses each Claude instance's own configuration directory for terminal sign-in", () =>
  Effect.gen(function* () {
    for (const [name, homePath] of [
      ["Sunday", "/accounts/sunday"],
      ["Thursday", "/accounts/thursday"],
    ] as const) {
      const h = yield* makeHarness({ name, homePath });
      const stopSessions = Effect.sync(() => {
        h.stopped.push(name);
      });
      const flow = yield* h.controller.start("owner", stopSessions);
      yield* h.phase("waiting");
      assert.strictEqual(h.terminalSpawn()?.shell, "claude");
      assert.deepEqual(h.terminalSpawn()?.args, ["auth", "login", "--claudeai"]);
      assert.strictEqual(h.terminalSpawn()?.env.CLAUDE_CONFIG_DIR, homePath);
      assert.isFalse("ANTHROPIC_API_KEY" in h.terminalSpawn()!.env);
      assert.isFalse("ANTHROPIC_AUTH_TOKEN" in h.terminalSpawn()!.env);
      assert.deepEqual(h.controller.credentialBinding, {
        owner: "provider",
        key: `claude:${homePath}`,
      });
      assert.deepEqual(h.stopped, [name]);
      h.setLoggedIn(true);
      h.exit(0);
      yield* h.phase("succeeded");
      assert.strictEqual(flow.flowId !== null, true);
      assert.deepEqual(h.changed, [true]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("forwards terminal input and verifies the account after the CLI exits", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ name: "Sunday", homePath: "/accounts/sunday" });
    const flow = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    h.data("Open https://example.com/login\r\n");
    yield* h.state(
      (value) =>
        value.interaction?.type === "terminal" &&
        value.interaction.output.includes("https://example.com/login"),
    );
    yield* h.controller.respond!("owner", {
      instanceId: ProviderInstanceId.make("Sunday"),
      flowId: flow.flowId!,
      interactionId: "terminal",
      response: { type: "terminal", data: "code\r", size: { cols: 100, rows: 30 } },
    });
    assert.deepEqual(h.written, ["code\r"]);
    assert.deepEqual(h.sizes, [[100, 30]]);
    h.exit(0);
    const failed = yield* h.phase("failed");
    assert.strictEqual(failed.message, "Sunday is still signed out. Start sign-in again.");
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancels the login terminal without publishing a credential change", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ name: "Sunday", homePath: "/accounts/sunday" });
    const flow = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* h.controller.cancel("owner", flow.flowId!);
    assert.isTrue(h.killed());
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("stops affected sessions and refreshes the snapshot after logout", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      name: "Sunday",
      homePath: "/accounts/sunday",
      initiallyLoggedIn: true,
    });
    yield* h.controller.logout(
      Effect.sync(() => {
        h.stopped.push("sessions");
      }),
    );
    assert.deepEqual(h.stopped, ["sessions"]);
    assert.deepEqual(h.changed, [false]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
