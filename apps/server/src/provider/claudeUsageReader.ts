// Keychain slots derive from CLAUDE_CONFIG_DIR (SHA-256 prefix for custom dirs).
// Reads serve the last good reading and refresh in the background: routing runs
// under the thread's dispatch lock, which must never wait on Keychain or HTTPS.
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import type { ClaudeUsageSeverity, ClaudeUsageWindow } from "./claudeAccountRouting.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_TIMEOUT_MS = 5_000;
const USAGE_TIMEOUT_MS = 10_000;
const KEYCHAIN_MAX_BYTES = 64 * 1024;
/** One read per account per minute is plenty; the windows move slowly. */
const FRESH_FOR = Duration.minutes(1);

const claudeKeychainService = Effect.fn("claudeKeychainService")(function* (
  configDir: string | undefined,
) {
  if (configDir === undefined || configDir.length === 0) return "Claude Code-credentials";
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(configDir));
  return `Claude Code-credentials-${Hex.encode(digest).slice(0, 8)}`;
});

const KeychainCredentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.String,
      expiresAt: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeKeychainCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(KeychainCredentials),
);

const UsageLimit = Schema.Struct({
  kind: Schema.String,
  percent: Schema.Number,
  severity: Schema.optional(Schema.NullOr(Schema.String)),
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ display_name: Schema.optional(Schema.NullOr(Schema.String)) }),
          ),
        ),
      }),
    ),
  ),
});
const UsageResponse = Schema.Struct({
  limits: Schema.optional(Schema.NullOr(Schema.Array(UsageLimit))),
});
const decodeUsageResponse = Schema.decodeUnknownOption(UsageResponse);

function severityOf(raw: string | null | undefined): ClaudeUsageSeverity | undefined {
  switch (raw) {
    case "normal":
    case "warning":
    case "critical":
    case "blocked":
      return raw;
    default:
      return undefined;
  }
}

/** `limits[]` from the usage endpoint → the policy's window shape. */
function usageLimitsToWindows(
  limits: ReadonlyArray<typeof UsageLimit.Type>,
): ReadonlyArray<ClaudeUsageWindow> {
  const windows: ClaudeUsageWindow[] = [];
  for (const limit of limits) {
    const base = {
      usedPercent: Math.max(0, Math.min(100, limit.percent)),
      severity: severityOf(limit.severity),
      resetsAt: limit.resets_at ?? undefined,
    };
    switch (limit.kind) {
      case "session":
        windows.push({ kind: "session", ...base });
        break;
      case "weekly_all":
        windows.push({ kind: "weekly", ...base });
        break;
      case "weekly_scoped": {
        const model = limit.scope?.model?.display_name?.trim().toLowerCase();
        if (model) windows.push({ kind: "weeklyScoped", model, ...base });
        break;
      }
      default:
        break;
    }
  }
  return windows;
}

export class ClaudeUsageReader extends Context.Service<
  ClaudeUsageReader,
  {
    /**
     * The last good windows for the account logged into `configDir`
     * (`undefined` = default install), or `undefined` when none has been read.
     * Never waits: a stale entry starts one background refresh.
     */
    readonly read: (
      configDir: string | undefined,
    ) => Effect.Effect<ReadonlyArray<ClaudeUsageWindow> | undefined>;
  }
>()("t3/provider/claudeUsageReader") {}

interface CacheEntry {
  readonly windows: ReadonlyArray<ClaudeUsageWindow> | undefined;
  /** Failed attempts count too, so an unreachable endpoint is not retried per message. */
  readonly attemptedAtMs: number;
}

const makeClaudeUsageReader = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const cache = yield* Ref.make(new Map<string, CacheEntry>());
  const refreshing = new Set<string>();
  const scope = yield* Effect.scope;

  const readAccessToken = Effect.fn("ClaudeUsageReader.readAccessToken")(
    function* (service: string) {
      const child = yield* spawner.spawn(
        ChildProcess.make("security", ["find-generic-password", "-s", service, "-w"]),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: KEYCHAIN_MAX_BYTES }),
          child.exitCode,
          Stream.runDrain(child.stderr),
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0 || stdout.truncated) return undefined;
      const decoded = decodeKeychainCredentials(stdout.text.trim());
      return Option.isSome(decoded) ? decoded.value.claudeAiOauth?.accessToken : undefined;
    },
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(KEYCHAIN_TIMEOUT_MS)),
    Effect.map(Option.getOrUndefined),
    Effect.catchCause(() => Effect.as(Effect.void, undefined)),
  );

  const fetchWindows = Effect.fn("ClaudeUsageReader.fetchWindows")(
    function* (accessToken: string) {
      const request = HttpClientRequest.get(USAGE_URL).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          accept: "application/json",
        }),
      );
      const response = yield* httpClient.execute(request);
      if (response.status < 200 || response.status >= 300) return undefined;
      const body = yield* response.json;
      const decoded = decodeUsageResponse(body);
      if (Option.isNone(decoded)) return undefined;
      return usageLimitsToWindows(decoded.value.limits ?? []);
    },
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(USAGE_TIMEOUT_MS)),
    Effect.map(Option.getOrUndefined),
    Effect.catchCause(() => Effect.as(Effect.void, undefined)),
  );

  const refresh = Effect.fn("ClaudeUsageReader.refresh")(function* (configDir: string | undefined) {
    const key = configDir ?? "";
    const service = yield* claudeKeychainService(configDir).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.catchCause(() => Effect.as(Effect.void, undefined)),
    );
    const token = service === undefined ? undefined : yield* readAccessToken(service);
    const windows = token === undefined ? undefined : yield* fetchWindows(token);
    if (windows === undefined) {
      yield* Effect.logDebug("claude usage read failed; serving last good reading", {
        configDir: key,
        hadToken: token !== undefined,
      });
      return;
    }
    yield* Ref.update(cache, (map) => {
      const entry = map.get(key);
      return new Map(map).set(key, { windows, attemptedAtMs: entry?.attemptedAtMs ?? 0 });
    });
  });

  const read = Effect.fn("ClaudeUsageReader.read")(function* (configDir: string | undefined) {
    const key = configDir ?? "";
    const nowMs = yield* Clock.currentTimeMillis;
    const entry = (yield* Ref.get(cache)).get(key);
    // The Keychain lives on macOS only; elsewhere the router has the status probe.
    if (platform !== "darwin") return entry?.windows;
    if (entry !== undefined && nowMs - entry.attemptedAtMs < Duration.toMillis(FRESH_FOR)) {
      return entry.windows;
    }
    const start = yield* Effect.sync(() => {
      if (refreshing.has(key)) return false;
      refreshing.add(key);
      return true;
    });
    if (start) {
      yield* Ref.update(cache, (map) =>
        new Map(map).set(key, { windows: entry?.windows, attemptedAtMs: nowMs }),
      );
      yield* refresh(configDir).pipe(
        Effect.ensuring(Effect.sync(() => refreshing.delete(key))),
        Effect.forkIn(scope),
      );
    }
    return entry?.windows;
  });

  return { read } as const;
});

export const ClaudeUsageReaderLive = Layer.effect(ClaudeUsageReader, makeClaudeUsageReader);
