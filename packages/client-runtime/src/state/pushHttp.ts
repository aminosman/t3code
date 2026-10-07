import {
  PUSH_DEVICE_REGISTER_PATH,
  PUSH_DEVICE_UNREGISTER_PATH,
  PUSH_REPLY_PATH,
  type PushDeviceRegistration,
  PushRegistrationResult,
  type PushReply,
  PushReplyResult,
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Raised when a device cannot register for this environment's notifications.
 * Registration is best-effort from the client's point of view: failing to
 * register costs notifications, never the session.
 */
export class PushDeviceRegistrationError extends Data.TaggedError("PushDeviceRegistrationError")<{
  readonly message: string;
  /** The environment's HTTP status; absent when it could not be reached. */
  readonly status?: number;
}> {}

const postToEnvironment = Effect.fn("clientRuntime.state.postPushDeviceRequest")(function* <
  A,
>(input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly path: string;
  readonly body: unknown;
  readonly result: Schema.Codec<A, unknown>;
}) {
  // The shared helper re-resolves the base URL on a DPoP retry, so the URL is
  // captured from the same callback it binds the request proof to.
  let requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, input.path);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: input.signer,
    // These are Roost's own routes, outside the contract's HttpApi groups, so
    // the typed group client the helper builds goes unused; the raw client
    // below posts to the path directly.
    group: "metadata",
    ...(input.remoteAuthorization === undefined
      ? {}
      : { remoteAuthorization: input.remoteAuthorization }),
    method: "POST",
    url: (httpBaseUrl) => {
      requestUrl = environmentEndpointUrl(httpBaseUrl, input.path);
      return requestUrl;
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ headers }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.post(requestUrl, {
          headers: {
            ...(headers.authorization === undefined
              ? {}
              : { authorization: headers.authorization }),
            ...(headers.dpop === undefined ? {} : { dpop: headers.dpop }),
          },
          body: HttpBody.jsonUnsafe(input.body),
        });
        // The shared helper fixes its own error channel, so a rejection is
        // carried out as a value and converted once the request settles.
        if (response.status < 200 || response.status >= 300) {
          // The reply route says why in words ("already answered"); keep them.
          const said = yield* response.json.pipe(
            Effect.map((body) =>
              typeof body === "object" && body !== null && "message" in body
                ? String(body.message)
                : null,
            ),
            Effect.orElseSucceed(() => null),
          );
          return {
            ok: false as const,
            status: response.status,
            message: said ?? `The environment answered with status ${response.status}.`,
          };
        }
        const decoded = yield* HttpClientResponse.schemaBodyJson(input.result)(response);
        return { ok: true as const, value: decoded };
      }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new PushDeviceRegistrationError({
          message: `Could not reach the environment: ${String(cause)}`,
        }),
    ),
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : new PushDeviceRegistrationError({ message: result.message, status: result.status }),
    ),
  );
});

/**
 * Tell an environment to notify this device. The environment delivers its own
 * notifications, so registration is scoped to the connection the device is
 * already paired with rather than to a cloud account.
 */
export const registerEnvironmentPushDevice = (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly registration: PushDeviceRegistration;
}) =>
  postToEnvironment({
    prepared: input.prepared,
    signer: input.signer,
    ...(input.remoteAuthorization === undefined
      ? {}
      : { remoteAuthorization: input.remoteAuthorization }),
    path: PUSH_DEVICE_REGISTER_PATH,
    body: input.registration,
    result: PushRegistrationResult,
  });

export const unregisterEnvironmentPushDevice = (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly installationId: string;
}) =>
  postToEnvironment({
    prepared: input.prepared,
    signer: input.signer,
    ...(input.remoteAuthorization === undefined
      ? {}
      : { remoteAuthorization: input.remoteAuthorization }),
    path: PUSH_DEVICE_UNREGISTER_PATH,
    body: { installationId: input.installationId },
    result: PushRegistrationResult,
  });

/**
 * Answers a thread from its notification: over plain HTTP, so it works from
 * a background launch before the app has a socket up.
 */
export const sendPushReply = (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly reply: PushReply;
}) =>
  postToEnvironment({
    prepared: input.prepared,
    signer: input.signer,
    path: PUSH_REPLY_PATH,
    body: input.reply,
    result: PushReplyResult,
  });
