/**
 * Minimal APNs sender for environment-delivered notifications.
 *
 * APNs speaks HTTP/2 only, which Node's global fetch does not do, so this
 * uses `node:http2` directly. Provider tokens (a short-lived ES256 JWT signed
 * with the account's .p8) are reused until they age out — Apple rejects
 * tokens refreshed more often than once every 20 minutes.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** Apple rejects a provider token older than 1h; refresh well inside that. */
const PROVIDER_TOKEN_TTL_MS = 45 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  /** Contents of the .p8 auth key. */
  readonly privateKey: string;
  /** The app's bundle id, sent as the apns-topic. */
  readonly bundleId: string;
}

export interface ApnsNotification {
  readonly deviceToken: string;
  readonly production: boolean;
  readonly title: string;
  readonly body: string;
  /** Merged into the payload alongside `aps` for deep-linking. */
  readonly data: Record<string, string>;
  /** Coalesces updates about the same thread into one notification. */
  readonly collapseId?: string;
}

export class ApnsDeliveryError extends Schema.TaggedErrorClass<ApnsDeliveryError>()(
  "ApnsDeliveryError",
  {
    status: Schema.Number,
    reason: Schema.String,
    /** APNs asks senders to drop tokens it reports as gone. */
    tokenRejected: Schema.Boolean,
  },
) {
  override get message(): string {
    return `APNs rejected the notification (${this.status}: ${this.reason}).`;
  }
}

const base64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

/** Tokens APNs reports as permanently invalid, so the registry can prune. */
const TOKEN_REJECTION_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

export const signProviderToken = (credentials: ApnsCredentials, issuedAtMs: number): string => {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: credentials.keyId, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: credentials.teamId, iat: Math.floor(issuedAtMs / 1000) }),
  );
  const signer = NodeCrypto.createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer
    .sign({ key: credentials.privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
};

interface ApnsResponse {
  readonly status: number;
  readonly reason: string;
}

const postToApns = (input: {
  readonly host: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}): Promise<ApnsResponse> =>
  new Promise((resolve, reject) => {
    const session = NodeHttp2.connect(input.host);
    const settle = (outcome: () => void) => {
      session.close();
      outcome();
    };
    session.on("error", (cause) => settle(() => reject(cause)));

    const request = session.request({
      ":method": "POST",
      ":path": input.path,
      ...input.headers,
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.close();
      settle(() => reject(new Error("APNs request timed out.")));
    });

    let status = 0;
    let raw = "";
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("error", (cause) => settle(() => reject(cause)));
    request.on("end", () =>
      settle(() => {
        let reason = "";
        if (raw.length > 0) {
          try {
            reason = String((JSON.parse(raw) as { reason?: unknown }).reason ?? "");
          } catch {
            reason = raw.slice(0, 120);
          }
        }
        resolve({ status, reason });
      }),
    );
    request.end(input.body);
  });

export class ApnsClient extends Context.Service<
  ApnsClient,
  {
    readonly send: (
      credentials: ApnsCredentials,
      notification: ApnsNotification,
    ) => Effect.Effect<void, ApnsDeliveryError>;
  }
>()("t3/push/ApnsClient") {}

export const make = Effect.sync(() => {
  // Cached per key id: a rotated key must not reuse a stale token.
  const tokens = new Map<string, { readonly token: string; readonly issuedAt: number }>();

  const providerToken = (credentials: ApnsCredentials) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = tokens.get(credentials.keyId);
      if (cached && now - cached.issuedAt < PROVIDER_TOKEN_TTL_MS) {
        return cached.token;
      }
      const token = signProviderToken(credentials, now);
      tokens.set(credentials.keyId, { token, issuedAt: now });
      return token;
    });

  return ApnsClient.of({
    send: (credentials, notification) =>
      Effect.gen(function* () {
        const token = yield* providerToken(credentials);
        // The APNs payload shape is dictated by Apple's wire format, not by a
        // schema we own, so it is serialized directly.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const payload = JSON.stringify({
          aps: {
            alert: { title: notification.title, body: notification.body },
            sound: "default",
            "interruption-level": "active",
          },
          ...notification.data,
        });
        const response = yield* Effect.tryPromise({
          try: () =>
            postToApns({
              host: notification.production
                ? "https://api.push.apple.com"
                : "https://api.sandbox.push.apple.com",
              path: `/3/device/${notification.deviceToken}`,
              headers: {
                authorization: `bearer ${token}`,
                "apns-topic": credentials.bundleId,
                "apns-push-type": "alert",
                "apns-priority": "10",
                ...(notification.collapseId
                  ? { "apns-collapse-id": notification.collapseId }
                  : {}),
                "content-type": "application/json",
              },
              body: payload,
            }),
          catch: (cause) =>
            new ApnsDeliveryError({
              status: 0,
              reason: cause instanceof Error ? cause.message : "transport failure",
              tokenRejected: false,
            }),
        });
        if (response.status < 200 || response.status >= 300) {
          return yield* new ApnsDeliveryError({
            status: response.status,
            reason: response.reason || "unknown",
            tokenRejected: TOKEN_REJECTION_REASONS.has(response.reason),
          });
        }
      }),
  });
});

export const layer = Layer.effect(ApnsClient, make);
