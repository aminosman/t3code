// Fake authorization servers answer with hand-built JSON bodies.
// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as McpConnectionOAuth from "./McpConnectionOAuth.ts";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A fake HTTP world: a map of URL to handler, recording every request. */
const fakeHttp = (
  routes: Readonly<Record<string, (request: SeenRequest) => Response>>,
  seen: Array<SeenRequest>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = request.url.split("?")[0]!;
        const entry: SeenRequest = {
          method: request.method,
          url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        };
        seen.push(entry);
        const handler = routes[url];
        return HttpClientResponse.fromWeb(
          request,
          handler === undefined ? new Response(null, { status: 404 }) : handler(entry),
        );
      }),
    ),
  );

const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

const AS_METADATA = {
  issuer: "https://auth.example.com/",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/oauth/token",
  registration_endpoint: "https://auth.example.com/oidc/register",
  revocation_endpoint: "https://auth.example.com/oauth/revoke",
  code_challenge_methods_supported: ["S256"],
};

describe("McpConnectionOAuth", () => {
  it.effect("discovers the authorization server through protected-resource metadata", () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = [];
      const discovery = yield* McpConnectionOAuth.discover("https://api.example.com/mcp").pipe(
        Effect.provide(
          fakeHttp(
            {
              "https://api.example.com/.well-known/oauth-protected-resource/mcp": () =>
                json({
                  resource: "https://api.example.com/mcp",
                  authorization_servers: ["https://auth.example.com/"],
                  scopes_supported: ["READ_CONTROLS", "offline_access"],
                }),
              "https://auth.example.com/.well-known/oauth-authorization-server": () =>
                json(AS_METADATA),
            },
            seen,
          ),
        ),
      );
      expect(discovery.resource).toBe("https://api.example.com/mcp");
      expect(discovery.authorizationServer.token_endpoint).toBe(
        "https://auth.example.com/oauth/token",
      );
      expect(discovery.scopesSupported).toEqual(["READ_CONTROLS", "offline_access"]);
      // The issuer has a trailing slash and no path, so its metadata lives at the root well-known.
      expect(seen.map((request) => request.url)).toContain(
        "https://auth.example.com/.well-known/oauth-authorization-server",
      );
    }),
  );

  it.effect("falls back to the WWW-Authenticate challenge when no well-known document exists", () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = [];
      const discovery = yield* McpConnectionOAuth.discover("https://mcp.example.com/mcp").pipe(
        Effect.provide(
          fakeHttp(
            {
              "https://mcp.example.com/mcp": () =>
                new Response(null, {
                  status: 401,
                  headers: {
                    "www-authenticate":
                      'Bearer resource_metadata="https://mcp.example.com/.well-known/custom-prm"',
                  },
                }),
              "https://mcp.example.com/.well-known/custom-prm": () =>
                json({
                  resource: "https://mcp.example.com/mcp",
                  authorization_servers: ["https://auth.example.com/"],
                }),
              "https://auth.example.com/.well-known/oauth-authorization-server": () =>
                json(AS_METADATA),
            },
            seen,
          ),
        ),
      );
      expect(discovery.resource).toBe("https://mcp.example.com/mcp");
      const probe = seen.find((request) => request.url === "https://mcp.example.com/mcp");
      expect(probe?.method).toBe("POST");
    }),
  );

  it.effect("fails with a readable reason when no authorization server metadata exists", () =>
    Effect.gen(function* () {
      const result = yield* McpConnectionOAuth.discover("https://plain.example.com/mcp").pipe(
        Effect.provide(fakeHttp({}, [])),
        Effect.flip,
      );
      expect(result.reason).toBe("discovery_failed");
      expect(result.detail).toContain("plain.example.com");
    }),
  );

  it.effect("registers a public client with the redirect URI it will use", () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = [];
      const registration = yield* McpConnectionOAuth.registerClient({
        metadata: AS_METADATA,
        redirectUri: "http://127.0.0.1:3773/oauth/mcp/callback",
      }).pipe(
        Effect.provide(
          fakeHttp(
            {
              "https://auth.example.com/oidc/register": () =>
                json({ client_id: "client-123" }, { status: 201 }),
            },
            seen,
          ),
        ),
      );
      expect(registration).toEqual({
        issuer: "https://auth.example.com/",
        redirectUri: "http://127.0.0.1:3773/oauth/mcp/callback",
        clientId: "client-123",
      });
      const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
      expect(body.redirect_uris).toEqual(["http://127.0.0.1:3773/oauth/mcp/callback"]);
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    }),
  );

  it.effect("names the missing client id when a server offers no registration", () =>
    Effect.gen(function* () {
      const { registration_endpoint: _omit, ...withoutRegistration } = AS_METADATA;
      const error = yield* McpConnectionOAuth.registerClient({
        metadata: withoutRegistration,
        redirectUri: "http://127.0.0.1:3773/oauth/mcp/callback",
      }).pipe(Effect.provide(fakeHttp({}, [])), Effect.flip);
      expect(error.reason).toBe("registration_failed");
      expect(error.detail).toContain("client id");
    }),
  );

  it("builds a PKCE authorization URL with the resource indicator", () => {
    const url = new URL(
      McpConnectionOAuth.buildAuthorizationUrl({
        metadata: AS_METADATA,
        clientId: "client-123",
        redirectUri: "http://127.0.0.1:3773/oauth/mcp/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
        resource: "https://api.example.com/mcp",
        scope: "READ_CONTROLS offline_access",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("resource")).toBe("https://api.example.com/mcp");
    expect(url.searchParams.get("scope")).toBe("READ_CONTROLS offline_access");
  });

  it.effect("makes a verifier whose SHA-256 is the challenge", () =>
    Effect.gen(function* () {
      const pkce = yield* McpConnectionOAuth.makePkce().pipe(Effect.provide(NodeServices.layer));
      const digest = yield* Effect.promise(() =>
        globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier)),
      );
      expect(Buffer.from(digest).toString("base64url")).toBe(pkce.challenge);
      expect(pkce.state.length).toBeGreaterThan(16);
    }),
  );

  it.effect("exchanges the code as a form post and reads the token lifetime", () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = [];
      const tokens = yield* McpConnectionOAuth.exchangeCode({
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "client-123",
        code: "code-1",
        redirectUri: "http://127.0.0.1:3773/oauth/mcp/callback",
        codeVerifier: "verifier-1",
        resource: "https://api.example.com/mcp",
      }).pipe(
        Effect.provide(
          fakeHttp(
            {
              "https://auth.example.com/oauth/token": () =>
                json({
                  access_token: "access-1",
                  refresh_token: "refresh-1",
                  expires_in: 900,
                  token_type: "Bearer",
                  scope: "READ_CONTROLS",
                }),
            },
            seen,
          ),
        ),
      );
      expect(tokens.accessToken).toBe("access-1");
      expect(tokens.refreshToken).toBe("refresh-1");
      expect(tokens.scope).toBe("READ_CONTROLS");
      // TestClock starts at zero, so the expiry is exactly the lifetime.
      expect(tokens.expiresAt).toBe(900_000);
      const form = new URLSearchParams(seen[0]!.body);
      expect(seen[0]!.headers["content-type"]).toContain("application/x-www-form-urlencoded");
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code_verifier")).toBe("verifier-1");
      expect(form.get("resource")).toBe("https://api.example.com/mcp");
      expect(form.get("client_id")).toBe("client-123");
    }),
  );

  it.effect("keeps the old refresh token when the server does not rotate it", () =>
    Effect.gen(function* () {
      const tokens = yield* McpConnectionOAuth.refreshTokens({
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "client-123",
        refreshToken: "refresh-1",
        resource: "https://api.example.com/mcp",
      }).pipe(
        Effect.provide(
          fakeHttp(
            {
              "https://auth.example.com/oauth/token": () =>
                json({ access_token: "access-2", expires_in: 900 }),
            },
            [],
          ),
        ),
      );
      expect(tokens.accessToken).toBe("access-2");
      expect(tokens.refreshToken).toBe("refresh-1");
    }),
  );

  it.effect("surfaces the server's error description when a refresh is rejected", () =>
    Effect.gen(function* () {
      const error = yield* McpConnectionOAuth.refreshTokens({
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "client-123",
        refreshToken: "refresh-1",
        resource: "https://api.example.com/mcp",
      }).pipe(
        Effect.provide(
          fakeHttp(
            {
              "https://auth.example.com/oauth/token": () =>
                json(
                  { error: "invalid_grant", error_description: "Refresh token revoked" },
                  { status: 400 },
                ),
            },
            [],
          ),
        ),
        Effect.flip,
      );
      expect(error.reason).toBe("refresh_failed");
      expect(error.detail).toContain("invalid_grant");
      expect(error.detail).toContain("Refresh token revoked");
    }),
  );
});
