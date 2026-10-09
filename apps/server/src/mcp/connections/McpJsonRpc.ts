// JSON-RPC payloads from third-party MCP servers are relayed opaquely; decoding
// them against a schema here would reject traffic the proxy must pass through.
// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { McpConnectionError } from "@t3tools/contracts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcEnvelope {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

export const asJsonRpcEnvelope = (value: unknown): JsonRpcEnvelope | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRpcEnvelope)
    : null;

/** Data lines of each SSE event, joined, as the MCP streamable HTTP transport emits them. */
export function parseSseData(body: string): ReadonlyArray<string> {
  const events: Array<string> = [];
  for (const rawEvent of body.split(/\r?\n\r?\n/u)) {
    const data = rawEvent
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data.length > 0) events.push(data);
  }
  return events;
}

/** Every JSON-RPC payload in a streamable HTTP response body, whether JSON or SSE. */
export function parseMcpResponseBody(body: string, contentType: string): ReadonlyArray<unknown> {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const chunks = contentType.includes("text/event-stream") ? parseSseData(trimmed) : [trimmed];
  const payloads: Array<unknown> = [];
  for (const chunk of chunks) {
    try {
      const parsed: unknown = JSON.parse(chunk);
      if (Array.isArray(parsed)) payloads.push(...parsed);
      else payloads.push(parsed);
    } catch {
      // A non-JSON SSE event (keepalive, comment) carries nothing for us.
    }
  }
  return payloads;
}

export interface McpToolSummary {
  readonly name: string;
  readonly description?: string;
}

export interface McpToolsListing {
  readonly serverName?: string;
  readonly tools: ReadonlyArray<McpToolSummary>;
}

const errorMessage = (error: unknown): string => {
  const message =
    typeof error === "object" && error !== null
      ? (error as { readonly message?: unknown }).message
      : undefined;
  return typeof message === "string" && message.length > 0
    ? message
    : "The MCP server returned an error.";
};

export const toolSummaries = (result: unknown): ReadonlyArray<McpToolSummary> => {
  const tools =
    typeof result === "object" && result !== null
      ? (result as { readonly tools?: unknown }).tools
      : undefined;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (typeof tool !== "object" || tool === null) return [];
    const name = (tool as { readonly name?: unknown }).name;
    const description = (tool as { readonly description?: unknown }).description;
    if (typeof name !== "string") return [];
    return [{ name, ...(typeof description === "string" ? { description } : {}) }];
  });
};

export const serverNameOf = (initializeResult: unknown): string | undefined => {
  const serverInfo =
    typeof initializeResult === "object" && initializeResult !== null
      ? (initializeResult as { readonly serverInfo?: unknown }).serverInfo
      : undefined;
  const name =
    typeof serverInfo === "object" && serverInfo !== null
      ? (serverInfo as { readonly name?: unknown }).name
      : undefined;
  return typeof name === "string" ? name : undefined;
};

export const initializeParams = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "roost", version: "1.0.0" },
};

/**
 * A minimal streamable-HTTP MCP client over Effect's HttpClient: enough to
 * initialize and list tools, which is what "Test connection" needs.
 */
export const listUpstreamTools = Effect.fn("McpJsonRpc.listUpstreamTools")(function* (input: {
  readonly url: string;
  readonly authorization?: string;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  let sessionId: string | undefined;
  let nextId = 1;
  const upstreamFailure = (detail: string) =>
    new McpConnectionError({ reason: "upstream_failed", detail });
  const send = Effect.fn("McpJsonRpc.send")(function* (message: JsonRpcEnvelope) {
    const request = HttpClientRequest.post(input.url).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      }),
      HttpClientRequest.bodyUint8Array(
        new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", ...message })),
        "application/json",
      ),
    );
    const response = yield* httpClient
      .execute(request)
      .pipe(
        Effect.mapError((cause) =>
          upstreamFailure(`Could not reach the MCP server: ${cause.message}`),
        ),
      );
    const nextSession = response.headers["mcp-session-id"];
    if (typeof nextSession === "string" && nextSession.length > 0) sessionId = nextSession;
    const body = yield* response.text.pipe(
      Effect.mapError((cause) =>
        upstreamFailure(`Could not read the MCP response: ${cause.message}`),
      ),
    );
    if (response.status === 401 || response.status === 403) {
      return yield* new McpConnectionError({
        reason: "needs_sign_in",
        detail: `The MCP server rejected the credential (HTTP ${response.status}).`,
      });
    }
    if (response.status >= 400) {
      return yield* upstreamFailure(
        `The MCP server answered HTTP ${response.status}${body.length > 0 ? `: ${body.slice(0, 300)}` : "."}`,
      );
    }
    return parseMcpResponseBody(body, response.headers["content-type"] ?? "");
  });
  const request = Effect.fn("McpJsonRpc.request")(function* (method: string, params: unknown) {
    const id = nextId++;
    const payloads = yield* send({ id, method, params });
    const envelope = payloads
      .map(asJsonRpcEnvelope)
      .find((candidate) => candidate !== null && candidate.id === id);
    if (!envelope) {
      return yield* upstreamFailure(`The MCP server did not answer ${method}.`);
    }
    if (envelope.error !== undefined) {
      return yield* upstreamFailure(errorMessage(envelope.error));
    }
    return envelope.result;
  });

  const initializeResult = yield* request("initialize", initializeParams);
  yield* send({ method: "notifications/initialized" }).pipe(Effect.ignore);
  const tools: Array<McpToolSummary> = [];
  let cursor: string | undefined;
  do {
    const result = yield* request("tools/list", cursor === undefined ? {} : { cursor });
    tools.push(...toolSummaries(result));
    const nextCursor =
      typeof result === "object" && result !== null
        ? (result as { readonly nextCursor?: unknown }).nextCursor
        : undefined;
    cursor = typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : undefined;
  } while (cursor !== undefined && tools.length < 500);
  const serverName = serverNameOf(initializeResult);
  return {
    ...(serverName === undefined ? {} : { serverName }),
    tools,
  } satisfies McpToolsListing;
});

/** Avoids a dependency on HttpBody for callers that only need the helper's type. */
export type { HttpBody };
