// Request bodies here are OAuth wire shapes (JSON-RPC probe, RFC 7591
// registration) built once and sent, not data this server decodes.
// @effect-diagnostics preferSchemaOverJson:off
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { McpConnectionError } from "@t3tools/contracts";

import { initializeParams } from "./McpJsonRpc.ts";

/**
 * The client half of the MCP authorization spec, run by Roost's server so the
 * user signs in once in their own browser and no CLI ever holds the token:
 * protected-resource discovery, authorization-server metadata, dynamic client
 * registration, PKCE, the code exchange and refresh.
 */

const ProtectedResourceMetadata = Schema.Struct({
  resource: Schema.optionalKey(Schema.String),
  authorization_servers: Schema.optionalKey(Schema.Array(Schema.String)),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const AuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.optionalKey(Schema.String),
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
  revocation_endpoint: Schema.optionalKey(Schema.String),
  code_challenge_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AuthorizationServerMetadata = typeof AuthorizationServerMetadata.Type;

const ClientRegistrationResponse = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
});

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
});

const OAuthErrorResponse = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
});

const decodeProtectedResourceMetadata = Schema.decodeUnknownEffect(ProtectedResourceMetadata);
const decodeAuthorizationServerMetadata = Schema.decodeUnknownEffect(AuthorizationServerMetadata);
const decodeClientRegistrationResponse = Schema.decodeUnknownEffect(ClientRegistrationResponse);
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeOAuthErrorResponse = Schema.decodeUnknownOption(OAuthErrorResponse);

export interface OAuthDiscovery {
  /** The value for the `resource` parameter (RFC 8707): the MCP server URL. */
  readonly resource: string;
  readonly authorizationServer: AuthorizationServerMetadata;
  readonly scopesSupported: ReadonlyArray<string>;
}

export interface OAuthClientRegistration {
  readonly issuer: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret?: string;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch milliseconds; absent when the server gave no lifetime. */
  readonly expiresAt?: number;
  readonly scope?: string;
}

/** Access tokens this close to expiry are refreshed before use. */
export const OAUTH_REFRESH_EARLY_MS = 60_000;
/** Fallback lifetime for servers that return no `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;

const discoveryFailure = (detail: string) =>
  new McpConnectionError({ reason: "discovery_failed", detail });

const wellKnown = (base: string, suffix: string): ReadonlyArray<string> => {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/u, "");
  const candidates = [`${url.origin}/.well-known/${suffix}${path}`];
  if (path.length > 0) candidates.push(`${url.origin}/.well-known/${suffix}`);
  return candidates;
};

const fetchJson = Effect.fn("McpConnectionOAuth.fetchJson")(function* (url: string) {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient
    .get(url, { headers: { accept: "application/json" } })
    .pipe(Effect.mapError((cause) => discoveryFailure(`${url}: ${cause.message}`)));
  if (response.status !== 200) return undefined;
  return yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
});

/** The `resource_metadata` URL a 401 names, per the MCP authorization spec. */
const resourceMetadataFromChallenge = (wwwAuthenticate: string | undefined): string | undefined => {
  const match = wwwAuthenticate?.match(/resource_metadata="([^"]+)"/u);
  return match?.[1];
};

/**
 * Finds the authorization server for an MCP URL. The protected-resource
 * document is looked for at its well-known locations first, then via the
 * `WWW-Authenticate` challenge of an unauthenticated request; a server that
 * publishes neither is treated as its own authorization server.
 */
export const discover = Effect.fn("McpConnectionOAuth.discover")(function* (mcpUrl: string) {
  const httpClient = yield* HttpClient.HttpClient;
  let protectedResource: typeof ProtectedResourceMetadata.Type | undefined;
  for (const candidate of wellKnown(mcpUrl, "oauth-protected-resource")) {
    const json = yield* fetchJson(candidate);
    if (json === undefined) continue;
    const decoded = yield* decodeProtectedResourceMetadata(json).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (decoded?.authorization_servers?.length) {
      protectedResource = decoded;
      break;
    }
  }
  if (protectedResource === undefined) {
    const probe = yield* httpClient
      .execute(
        HttpClientRequest.post(mcpUrl).pipe(
          HttpClientRequest.setHeaders({ accept: "application/json, text/event-stream" }),
          HttpClientRequest.bodyUint8Array(
            new TextEncoder().encode(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: initializeParams,
              }),
            ),
            "application/json",
          ),
        ),
      )
      .pipe(Effect.mapError((cause) => discoveryFailure(`${mcpUrl}: ${cause.message}`)));
    const metadataUrl = resourceMetadataFromChallenge(probe.headers["www-authenticate"]);
    if (metadataUrl !== undefined) {
      const json = yield* fetchJson(metadataUrl);
      if (json !== undefined) {
        protectedResource = yield* decodeProtectedResourceMetadata(json).pipe(
          Effect.orElseSucceed(() => undefined),
        );
      }
    }
  }
  const issuer = protectedResource?.authorization_servers?.[0] ?? new URL(mcpUrl).origin;
  let authorizationServer: AuthorizationServerMetadata | undefined;
  for (const candidate of [
    ...wellKnown(issuer, "oauth-authorization-server"),
    ...wellKnown(issuer, "openid-configuration"),
  ]) {
    const json = yield* fetchJson(candidate);
    if (json === undefined) continue;
    authorizationServer = yield* decodeAuthorizationServerMetadata(json).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (authorizationServer !== undefined) break;
  }
  if (authorizationServer === undefined) {
    return yield* discoveryFailure(
      `No OAuth authorization server metadata was found for ${issuer}. The server may not support OAuth; try an API key instead.`,
    );
  }
  return {
    resource: protectedResource?.resource ?? mcpUrl,
    authorizationServer: { ...authorizationServer, issuer: authorizationServer.issuer ?? issuer },
    scopesSupported: protectedResource?.scopes_supported ?? [],
  } satisfies OAuthDiscovery;
});

/** Dynamic client registration (RFC 7591) as a public client. */
export const registerClient = Effect.fn("McpConnectionOAuth.registerClient")(function* (input: {
  readonly metadata: AuthorizationServerMetadata;
  readonly redirectUri: string;
}) {
  const endpoint = input.metadata.registration_endpoint;
  if (endpoint === undefined) {
    return yield* new McpConnectionError({
      reason: "registration_failed",
      detail:
        "This authorization server does not offer dynamic client registration. Enter the client id it issued you in the connection's advanced settings.",
    });
  }
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient
    .execute(
      HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.setHeaders({ accept: "application/json" }),
        HttpClientRequest.bodyUint8Array(
          new TextEncoder().encode(
            JSON.stringify({
              client_name: "Roost",
              redirect_uris: [input.redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          ),
          "application/json",
        ),
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new McpConnectionError({
            reason: "registration_failed",
            detail: `Client registration failed: ${cause.message}`,
          }),
      ),
    );
  const json = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
  if (response.status >= 400) {
    return yield* new McpConnectionError({
      reason: "registration_failed",
      detail: `Client registration was rejected (HTTP ${response.status})${oauthErrorDetail(json)}.`,
    });
  }
  const registration = yield* decodeClientRegistrationResponse(json).pipe(
    Effect.mapError(
      () =>
        new McpConnectionError({
          reason: "registration_failed",
          detail: "Client registration returned no client id.",
        }),
    ),
  );
  return {
    issuer: input.metadata.issuer ?? "",
    redirectUri: input.redirectUri,
    clientId: registration.client_id,
    ...(registration.client_secret === undefined
      ? {}
      : { clientSecret: registration.client_secret }),
  } satisfies OAuthClientRegistration;
});

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** A PKCE verifier/challenge pair and a state nonce. */
export const makePkce = Effect.fn("McpConnectionOAuth.makePkce")(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = base64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
  const challenge = base64Url(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie),
  );
  const state = base64Url(yield* crypto.randomBytes(24).pipe(Effect.orDie));
  return { verifier, challenge, state };
});

export const buildAuthorizationUrl = (input: {
  readonly metadata: AuthorizationServerMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scope?: string;
}): string => {
  const url = new URL(input.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (input.scope !== undefined && input.scope.length > 0)
    url.searchParams.set("scope", input.scope);
  return url.toString();
};

const oauthErrorDetail = (json: unknown): string => {
  const decoded = decodeOAuthErrorResponse(json);
  if (decoded._tag === "None") return "";
  const parts = [decoded.value.error, decoded.value.error_description].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length === 0 ? "" : `: ${parts.join(" - ")}`;
};

const tokenRequest = Effect.fn("McpConnectionOAuth.tokenRequest")(function* (input: {
  readonly tokenEndpoint: string;
  readonly form: Readonly<Record<string, string>>;
  readonly clientSecret?: string;
  readonly reason: "exchange_failed" | "refresh_failed";
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const now = yield* Clock.currentTimeMillis;
  const form = new URLSearchParams({
    ...input.form,
    ...(input.clientSecret === undefined ? {} : { client_secret: input.clientSecret }),
  });
  const response = yield* httpClient
    .execute(
      HttpClientRequest.post(input.tokenEndpoint).pipe(
        HttpClientRequest.setHeaders({ accept: "application/json" }),
        HttpClientRequest.bodyUint8Array(
          new TextEncoder().encode(form.toString()),
          "application/x-www-form-urlencoded",
        ),
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new McpConnectionError({
            reason: input.reason,
            detail: `The token request failed: ${cause.message}`,
          }),
      ),
    );
  const json = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
  if (response.status >= 400) {
    return yield* new McpConnectionError({
      reason: input.reason,
      detail: `The authorization server rejected the token request (HTTP ${response.status})${oauthErrorDetail(json)}.`,
    });
  }
  const token = yield* decodeTokenResponse(json).pipe(
    Effect.mapError(
      () =>
        new McpConnectionError({
          reason: input.reason,
          detail: "The authorization server returned no access token.",
        }),
    ),
  );
  const lifetimeMs =
    token.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_MS : token.expires_in * 1_000;
  return {
    accessToken: token.access_token,
    ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
    expiresAt: now + lifetimeMs,
    ...(token.scope === undefined ? {} : { scope: token.scope }),
  } satisfies OAuthTokens;
});

export const exchangeCode = (input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly resource: string;
}) =>
  tokenRequest({
    tokenEndpoint: input.tokenEndpoint,
    reason: "exchange_failed",
    ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
    form: {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
      resource: input.resource,
    },
  });

export const refreshTokens = (input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
  readonly resource: string;
}) =>
  tokenRequest({
    tokenEndpoint: input.tokenEndpoint,
    reason: "refresh_failed",
    ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
    form: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      resource: input.resource,
    },
  }).pipe(
    // Servers that do not rotate refresh tokens omit the field; keep the old one.
    Effect.map((tokens) =>
      tokens.refreshToken === undefined ? { ...tokens, refreshToken: input.refreshToken } : tokens,
    ),
  );

/** Best-effort token revocation on disconnect; failures are logged, never surfaced. */
export const revokeToken = Effect.fn("McpConnectionOAuth.revokeToken")(function* (input: {
  readonly revocationEndpoint: string;
  readonly token: string;
  readonly clientId: string;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  yield* httpClient
    .execute(
      HttpClientRequest.post(input.revocationEndpoint).pipe(
        HttpClientRequest.bodyUint8Array(
          new TextEncoder().encode(
            new URLSearchParams({ token: input.token, client_id: input.clientId }).toString(),
          ),
          "application/x-www-form-urlencoded",
        ),
      ),
    )
    .pipe(
      Effect.asVoid,
      Effect.catch((cause) => Effect.logDebug("MCP connection token revocation failed", { cause })),
    );
});
