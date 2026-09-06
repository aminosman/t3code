import {
  PUSH_DEVICE_REGISTER_PATH,
  PUSH_DEVICE_UNREGISTER_PATH,
  type PushDeviceRegistration,
  PushRegistrationResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Raised when a device cannot register for this environment's notifications.
 * Registration is best-effort from the client's point of view: failing to
 * register costs notifications, never the session.
 */
export class PushDeviceRegistrationError extends Data.TaggedError("PushDeviceRegistrationError")<{
  readonly message: string;
}> {}

const postToEnvironment = Effect.fn("clientRuntime.state.postPushDeviceRequest")(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly path: string;
  readonly body: unknown;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, input.path);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  ).pipe(Effect.mapError((cause) => new PushDeviceRegistrationError({ message: cause.message })));
  const client = yield* HttpClient.HttpClient;

  const response = yield* withEnvironmentCredentials(
    input.prepared.httpAuthorization,
    client.post(requestUrl, {
      headers: {
        ...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
        ...(headers.dpop === undefined ? {} : { dpop: headers.dpop }),
      },
      body: HttpBody.jsonUnsafe(input.body),
    }),
  ).pipe(
    Effect.timeout(REQUEST_TIMEOUT_MS),
    Effect.mapError(
      (cause) =>
        new PushDeviceRegistrationError({
          message: `Could not reach the environment to register for notifications: ${String(cause)}`,
        }),
    ),
  );

  if (response.status < 200 || response.status >= 300) {
    return yield* new PushDeviceRegistrationError({
      message: `Notification registration failed with status ${response.status}.`,
    });
  }

  return yield* HttpClientResponse.schemaBodyJson(PushRegistrationResult)(response).pipe(
    Effect.mapError(
      () =>
        new PushDeviceRegistrationError({
          message: "The environment returned an unexpected registration response.",
        }),
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
  readonly registration: PushDeviceRegistration;
}) =>
  postToEnvironment({
    prepared: input.prepared,
    signer: input.signer,
    path: PUSH_DEVICE_REGISTER_PATH,
    body: input.registration,
  });

export const unregisterEnvironmentPushDevice = (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly installationId: string;
}) =>
  postToEnvironment({
    prepared: input.prepared,
    signer: input.signer,
    path: PUSH_DEVICE_UNREGISTER_PATH,
    body: { installationId: input.installationId },
  });
