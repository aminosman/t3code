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
} from "effect/unstable/http";
import { McpConnectionId } from "@t3tools/contracts";

import * as McpProviderSession from "../McpProviderSession.ts";
import * as McpSessionRegistry from "../McpSessionRegistry.ts";
import { MCP_OAUTH_CALLBACK_PATH, McpConnectionService } from "./McpConnectionService.ts";
import * as McpStdioHost from "./McpStdioHost.ts";

/**
 * `/mcp/connections/:id` is how an agent reaches a user MCP connection: the
 * same per-thread bearer that guards `/mcp` comes in, the project's real
 * credential goes out, and the JSON-RPC body passes through untouched. The
 * agent never holds a third-party token, and every CLI sees an ordinary
 * streamable HTTP server. Stdio connections take the same door and end at the
 * host that owns the child process.
 */

export const MCP_CONNECTIONS_ROUTE = "/mcp/connections/:id";

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
  const entry = McpProviderSession.readMcpProviderSessionConnections(scope.threadId).find(
    (candidate) => candidate.id === id,
  );
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
  const send = (authorization: string | undefined) =>
    httpClient.execute(
      HttpClientRequest.make(request.method)(target.url).pipe(
        HttpClientRequest.setHeaders({
          ...pick(request.headers, FORWARDED_REQUEST_HEADERS),
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
  Effect.catchTag("HttpClientError", (error) =>
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
  ),
);

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** What the browser shows after the authorization server sends it back. */
export function mcpConnectionCallbackPage(input: {
  readonly success: boolean;
  readonly name: string;
  readonly detail?: string;
  readonly returnUrl?: string;
}): string {
  const title = input.success ? `${input.name} is connected` : "Sign-in couldn't finish";
  const description = input.success
    ? input.returnUrl
      ? "Returning to Roost. Agents in this project can use it now."
      : "Agents in this project can use it now. You can close this tab."
    : (input.detail ?? "Return to Roost and try connecting again.");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · Roost</title>
${input.success && input.returnUrl ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(input.returnUrl)}">` : ""}
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18181b;background:#fafafa;color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:100%;max-width:440px;background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:32px;box-shadow:0 12px 40px #00000008}
.brand{font-size:18px;letter-spacing:-.5px;margin-bottom:36px;color:#71717a}.brand strong{color:#18181b}
.status{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:${input.success ? "#ecfdf5" : "#fef2f2"};color:${input.success ? "#059669" : "#dc2626"};margin-bottom:20px}
h1{font-size:24px;font-weight:600;letter-spacing:-.7px;line-height:1.25;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#71717a;margin:0}
a{display:inline-flex;align-items:center;justify-content:center;margin-top:28px;padding:10px 16px;border-radius:8px;background:#2563eb;color:white;font-size:14px;font-weight:500;text-decoration:none}
@media(prefers-color-scheme:dark){:root{color:#fafafa;background:#09090b}main{background:#18181b;border-color:#27272a;box-shadow:0 12px 40px #0003}.brand,p{color:#a1a1aa}.brand strong{color:#fafafa}.status{background:${input.success ? "#064e3b" : "#450a0a"};color:${input.success ? "#34d399" : "#f87171"}}}
</style></head><body><main><div class="brand"><strong>Roost</strong></div>
<div class="status" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${input.success ? '<path d="m5 12 4 4L19 6"/>' : '<path d="m6 6 12 12M6 18 18 6"/>'}</svg></div>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>
${input.returnUrl ? `<a href="${escapeHtml(input.returnUrl)}">Return to Roost</a>` : ""}
</main><script>history.replaceState(null,"","${MCP_OAUTH_CALLBACK_PATH}");</script></body></html>`;
}

const callbackRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const connections = yield* McpConnectionService;
  const url = new URL(request.url, "http://localhost");
  return yield* connections.completeOAuth(url).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logWarning("MCP connection sign-in could not finish", { error }).pipe(
          Effect.as(
            HttpServerResponse.text(
              mcpConnectionCallbackPage({ success: false, name: "", detail: error.detail }),
              { status: 400, contentType: "text/html", headers: { "cache-control": "no-store" } },
            ),
          ),
        ),
      onSuccess: (completed) =>
        Effect.succeed(
          HttpServerResponse.text(
            mcpConnectionCallbackPage({
              success: true,
              name: completed.name,
              ...(completed.returnUrl === undefined ? {} : { returnUrl: completed.returnUrl }),
            }),
            { contentType: "text/html", headers: { "cache-control": "no-store" } },
          ),
        ),
    }),
  );
});

export const mcpConnectionProxyRouteLayer = HttpRouter.add("*", MCP_CONNECTIONS_ROUTE, proxyRoute);
export const mcpConnectionCallbackRouteLayer = HttpRouter.add(
  "GET",
  MCP_OAUTH_CALLBACK_PATH,
  callbackRoute,
);
