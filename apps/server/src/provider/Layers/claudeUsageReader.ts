/**
 * ClaudeUsageReader — reads an account's rate-limit windows straight from
 * Anthropic's OAuth usage endpoint instead of waiting for the provider status
 * probe.
 *
 * The probe only runs while something is watching provider status, so a
 * router that reads the published snapshot decides on stale or absent data
 * most of the time. The usage endpoint needs only the account's access token,
 * costs no quota, and answers for an idle account too.
 *
 * Claude Code keeps that token in the login Keychain under a service name
 * derived from `CLAUDE_CONFIG_DIR` — `Claude Code-credentials` for a default
 * install and `Claude Code-credentials-<sha256(dir)[:8]>` otherwise. This is
 * undocumented; the hash was confirmed against two real config dirs.
 *
 * Reads are cached briefly per account so a busy thread does not hammer the
 * endpoint (it rate-limits), and the last good reading is kept so a transient
 * failure degrades to slightly stale data rather than none.
 *
 * @module provider/Layers/claudeUsageReader
 */
import * as NodeCrypto from "node:crypto";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import type { ClaudeUsageSeverity, ClaudeUsageWindow } from "./claudeAccountRouting.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_TIMEOUT_MS = 5_000;
const USAGE_TIMEOUT_MS = 10_000;
const KEYCHAIN_MAX_BYTES = 64 * 1024;
/** One read per account per minute is plenty; the windows move slowly. */
const FRESH_FOR = Duration.minutes(1);

export function claudeKeychainService(configDir: string | undefined): string {
  if (configDir === undefined || configDir.length === 0) return "Claude Code-credentials";
  const digest = NodeCrypto.createHash("sha256").update(configDir).digest("hex");
  return `Claude Code-credentials-${digest.slice(0, 8)}`;
}

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
export function usageLimitsToWindows(
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
     * Windows for the account logged into `configDir` (`undefined` = default
     * install). `undefined` when nothing could be read and nothing is cached.
     */
    readonly read: (
      configDir: string | undefined,
    ) => Effect.Effect<ReadonlyArray<ClaudeUsageWindow> | undefined>;
  }
>()("t3/provider/Layers/claudeUsageReader") {}

interface CacheEntry {
  readonly windows: ReadonlyArray<ClaudeUsageWindow>;
  readonly readAtMs: number;
}

const makeClaudeUsageReader = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const cache = yield* Ref.make(new Map<string, CacheEntry>());

  const readAccessToken = (service: string) =>
    Effect.gen(function* () {
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
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(KEYCHAIN_TIMEOUT_MS)),
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  const fetchWindows = (accessToken: string) =>
    Effect.gen(function* () {
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
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(USAGE_TIMEOUT_MS)),
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  const read = (configDir: string | undefined) =>
    Effect.gen(function* () {
      const key = configDir ?? "";
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(cache)).get(key);
      if (cached && nowMs - cached.readAtMs < Duration.toMillis(FRESH_FOR)) {
        return cached.windows;
      }
      // The Keychain lives on macOS only; elsewhere fall back to whatever the
      // router has from the status probe.
      if (platform !== "darwin") return cached?.windows;

      const token = yield* readAccessToken(claudeKeychainService(configDir));
      const windows = token === undefined ? undefined : yield* fetchWindows(token);
      if (windows === undefined) {
        yield* Effect.logDebug("claude usage read failed; serving last good reading", {
          configDir: key,
          hadToken: token !== undefined,
          cached: cached !== undefined,
        });
        return cached?.windows;
      }
      yield* Ref.update(cache, (map) => new Map(map).set(key, { windows, readAtMs: nowMs }));
      return windows;
    });

  return { read } as const;
});

export const ClaudeUsageReaderLive = Layer.effect(ClaudeUsageReader, makeClaudeUsageReader);

/** A reader that never answers, for harnesses without a Keychain. */
export const ClaudeUsageReaderNoopLayer = Layer.succeed(
  ClaudeUsageReader,
  ClaudeUsageReader.of({ read: () => Effect.succeed(undefined) }),
);
