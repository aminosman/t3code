// Fake OAuth and MCP servers answer with hand-built JSON bodies.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { McpConnectionId, ProjectId, type McpConnection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpConnectionService from "./McpConnectionService.ts";
import * as McpStdioHost from "./McpStdioHost.ts";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

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

const testLayer = (http: Layer.Layer<HttpClient.HttpClient>) =>
  McpConnectionService.layer.pipe(
    Layer.provideMerge(Layer.mock(McpStdioHost.McpStdioHost)({ stop: () => Effect.void })),
    Layer.provideMerge(ServerSettings.layerTest({})),
    Layer.provideMerge(
      ServerSecretStore.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-connections-" })),
      ),
    ),
    Layer.provideMerge(http),
    Layer.provideMerge(NodeServices.layer),
  );

const oneleet = McpConnectionId.make("oneleet");
const project = ProjectId.make("project-1");
const otherProject = ProjectId.make("project-2");

const oauthConnection: McpConnection = {
  name: "Oneleet",
  enabled: true,
  transport: { type: "http", url: "https://api.example.com/mcp", auth: "oauth" },
};

const AS_METADATA = {
  issuer: "https://auth.example.com/",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/oauth/token",
  registration_endpoint: "https://auth.example.com/oidc/register",
};

describe("McpConnectionService", () => {
  it.effect("refuses Roost's own server name", () =>
    Effect.gen(function* () {
      const service = yield* McpConnectionService.McpConnectionService;
      const error = yield* service
        .upsert(McpConnectionId.make("t3-code"), oauthConnection)
        .pipe(Effect.flip);
      expect(error.reason).toBe("reserved_id");
    }).pipe(Effect.provide(testLayer(fakeHttp({}, [])))),
  );

  it.effect(
    "moves sensitive stdio env values into the secret store and back out for spawning",
    () =>
      Effect.gen(function* () {
        const service = yield* McpConnectionService.McpConnectionService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const id = McpConnectionId.make("files");
        yield* service.upsert(id, {
          name: "Files",
          enabled: true,
          transport: {
            type: "stdio",
            command: "fs-server",
            args: ["--root", "/tmp"],
            env: [
              { name: "API_KEY", value: "super-secret", sensitive: true },
              { name: "LOG_LEVEL", value: "debug", sensitive: false },
            ],
          },
        });
        const stored = (yield* settings.getSettings).mcpConnections[id]!;
        expect(stored.transport.type === "stdio" && stored.transport.env).toEqual([
          { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
          { name: "LOG_LEVEL", value: "debug", sensitive: false },
        ]);
        const upstream = yield* service.resolveUpstream(id, null);
        expect(upstream.kind === "stdio" && upstream.spec.env.API_KEY).toBe("super-secret");
        expect(upstream.kind === "stdio" && upstream.spec.env.LOG_LEVEL).toBe("debug");
        // Sending the redaction marker back keeps the secret; an empty value drops it.
        yield* service.upsert(id, {
          ...stored,
          transport: {
            type: "stdio",
            command: "fs-server",
            args: [],
            env: [{ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }],
          },
        });
        const kept = yield* service.resolveUpstream(id, null);
        expect(kept.kind === "stdio" && kept.spec.env.API_KEY).toBe("super-secret");
        const statusesBefore = yield* service.statuses;
        expect(statusesBefore).toEqual([
          { connectionId: id, projectId: null, state: "not_required" },
        ]);
        yield* service.remove(id);
        expect((yield* settings.getSettings).mcpConnections[id]).toBeUndefined();
        const secretNames = yield* secrets.get(
          `mcp-connection-env-${Buffer.from("files").toString("base64url")}-${Buffer.from("API_KEY").toString("base64url")}`,
        );
        expect(Option.isNone(secretNames)).toBe(true);
      }).pipe(Effect.provide(testLayer(fakeHttp({}, [])))),
  );

  it.effect("keeps API keys per project and only hands connected projects the server", () =>
    Effect.gen(function* () {
      const service = yield* McpConnectionService.McpConnectionService;
      const id = McpConnectionId.make("posthog");
      yield* service.upsert(id, {
        name: "PostHog",
        enabled: true,
        transport: { type: "http", url: "https://mcp.example.com/mcp", auth: "bearer" },
      });
      expect(yield* service.serversForProject(project)).toEqual([]);
      yield* service.setBearerToken(id, project, "phx_key");
      expect(yield* service.serversForProject(project)).toEqual([
        { id, name: "PostHog", projectId: project, url: "https://mcp.example.com/mcp" },
      ]);
      expect(yield* service.serversForProject(otherProject)).toEqual([]);
      const upstream = yield* service.resolveUpstream(id, project);
      expect(upstream).toEqual({
        kind: "http",
        url: "https://mcp.example.com/mcp",
        authorization: "Bearer phx_key",
      });
      const missing = yield* service.resolveUpstream(id, otherProject).pipe(Effect.flip);
      expect(missing.reason).toBe("needs_sign_in");
      expect(yield* service.statuses).toEqual([
        { connectionId: id, projectId: project, state: "connected" },
      ]);
      yield* service.disconnect(id, project);
      expect(yield* service.statuses).toEqual([]);
    }).pipe(Effect.provide(testLayer(fakeHttp({}, [])))),
  );

  const oauthSeen: Array<SeenRequest> = [];
  let tokenCalls = 0;
  const oauthHttp = fakeHttp(
    {
      "https://api.example.com/.well-known/oauth-protected-resource/mcp": () =>
        json({
          resource: "https://api.example.com/mcp",
          authorization_servers: ["https://auth.example.com/"],
          scopes_supported: ["READ_CONTROLS", "offline_access"],
        }),
      "https://auth.example.com/.well-known/oauth-authorization-server": () => json(AS_METADATA),
      "https://auth.example.com/oidc/register": () => json({ client_id: "client-123" }),
      "https://auth.example.com/oauth/token": (request) => {
        tokenCalls += 1;
        const form = new URLSearchParams(request.body);
        return json({
          access_token: form.get("grant_type") === "refresh_token" ? "access-2" : "access-1",
          refresh_token: "refresh-1",
          // Under the refresh-early window, so the next use refreshes.
          expires_in: 30,
        });
      },
    },
    oauthSeen,
  );

  it.effect(
    "signs a project in with OAuth, refreshes before expiry, and reports status changes",
    () =>
      Effect.gen(function* () {
        const seen = oauthSeen;
        yield* Effect.gen(function* () {
          const service = yield* McpConnectionService.McpConnectionService;
          const statuses: Array<ReadonlyArray<{ readonly state: string }>> = [];
          yield* service.subscribeStatuses.pipe(
            Stream.takeUntil((current) => current.some((status) => status.state === "connected")),
            Stream.runForEach((current) => Effect.sync(() => statuses.push(current))),
            Effect.forkScoped,
          );
          yield* service.upsert(oneleet, oauthConnection);
          const started = yield* service.startOAuth({
            id: oneleet,
            projectId: project,
            callbackOrigin: "http://127.0.0.1:3773/ignored/path",
            returnUrl: "http://127.0.0.1:3773/settings/mcp",
          });
          const authorizationUrl = new URL(started.authorizationUrl);
          expect(authorizationUrl.searchParams.get("client_id")).toBe("client-123");
          expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
            "http://127.0.0.1:3773/oauth/mcp/callback",
          );
          expect(authorizationUrl.searchParams.get("scope")).toBe("READ_CONTROLS offline_access");
          const state = authorizationUrl.searchParams.get("state")!;

          const completed = yield* service.completeOAuth(
            new URL(`http://127.0.0.1:3773/oauth/mcp/callback?code=code-1&state=${state}`),
          );
          expect(completed).toEqual({
            connectionId: oneleet,
            name: "Oneleet",
            returnUrl: "http://127.0.0.1:3773/settings/mcp",
          });
          // A second use of the same state is refused.
          const replay = yield* service
            .completeOAuth(
              new URL(`http://127.0.0.1:3773/oauth/mcp/callback?code=code-1&state=${state}`),
            )
            .pipe(Effect.flip);
          expect(replay.reason).toBe("exchange_failed");

          expect(yield* service.serversForProject(project)).toEqual([
            {
              id: oneleet,
              name: "Oneleet",
              projectId: project,
              url: "https://api.example.com/mcp",
            },
          ]);
          // The 30 s token is already inside the refresh-early window.
          const upstream = yield* service.resolveUpstream(oneleet, project);
          expect(upstream).toMatchObject({ kind: "http", authorization: "Bearer access-2" });
          expect(tokenCalls).toBe(2);
          const refreshForm = new URLSearchParams(seen.at(-1)!.body);
          expect(refreshForm.get("grant_type")).toBe("refresh_token");
          expect(refreshForm.get("resource")).toBe("https://api.example.com/mcp");

          // The client registration is reused for the same redirect URI.
          yield* service.startOAuth({
            id: oneleet,
            projectId: otherProject,
            callbackOrigin: "http://127.0.0.1:3773",
          });
          expect(
            seen.filter((request) => request.url === "https://auth.example.com/oidc/register"),
          ).toHaveLength(1);

          // The subscription opens with the empty list and ends on the sign-in;
          // how many empty re-publishes land in between depends on timing.
          const states = statuses.map((list) => list.map((status) => status.state));
          expect(states[0]).toEqual([]);
          expect(states.at(-1)).toEqual(["connected"]);
        }).pipe(Effect.scoped);
      }).pipe(Effect.provide(testLayer(oauthHttp))),
  );
});
