// The fake upstream and the assertions trade opaque JSON-RPC bodies.
// @effect-diagnostics preferSchemaOverJson:off
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { McpConnectionId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NetAddress from "effect/unstable/net/NetAddress";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpProviderSession from "../McpProviderSession.ts";
import * as McpSessionRegistry from "../McpSessionRegistry.ts";
import * as McpConnectionProxy from "./McpConnectionProxy.ts";
import * as McpConnectionService from "./McpConnectionService.ts";
import * as McpStdioHost from "./McpStdioHost.ts";

const threadId = ThreadId.make("thread-proxy");
const project = ProjectId.make("project-proxy");
const oneleet = McpConnectionId.make("oneleet");

interface UpstreamCall {
  readonly authorization: string | undefined;
  readonly sessionId: string | undefined;
  readonly body: string;
}

/** A fake upstream MCP server on the same test listener: records calls, answers with SSE. */
const makeUpstreamRoute = (calls: Array<UpstreamCall>, acceptedKey: string) =>
  HttpRouter.add(
    "POST",
    "/upstream/mcp",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.text;
      calls.push({
        authorization: request.headers.authorization,
        sessionId: request.headers["mcp-session-id"],
        body,
      });
      if (request.headers.authorization !== `Bearer ${acceptedKey}`) {
        return HttpServerResponse.empty({ status: 401, headers: { "www-authenticate": "Bearer" } });
      }
      const parsed = JSON.parse(body) as { readonly id?: unknown; readonly method?: string };
      if (parsed.id === undefined) return HttpServerResponse.empty({ status: 202 });
      const result =
        parsed.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "upstream" } }
          : { tools: [{ name: "list_controls" }] };
      const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result })}\n\n`;
      return HttpServerResponse.stream(Stream.make(new TextEncoder().encode(event)), {
        contentType: "text/event-stream",
        headers: { "mcp-session-id": "upstream-session-1" },
      });
    }),
  );

const serve = (calls: Array<UpstreamCall>, acceptedKey: string) =>
  HttpRouter.serve(
    Layer.mergeAll(
      McpConnectionProxy.mcpConnectionProxyRouteLayer,
      McpConnectionProxy.mcpConnectionCallbackRouteLayer,
      makeUpstreamRoute(calls, acceptedKey),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(McpConnectionService.layer),
    Layer.provideMerge(McpStdioHost.layer),
    Layer.provideMerge(McpSessionRegistry.layer),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed("environment-proxy" as never),
      }),
    ),
    Layer.provideMerge(ServerSettings.layerTest({})),
    Layer.provideMerge(
      ServerSecretStore.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-proxy-" })),
      ),
    ),
    // The proxy and the service call absolute upstream URLs with the real
    // fetch client; the test's own client (from the listener) stays relative.
    Layer.provide(FetchHttpClient.layer),
  );

const listenerOrigin = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address;
  if (!NetAddress.isInetAddress(address)) throw new Error("expected an inet address");
  return `http://127.0.0.1:${address.port}`;
});

describe("McpConnectionProxy", () => {
  it.effect("forwards an agent's request with the project's key and streams the answer back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<UpstreamCall> = [];
        const built = yield* serve(calls, "upstream-key").pipe(Layer.build);
        const origin = yield* listenerOrigin;
        const connections = Context.get(built, McpConnectionService.McpConnectionService);
        yield* connections.upsert(oneleet, {
          name: "Oneleet",
          enabled: true,
          transport: { type: "http", url: `${origin}/upstream/mcp`, auth: "bearer" },
        });
        yield* connections.setBearerToken(oneleet, project, "upstream-key");

        const registry = Context.get(built, McpSessionRegistry.McpSessionRegistry);
        const credential = yield* registry.issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        McpProviderSession.setMcpProviderSession({
          ...credential.config,
          connections: [
            {
              id: oneleet,
              name: "Oneleet",
              projectId: project,
              endpoint: McpProviderSession.mcpConnectionEndpoint(
                credential.config.endpoint,
                oneleet,
              ),
            },
          ],
        });
        const httpClient = yield* HttpClient.HttpClient;
        const response = yield* httpClient.post("/mcp/connections/oneleet", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: credential.config.authorizationHeader,
            "mcp-session-id": "agent-session-9",
          },
          body: HttpBody.text(
            '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
            "application/json",
          ),
        });
        const text = yield* response.text;
        expect(response.status, text).toBe(200);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        expect(response.headers["mcp-session-id"]).toBe("upstream-session-1");
        expect(response.headers["cache-control"]).toContain("no-transform");
        expect(text).toContain('"list_controls"');
        // The agent's bearer never reached the upstream; the project's key did.
        expect(calls).toHaveLength(1);
        expect(calls[0]!.authorization).toBe("Bearer upstream-key");
        expect(calls[0]!.sessionId).toBe("agent-session-9");

        // A bearer the registry does not know is refused before any upstream call.
        const rejected = yield* httpClient.post("/mcp/connections/oneleet", {
          headers: { accept: "application/json", authorization: "Bearer nope" },
          body: HttpBody.text('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', "application/json"),
        });
        expect(rejected.status).toBe(401);
        expect(calls).toHaveLength(1);

        // A connection the thread was not given is not found, even with a valid bearer.
        const missing = yield* httpClient.post("/mcp/connections/posthog", {
          headers: {
            accept: "application/json",
            authorization: credential.config.authorizationHeader,
          },
          body: HttpBody.text('{"jsonrpc":"2.0","id":3,"method":"tools/list"}', "application/json"),
        });
        expect(missing.status).toBe(404);
        McpProviderSession.clearMcpProviderSession(threadId);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-proxy-outer-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
  );

  it.effect("tells the agent to sign in when the upstream rejects a static key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<UpstreamCall> = [];
        const built = yield* serve(calls, "the-real-key").pipe(Layer.build);
        const origin = yield* listenerOrigin;
        const connections = Context.get(built, McpConnectionService.McpConnectionService);
        yield* connections.upsert(oneleet, {
          name: "Oneleet",
          enabled: true,
          transport: { type: "http", url: `${origin}/upstream/mcp`, auth: "bearer" },
        });
        yield* connections.setBearerToken(oneleet, project, "revoked-key");
        const registry = Context.get(built, McpSessionRegistry.McpSessionRegistry);
        const credential = yield* registry.issue({
          threadId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        });
        McpProviderSession.setMcpProviderSession({
          ...credential.config,
          connections: [
            {
              id: oneleet,
              name: "Oneleet",
              projectId: project,
              endpoint: McpProviderSession.mcpConnectionEndpoint(
                credential.config.endpoint,
                oneleet,
              ),
            },
          ],
        });
        const httpClient = yield* HttpClient.HttpClient;
        const response = yield* httpClient.post("/mcp/connections/oneleet", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: credential.config.authorizationHeader,
          },
          body: HttpBody.text('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', "application/json"),
        });
        expect(response.status).toBe(401);
        const text = yield* response.text;
        expect(text).toContain("mcp_connection_needs_sign_in");
        expect(text).toContain("Oneleet");
        expect(calls).toHaveLength(1);
        McpProviderSession.clearMcpProviderSession(threadId);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-proxy-outer-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
  );

  it.effect("answers the OAuth callback page for an unknown state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serve([], "unused").pipe(Layer.build);
        const httpClient = yield* HttpClient.HttpClient;
        const response = yield* httpClient.get("/oauth/mcp/callback?code=x&state=unknown");
        expect(response.status).toBe(400);
        expect(response.headers["content-type"]).toContain("text/html");
        expect(yield* response.text).toContain("Sign-in couldn");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-proxy-outer-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
  );
});
