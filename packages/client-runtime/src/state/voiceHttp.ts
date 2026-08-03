import {
  VOICE_REALTIME_SESSION_PATH,
  type VoiceRealtimeSessionErrorCode,
  VoiceRealtimeSessionErrorResponse,
  VoiceRealtimeSessionResponse,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const MINT_TIMEOUT_MS = 10_000;

const decodeErrorResponse = Schema.decodeUnknownOption(VoiceRealtimeSessionErrorResponse);

/**
 * Raised when the environment cannot mint a realtime voice session. `code`
 * distinguishes "the server has no API key" (actionable in settings) from
 * transport/upstream failures.
 */
export class VoiceRealtimeSessionMintError extends Data.TaggedError(
  "VoiceRealtimeSessionMintError",
)<{
  readonly code: VoiceRealtimeSessionErrorCode | "unavailable";
  readonly message: string;
}> {}

/**
 * Mint a short-lived OpenAI Realtime client secret from the environment so the
 * client can open a WebRTC voice session directly with OpenAI. Follows the
 * same auth contract as `fetchEnvironmentThreadSnapshot`: cookie for primary
 * connections, bearer for token connections, DPoP when a signer is provided.
 */
export const mintEnvironmentVoiceRealtimeSession = Effect.fn(
  "clientRuntime.state.mintEnvironmentVoiceRealtimeSession",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    VOICE_REALTIME_SESSION_PATH,
  );
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  ).pipe(
    Effect.mapError(
      (cause) => new VoiceRealtimeSessionMintError({ code: "unavailable", message: cause.message }),
    ),
  );
  const client = yield* HttpClient.HttpClient;

  const response = yield* withEnvironmentCredentials(
    input.prepared.httpAuthorization,
    client.post(requestUrl, {
      headers: {
        ...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
        ...(headers.dpop === undefined ? {} : { dpop: headers.dpop }),
      },
    }),
  ).pipe(
    Effect.timeout(MINT_TIMEOUT_MS),
    Effect.mapError(
      (cause) =>
        new VoiceRealtimeSessionMintError({
          code: "unavailable",
          message: `Could not reach the environment to start a voice session: ${String(cause)}`,
        }),
    ),
  );

  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
    const decoded = decodeErrorResponse(body);
    return yield* Option.isSome(decoded)
      ? new VoiceRealtimeSessionMintError({
          code: decoded.value.error,
          message: decoded.value.message,
        })
      : new VoiceRealtimeSessionMintError({
          code: "unavailable",
          message: `Voice session request failed with status ${response.status}.`,
        });
  }

  return yield* HttpClientResponse.schemaBodyJson(VoiceRealtimeSessionResponse)(response).pipe(
    Effect.mapError(
      () =>
        new VoiceRealtimeSessionMintError({
          code: "unavailable",
          message: "The environment returned an unexpected voice session response.",
        }),
    ),
  );
});
