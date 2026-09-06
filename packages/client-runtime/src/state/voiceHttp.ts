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

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

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
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}) {
  // Re-derived per attempt: the shared helper can change the base URL when it
  // refreshes a rejected relay credential.
  let requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, VOICE_REALTIME_SESSION_PATH);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: input.signer,
    ...(input.remoteAuthorization === undefined
      ? {}
      : { remoteAuthorization: input.remoteAuthorization }),
    method: "POST",
    url: (httpBaseUrl) => {
      requestUrl = environmentEndpointUrl(httpBaseUrl, VOICE_REALTIME_SESSION_PATH);
      return requestUrl;
    },
    timeoutMs: MINT_TIMEOUT_MS,
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
        });
        // The shared helper fixes its own error channel, so the mint failure is
        // carried out as a value and converted once the request settles.
        if (response.status < 200 || response.status >= 300) {
          const rawBody = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
          const decoded = decodeErrorResponse(rawBody);
          return Option.isSome(decoded)
            ? {
                ok: false as const,
                code: decoded.value.error,
                message: decoded.value.message,
              }
            : {
                ok: false as const,
                code: "unavailable" as const,
                message: `Voice session request failed with status ${response.status}.`,
              };
        }
        const session = yield* HttpClientResponse.schemaBodyJson(VoiceRealtimeSessionResponse)(
          response,
        );
        return { ok: true as const, value: session };
      }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new VoiceRealtimeSessionMintError({
          code: "unavailable",
          message: `Could not reach the environment to start a voice session: ${String(cause)}`,
        }),
    ),
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : new VoiceRealtimeSessionMintError({ code: result.code, message: result.message }),
    ),
  );
});
