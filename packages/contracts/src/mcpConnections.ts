import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

/**
 * User MCP connections: third-party MCP servers Roost owns and hands to every
 * agent session as its own server entry, named by this id. The id is the
 * server key every CLI shows the model, so it is a short slug.
 */
export const McpConnectionId = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
).pipe(Schema.brand("McpConnectionId"));
export type McpConnectionId = typeof McpConnectionId.Type;

/** Server keys Roost injects itself; a connection may not take them. */
export const MCP_CONNECTION_RESERVED_IDS: ReadonlySet<string> = new Set(["t3-code", "t3_code"]);

export const McpConnectionHttpAuth = Schema.Literals(["oauth", "bearer", "none"]);
export type McpConnectionHttpAuth = typeof McpConnectionHttpAuth.Type;

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export const McpConnectionUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) =>
    isHttpUrl(value) ? true : "MCP server URL must be a well-formed HTTP(S) URL.",
  ),
);

export const McpConnectionHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: McpConnectionUrl,
  auth: McpConnectionHttpAuth,
  /** Space-separated scope override; absent means the server's advertised scopes. */
  scopes: Schema.optionalKey(TrimmedString),
  /** For authorization servers without dynamic client registration. */
  oauthClientId: Schema.optionalKey(TrimmedString),
});
export type McpConnectionHttpTransport = typeof McpConnectionHttpTransport.Type;

export const McpConnectionStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Same shape and redaction contract as provider instance environment. */
  env: Schema.Array(ProviderInstanceEnvironmentVariable).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type McpConnectionStdioTransport = typeof McpConnectionStdioTransport.Type;

export const McpConnectionTransport = Schema.Union([
  McpConnectionHttpTransport,
  McpConnectionStdioTransport,
]);
export type McpConnectionTransport = typeof McpConnectionTransport.Type;

export const McpConnection = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  transport: McpConnectionTransport,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type McpConnection = typeof McpConnection.Type;

/**
 * Where a connection stands for one project. OAuth and bearer connections are
 * signed in per project, so the same connection can be `connected` for one
 * project and `needs_sign_in` for another; stdio and unauthenticated http
 * connections carry `not_required` with a null project.
 */
export const McpConnectionAuthState = Schema.Literals([
  "connected",
  "needs_sign_in",
  "error",
  "not_required",
]);
export type McpConnectionAuthState = typeof McpConnectionAuthState.Type;

export const McpConnectionStatus = Schema.Struct({
  connectionId: McpConnectionId,
  projectId: Schema.NullOr(ProjectId),
  state: McpConnectionAuthState,
  detail: Schema.optionalKey(Schema.String),
  /** OAuth only: when the current access token expires, for the status row. */
  expiresAt: Schema.optionalKey(Schema.String),
});
export type McpConnectionStatus = typeof McpConnectionStatus.Type;

export const McpConnectionStatuses = Schema.Array(McpConnectionStatus);
export type McpConnectionStatuses = typeof McpConnectionStatuses.Type;

export class McpConnectionError extends Schema.TaggedError<McpConnectionError>()(
  "McpConnectionError",
  {
    reason: Schema.Literals([
      "not_found",
      "invalid",
      "reserved_id",
      "discovery_failed",
      "registration_failed",
      "exchange_failed",
      "refresh_failed",
      "needs_sign_in",
      "upstream_failed",
      "storage_failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const McpConnectionUpsertInput = Schema.Struct({
  id: McpConnectionId,
  config: McpConnection,
});
export type McpConnectionUpsertInput = typeof McpConnectionUpsertInput.Type;

export const McpConnectionRemoveInput = Schema.Struct({ id: McpConnectionId });
export type McpConnectionRemoveInput = typeof McpConnectionRemoveInput.Type;

export const McpConnectionSetBearerTokenInput = Schema.Struct({
  id: McpConnectionId,
  projectId: ProjectId,
  token: TrimmedNonEmptyString,
});
export type McpConnectionSetBearerTokenInput = typeof McpConnectionSetBearerTokenInput.Type;

export const McpConnectionConnectInput = Schema.Struct({
  id: McpConnectionId,
  projectId: ProjectId,
  /** The HTTP origin this client reaches the server at; the OAuth redirect lands there. */
  callbackOrigin: TrimmedNonEmptyString,
  returnUrl: Schema.optionalKey(TrimmedString),
});
export type McpConnectionConnectInput = typeof McpConnectionConnectInput.Type;

export const McpConnectionConnectResult = Schema.Struct({
  authorizationUrl: Schema.String,
});
export type McpConnectionConnectResult = typeof McpConnectionConnectResult.Type;

export const McpConnectionDisconnectInput = Schema.Struct({
  id: McpConnectionId,
  projectId: ProjectId,
});
export type McpConnectionDisconnectInput = typeof McpConnectionDisconnectInput.Type;

export const McpConnectionTestInput = Schema.Struct({
  id: McpConnectionId,
  projectId: Schema.NullOr(ProjectId),
});
export type McpConnectionTestInput = typeof McpConnectionTestInput.Type;

export const McpConnectionTestResult = Schema.Struct({
  serverName: Schema.optionalKey(Schema.String),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type McpConnectionTestResult = typeof McpConnectionTestResult.Type;

/** Effective state for one project: which states count as "the agent gets this server". */
export const mcpConnectionIsUsable = (state: McpConnectionAuthState): boolean =>
  state === "connected" || state === "not_required";
