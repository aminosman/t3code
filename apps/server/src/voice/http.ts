/**
 * Voice oracle HTTP route.
 *
 * Mints short-lived OpenAI Realtime client secrets so browser clients can
 * open a WebRTC speech session directly with OpenAI. The long-lived API key
 * stays server-side (settings secret store or OPENAI_API_KEY); audio never
 * flows through the T3 server.
 */
import {
  AuthOrchestrationOperateScope,
  DEFAULT_VOICE_REALTIME_MODEL,
  DEFAULT_VOICE_REALTIME_VOICE,
  VOICE_REALTIME_SESSION_PATH,
  type VoiceRealtimeSessionErrorResponse,
  type VoiceRealtimeSessionResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import * as ServerSettings from "../serverSettings.ts";

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

const OpenAiClientSecretResponse = Schema.Struct({
  value: Schema.String,
  expires_at: Schema.optionalKey(Schema.Number),
});

const voiceErrorResponse = (status: number, body: VoiceRealtimeSessionErrorResponse) =>
  HttpServerResponse.jsonUnsafe(body, { status });

/** Best-effort extraction of the upstream HTTP status from a client error. */
const upstreamResponseStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) return null;
  const reason = (error as { reason?: { response?: { status?: unknown } } }).reason;
  const status = reason?.response?.status;
  return typeof status === "number" ? status : null;
};

export const voiceRealtimeSessionRouteLayer = HttpRouter.add(
  "POST",
  VOICE_REALTIME_SESSION_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;

    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchTag("ServerSettingsError", (cause) =>
        Effect.logWarning("voice: failed to read settings", { cause }).pipe(Effect.as(undefined)),
      ),
    );
    const apiKey = settings?.voice.openaiApiKey || process.env.OPENAI_API_KEY || "";
    if (apiKey.length === 0) {
      return voiceErrorResponse(412, {
        error: "not-configured",
        message:
          "No OpenAI API key configured. Add one in Settings → Voice (or set OPENAI_API_KEY on the server).",
      });
    }

    const model = settings?.voice.model || DEFAULT_VOICE_REALTIME_MODEL;
    const voice = settings?.voice.voice || DEFAULT_VOICE_REALTIME_VOICE;

    return yield* httpClient
      .post(OPENAI_CLIENT_SECRETS_URL, {
        headers: { authorization: `Bearer ${apiKey}` },
        body: HttpBody.jsonUnsafe({
          session: {
            type: "realtime",
            model,
            audio: { output: { voice } },
          },
        }),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenAiClientSecretResponse)),
        Effect.map((secret) =>
          HttpServerResponse.jsonUnsafe({
            clientSecret: secret.value,
            expiresAt: secret.expires_at ?? null,
            model,
            voice,
          } satisfies VoiceRealtimeSessionResponse),
        ),
        Effect.tapError((cause) =>
          Effect.logWarning("voice: failed to mint realtime client secret", {
            upstreamStatus: upstreamResponseStatus(cause),
            cause,
          }),
        ),
        Effect.catch((cause) => {
          const status = upstreamResponseStatus(cause);
          return Effect.succeed(
            voiceErrorResponse(502, {
              error: "upstream-error",
              message:
                status === 401 || status === 403
                  ? "OpenAI rejected the API key. It may have been rotated or revoked — re-enter it in Settings → Voice."
                  : status === 404
                    ? "OpenAI does not recognize the configured realtime model. Clear the model in Settings → Voice to use the default."
                    : "OpenAI rejected the realtime session request. Check the API key and model.",
            }),
          );
        }),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
