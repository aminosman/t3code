import type {
  EnvironmentId,
  McpConnectionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ToolActivitySource,
} from "@t3tools/contracts";

/**
 * One user MCP connection as this session sees it: a Roost endpoint beside
 * `/mcp`, reached with the same per-thread bearer. `projectId` names the
 * sign-in the proxy uses; `url` is the upstream for timeline icons.
 */
export interface McpProviderSessionConnection {
  readonly id: McpConnectionId;
  readonly name: string;
  readonly projectId: ProjectId | null;
  readonly endpoint: string;
  readonly url?: string;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** User MCP connections usable for this thread's project, injected beside `t3-code`. */
  readonly connections?: ReadonlyArray<McpProviderSessionConnection>;
}

/** The connections a thread's session carries, or none when it has no credential yet. */
export function readMcpProviderSessionConnections(
  threadId: ThreadId,
): ReadonlyArray<McpProviderSessionConnection> {
  return sessionsByThread.get(threadId)?.connections ?? [];
}

/**
 * How a tool call from a user MCP connection is branded in the timeline: the
 * connection's display name and, for remote servers, the site's favicon.
 * Agents name the server by its id in every flattening they use, so the
 * lookup tolerates case and `-`/`_` swaps.
 */
export function mcpConnectionToolSource(
  connection: McpProviderSessionConnection,
): ToolActivitySource {
  return {
    key: `mcp:${connection.id}`,
    name: connection.name,
    kind: "integration",
    ...(connection.url === undefined
      ? {}
      : { icon: { _tag: "website", pageUrl: new URL(connection.url).origin } }),
  };
}

const normalizeServerName = (value: string) => value.toLowerCase().replaceAll("_", "-");

export function findMcpProviderSessionConnection(
  threadId: ThreadId,
  serverName: string,
): McpProviderSessionConnection | undefined {
  const wanted = normalizeServerName(serverName);
  return readMcpProviderSessionConnections(threadId).find(
    (connection) => normalizeServerName(connection.id) === wanted,
  );
}

/** The branding for `serverName` when it is one of this thread's connections. */
export function toolSourceForMcpServer(
  threadId: ThreadId,
  serverName: string | undefined,
): ToolActivitySource | undefined {
  if (serverName === undefined) return undefined;
  const connection = findMcpProviderSessionConnection(threadId, serverName);
  return connection === undefined ? undefined : mcpConnectionToolSource(connection);
}

/** The server half of a `mcp__<server>__<tool>` name, as Claude and Cursor flatten MCP tools. */
export function mcpServerFromFlattenedToolName(toolName: string): string | undefined {
  const match = /^mcp__(?<server>.+?)__(?<tool>.+)$/u.exec(toolName);
  return match?.groups?.server;
}

/** The endpoint Roost serves a connection at, beside the `t3-code` endpoint. */
export function mcpConnectionEndpoint(baseEndpoint: string, id: McpConnectionId): string {
  return `${baseEndpoint}/connections/${id}`;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
