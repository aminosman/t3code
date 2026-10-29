import {
  ProviderSetupError,
  type ClaudeSettings,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import {
  AUTH_PROBE_TIMEOUT_MS,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

export interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  readonly email?: string;
  readonly subscriptionType?: string;
  readonly authMethod?: string;
  readonly apiProvider?: string;
}

const optionalStatusString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** Parse only account metadata. The CLI's JSON never belongs in an error message. */
export const parseClaudeAuthStatus = (stdout: string): ClaudeAuthStatus | undefined => {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || !("loggedIn" in value)) return undefined;
    const loggedIn = value.loggedIn;
    if (typeof loggedIn !== "boolean") return undefined;
    const email = "email" in value ? optionalStatusString(value.email) : undefined;
    const subscriptionType =
      "subscriptionType" in value ? optionalStatusString(value.subscriptionType) : undefined;
    const authMethod = "authMethod" in value ? optionalStatusString(value.authMethod) : undefined;
    const apiProvider =
      "apiProvider" in value ? optionalStatusString(value.apiProvider) : undefined;
    return {
      loggedIn,
      ...(email ? { email } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(authMethod ? { authMethod } : {}),
      ...(apiProvider ? { apiProvider } : {}),
    };
  } catch {
    return undefined;
  }
};

export const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
    ...(cwd ? { cwd } : {}),
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

const withoutInheritedApiKeys = (environment: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => {
  const {
    ANTHROPIC_API_KEY: _apiKey,
    ANTHROPIC_AUTH_TOKEN: _authToken,
    ...withoutKeys
  } = environment ?? {};
  return withoutKeys;
};

/** Undefined means the CLI could not answer; an explicit false is signed out. */
export const probeClaudeAuthStatus = Effect.fn("probeClaudeAuthStatus")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  options?: { readonly subscription?: boolean; readonly cwd?: string | undefined },
) {
  // An inherited key otherwise masks the subscription account's logged-out state.
  // Explicit custom/API-key instances do not use this subscription-only probe.
  const probeEnvironment = options?.subscription
    ? withoutInheritedApiKeys(environment)
    : environment;
  const result = yield* runClaudeCommand(
    claudeSettings,
    ["auth", "status", "--json"],
    probeEnvironment,
    options?.cwd,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(result) || Option.isNone(result.success)) return undefined;
  // Claude exits 1 when signed out but still emits authoritative JSON.
  return parseClaudeAuthStatus(result.success.value.stdout);
});

/** Subscription login must not replace the credentials of a custom/API-key instance. */
export const claudeSupportsInteractiveAuth = (
  environment: NodeJS.ProcessEnv,
  overrides: ProviderInstanceEnvironment | undefined,
): boolean => {
  const explicit = new Set(overrides?.map((variable) => variable.name));
  if (explicit.has("ANTHROPIC_API_KEY") || explicit.has("ANTHROPIC_AUTH_TOKEN")) return false;
  return [
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].every((name) => !environment[name]?.trim());
};

export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly config: ClaudeSettings;
  readonly configDir: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
  readonly probeStatus?: Effect.Effect<ClaudeAuthStatus | undefined>;
  readonly logoutCommand?: Effect.Effect<void, ProviderSetupError>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authEnvironment = withoutInheritedApiKeys(options.environment);
  const claudeEnvironment = yield* makeClaudeEnvironment(options.config, authEnvironment);
  const failure = (operation: "start" | "logout" | "respond", detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const probeStatus =
    options.probeStatus ??
    probeClaudeAuthStatus(options.config, authEnvironment, {
      subscription: true,
      cwd: options.cwd,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const runLoginTerminal = Effect.fnUntraced(function* (
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty))
      return yield* failure(
        "start",
        "Interactive Claude sign-in is unavailable on this environment.",
      );
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      options.config.binaryPath,
      claudeEnvironment,
    );
    const isJavaScript = /\.(?:[cm]?js)$/i.test(executablePath);
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const loginProcess = yield* pty.value
      .spawn({
        shell: isJavaScript ? process.execPath : executablePath,
        args: [...(isJavaScript ? [executablePath] : []), "auth", "login", "--claudeai"],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: claudeEnvironment,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", `Could not open sign-in for ${options.displayName}.`, cause),
        ),
      );
    const detachData = loginProcess.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = loginProcess.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          loginProcess.kill();
        } catch {
          // The login process may already have exited.
        }
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) loginProcess.resize(response.size.cols, response.size.rows);
                  if (response.data) loginProcess.write(response.data);
                },
                catch: () =>
                  failure("respond", "The Claude sign-in terminal is no longer available."),
              })
            : Effect.void,
      );
    yield* update();
    const outputFiber = yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    const exitCode = yield* Deferred.await(exited);
    yield* Fiber.interrupt(outputFiber);
    if (exitCode !== 0)
      return yield* failure("start", "Claude sign-in did not finish successfully.");
  });

  const logoutCommand =
    options.logoutCommand ??
    Effect.gen(function* () {
      const result = yield* runClaudeCommand(
        options.config,
        ["auth", "logout"],
        authEnvironment,
        options.cwd,
      ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
      if (Result.isFailure(result))
        return yield* failure("logout", "Could not sign out of Claude. Try again.", result.failure);
      if (Option.isNone(result.success))
        return yield* failure("logout", "Claude did not finish signing out in time.");
      if (result.success.value.code !== 0)
        return yield* failure("logout", "Claude did not finish signing out successfully.");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:${options.configDir}` },
    methods: Effect.succeed([
      {
        id: "claudeai",
        name: "Sign in with Claude",
        description: `Use the Claude account for ${options.displayName}.`,
        type: "terminal",
      },
    ]),
    authenticate: Effect.fn("ClaudeAuth.authenticate")(function* (_methodId, context) {
      if (!options.enabled)
        return yield* failure("start", `Enable ${options.displayName} before signing in.`);
      yield* runLoginTerminal(context).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* context.verifying;
      const status = yield* probeStatus;
      if (status?.loggedIn !== true)
        return yield* failure(
          "start",
          `${options.displayName} is still signed out. Start sign-in again.`,
        );
      yield* options.onChanged(true);
    }),
    logout: Effect.gen(function* () {
      yield* logoutCommand;
      yield* options.onChanged(false);
      return `Signed out of ${options.displayName}.`;
    }),
  });
});
