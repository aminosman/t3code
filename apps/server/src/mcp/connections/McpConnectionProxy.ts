// The stdio fallback body is a one-line error envelope, not data this server decodes.
// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { McpConnectionId } from "@t3tools/contracts";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../McpSessionRegistry.ts";
import { mcpConnectionCallbackResponse } from "./McpConnectionCallbackPage.ts";
import { MCP_OAUTH_CALLBACK_PATH, McpConnectionService } from "./McpConnectionService.ts";
import * as McpStdioHost from "./McpStdioHost.ts";

// Proxy MCP credentials server-side so agents never receive upstream secrets.

const MCP_CONNECTIONS_ROUTE = "/mcp/connections/:id";

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;

/**
 * Who is calling, for the upstream: the bearer's thread (a native subagent names its
 * parent), its project, this environment. Never taken from the agent's headers.
 */
const callerHeaders = (input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectId: string;
}): Record<string, string> => ({
  "x-t3-environment-id": input.environmentId,
  "x-t3-thread-id": input.threadId,
  "x-t3-project-id": input.projectId,
});

const pick = (
  headers: Readonly<Record<string, string | undefined>>,
  names: ReadonlyArray<string>,
): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = headers[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
};

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
);

const needsSignIn = (name: string, detail: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "mcp_connection_needs_sign_in",
      message: `The "${name}" MCP connection needs a sign-in for this project in Roost Settings > MCP connections. ${detail}`,
    },
    { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
  );

const isMcpConnectionId = Schema.is(McpConnectionId);

const bearerFrom = (authorization: string | undefined) =>
  authorization?.startsWith("Bearer ") === true ? authorization.slice("Bearer ".length).trim() : "";

const proxyRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const connections = yield* McpConnectionService;
  const stdioHost = yield* McpStdioHost.McpStdioHost;
  const params = yield* HttpRouter.params;
  const rawId = params.id;
  const id = typeof rawId === "string" && isMcpConnectionId(rawId) ? rawId : undefined;
  if (id === undefined) {
    return HttpServerResponse.jsonUnsafe(
      { error: "unknown_mcp_connection", message: "No such MCP connection." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const scope = yield* registry.resolve(bearerFrom(request.headers.authorization));
  if (!scope) {
    yield* Effect.logWarning("rejected MCP connection request with an unusable credential", { id });
    return unauthorized;
  }
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const config = yield* sessions.read(scope.thread.threadId);
  if (config?.providerSessionId !== scope.thread.providerSessionId) return unauthorized;
  const entry = (config.connections ?? []).find((candidate) => candidate.id === id);
  if (entry === undefined) {
    // Either the connection does not exist or this thread's project is not
    // signed in to it; the session only lists usable connections.
    return HttpServerResponse.jsonUnsafe(
      {
        error: "mcp_connection_not_attached",
        message: `The "${id}" MCP connection is not available to this session. Check Roost Settings > MCP connections for this project.`,
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
    return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, POST, DELETE" } });
  }

  const upstream = yield* connections.resolveUpstream(id, entry.projectId).pipe(Effect.option);
  if (Option.isNone(upstream)) {
    return needsSignIn(entry.name, "");
  }
  const body = request.method === "POST" ? new Uint8Array(yield* request.arrayBuffer) : undefined;

  if (upstream.value.kind === "stdio") {
    const hosted = yield* stdioHost
      .handle(id, upstream.value.spec, {
        method: request.method,
        ...(request.headers["mcp-session-id"] === undefined
          ? {}
          : { sessionId: request.headers["mcp-session-id"] }),
        ...(body === undefined ? {} : { body: new TextDecoder().decode(body) }),
      })
      .pipe(
        Effect.catch((error): Effect.Effect<McpStdioHost.McpStdioHostResponse> =>
          Effect.succeed({
            status: 502,
            body: `{"error":"mcp_connection_upstream_failed","message":${JSON.stringify(error.detail)}}`,
          }),
        ),
      );
    const headers: Record<string, string> = {
      "cache-control": "no-store, no-transform",
      ...(hosted.sessionId === undefined ? {} : { "mcp-session-id": hosted.sessionId }),
    };
    return hosted.body === undefined
      ? HttpServerResponse.empty({ status: hosted.status, headers })
      : HttpServerResponse.text(hosted.body, {
          status: hosted.status,
          headers,
          contentType: "application/json",
        });
  }

  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const target = upstream.value;
  const caller = callerHeaders({
    environmentId: config.environmentId,
    threadId: scope.thread.threadId,
    projectId: entry.threadProjectId,
  });
  const send = (authorization: string | undefined) =>
    httpClient.execute(
      HttpClientRequest.make(request.method)(target.url).pipe(
        HttpClientRequest.setHeaders({
          ...pick(request.headers, FORWARDED_REQUEST_HEADERS),
          ...caller,
          ...(authorization === undefined ? {} : { authorization }),
        }),
        body === undefined
          ? (self) => self
          : HttpClientRequest.bodyUint8Array(
              body,
              request.headers["content-type"] ?? "application/json",
            ),
      ),
    );
  let response = yield* send(target.authorization);
  if (response.status === 401 && target.authorization !== undefined) {
    const recovered = yield* connections.recoverAfterRejection(
      id,
      entry.projectId,
      target.authorization,
    );
    if (Option.isNone(recovered)) {
      return needsSignIn(entry.name, "The server rejected the stored credential.");
    }
    response = yield* send(recovered.value);
    if (response.status === 401) {
      return needsSignIn(entry.name, "The server rejected a freshly refreshed credential.");
    }
  }
  const headers: Record<string, string> = {
    ...pick(response.headers, FORWARDED_RESPONSE_HEADERS),
    // Compression would buffer an SSE stream; `no-transform` makes it skip this response.
    "cache-control": "no-store, no-transform",
  };
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
}).pipe(
  Effect.catchTags({
    HttpClientError: (error) =>
      Effect.logWarning("MCP connection upstream request failed", { error }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            {
              error: "mcp_connection_upstream_failed",
              message: "The MCP server could not be reached.",
            },
            { status: 502, headers: { "cache-control": "no-store" } },
          ),
        ),
      ),
  }),
);

const callbackRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const connections = yield* McpConnectionService;
  return yield* mcpConnectionCallbackResponse(
    connections.completeOAuth(new URL(request.url, "http://localhost")),
    MCP_OAUTH_CALLBACK_PATH,
  );
});

export const mcpConnectionProxyRouteLayer = HttpRouter.add("*", MCP_CONNECTIONS_ROUTE, proxyRoute);
export const mcpConnectionCallbackRouteLayer = HttpRouter.add(
  "GET",
  MCP_OAUTH_CALLBACK_PATH,
  callbackRoute,
);
