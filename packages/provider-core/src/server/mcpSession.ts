import type {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  McpConnectionId,
  ProjectId,
  ToolActivitySource,
} from "@t3tools/contracts";

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
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly connections?: ReadonlyArray<McpProviderSessionConnection>;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

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

function mcpConnectionToolSource(connection: McpProviderSessionConnection): ToolActivitySource {
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

function findMcpProviderSessionConnection(
  config: McpProviderSessionConfig | undefined,
  serverName: string,
): McpProviderSessionConnection | undefined {
  const wanted = normalizeServerName(serverName);
  return (config?.connections ?? []).find(
    (connection) => normalizeServerName(connection.id) === wanted,
  );
}

/** The branding for `serverName` when it is one of this thread's connections. */
export function toolSourceForMcpServer(
  config: McpProviderSessionConfig | undefined,
  serverName: string | undefined,
): ToolActivitySource | undefined {
  if (serverName === undefined) return undefined;
  const connection = findMcpProviderSessionConnection(config, serverName);
  return connection === undefined ? undefined : mcpConnectionToolSource(connection);
}

/** The endpoint Roost serves a connection at, beside the `t3-code` endpoint. */
export function mcpConnectionEndpoint(baseEndpoint: string, id: McpConnectionId): string {
  return `${baseEndpoint}/connections/${id}`;
}
