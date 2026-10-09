import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import {
  MCP_CONNECTION_RESERVED_IDS,
  McpConnectionError,
  McpConnectionId,
  mcpConnectionIsUsable,
  ProjectId,
  type McpConnection,
  type McpConnectionConnectInput,
  type McpConnectionConnectResult,
  type McpConnectionHttpTransport,
  type McpConnectionStatus,
  type McpConnectionStatuses,
  type McpConnectionStdioTransport,
  type McpConnectionTestResult,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpConnectionOAuth from "./McpConnectionOAuth.ts";
import { listUpstreamTools, serverNameOf, toolSummaries } from "./McpJsonRpc.ts";
import * as McpStdioHost from "./McpStdioHost.ts";

/**
 * Owns the user's MCP connections: their definitions in settings, their
 * sign-in state per project in the secret store, the OAuth dance, and the
 * credential the proxy puts on each upstream request. Everything that reaches
 * a client (status) or an agent (which servers a thread gets) comes from here.
 */

const OAuthProjectRecord = Schema.Struct({
  kind: Schema.Literal("oauth"),
  accessToken: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  resource: Schema.String,
  tokenEndpoint: Schema.String,
  revocationEndpoint: Schema.optionalKey(Schema.String),
  clientId: Schema.String,
  clientSecret: Schema.optionalKey(Schema.String),
  /** Set when the last refresh failed; the project needs a new sign-in. */
  error: Schema.optionalKey(Schema.String),
});
type OAuthProjectRecord = typeof OAuthProjectRecord.Type;

const BearerProjectRecord = Schema.Struct({
  kind: Schema.Literal("bearer"),
  token: Schema.String,
});

const ProjectAuthRecord = Schema.Union([OAuthProjectRecord, BearerProjectRecord]);
type ProjectAuthRecord = typeof ProjectAuthRecord.Type;

const ClientRecord = Schema.Struct({
  issuer: Schema.String,
  redirectUri: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.optionalKey(Schema.String),
});

const AuthRecord = Schema.Struct({
  version: Schema.Literal(1),
  client: Schema.optionalKey(ClientRecord),
  projects: Schema.Record(Schema.String, ProjectAuthRecord),
});
type AuthRecord = typeof AuthRecord.Type;

const AuthRecordJson = Schema.fromJsonString(AuthRecord);
const decodeAuthRecord = Schema.decodeUnknownEffect(AuthRecordJson);
const encodeAuthRecord = Schema.encodeEffect(AuthRecordJson);

const EMPTY_AUTH_RECORD: AuthRecord = { version: 1, projects: {} };

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const authSecretName = (id: string) => `mcp-connection-auth-${b64(id)}`;
const envSecretName = (id: string, name: string) => `mcp-connection-env-${b64(id)}-${b64(name)}`;

export const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
const PENDING_FLOW_TTL_MS = 10 * 60 * 1_000;

interface PendingFlow {
  readonly connectionId: McpConnectionId;
  readonly projectId: ProjectId;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly returnUrl?: string;
  readonly expiresAt: number;
}

export type McpConnectionUpstream =
  | { readonly kind: "http"; readonly url: string; readonly authorization?: string }
  | { readonly kind: "stdio"; readonly spec: McpStdioHost.McpStdioServerSpec };

export interface McpConnectionAgentServer {
  readonly id: McpConnectionId;
  readonly name: string;
  readonly projectId: ProjectId | null;
  readonly url?: string;
}

export interface McpConnectionCompletedOAuth {
  readonly connectionId: McpConnectionId;
  readonly name: string;
  readonly returnUrl?: string;
}

export interface McpConnectionServiceShape {
  readonly upsert: (
    id: McpConnectionId,
    config: McpConnection,
  ) => Effect.Effect<void, McpConnectionError>;
  readonly remove: (id: McpConnectionId) => Effect.Effect<void, McpConnectionError>;
  readonly setBearerToken: (
    id: McpConnectionId,
    projectId: ProjectId,
    token: string,
  ) => Effect.Effect<void, McpConnectionError>;
  readonly disconnect: (
    id: McpConnectionId,
    projectId: ProjectId,
  ) => Effect.Effect<void, McpConnectionError>;
  readonly startOAuth: (
    input: McpConnectionConnectInput,
  ) => Effect.Effect<McpConnectionConnectResult, McpConnectionError>;
  /** Handles the browser's redirect back; the result tells the page what to show. */
  readonly completeOAuth: (
    callbackUrl: URL,
  ) => Effect.Effect<McpConnectionCompletedOAuth, McpConnectionError>;
  readonly test: (
    id: McpConnectionId,
    projectId: ProjectId | null,
  ) => Effect.Effect<McpConnectionTestResult, McpConnectionError>;
  readonly statuses: Effect.Effect<McpConnectionStatuses>;
  readonly subscribeStatuses: Stream.Stream<McpConnectionStatuses>;
  /** The connections an agent working in `projectId` gets, in settings order. */
  readonly serversForProject: (
    projectId: ProjectId | null,
  ) => Effect.Effect<ReadonlyArray<McpConnectionAgentServer>>;
  /** What the proxy forwards to for one connection on behalf of one project. */
  readonly resolveUpstream: (
    id: McpConnectionId,
    projectId: ProjectId | null,
  ) => Effect.Effect<McpConnectionUpstream, McpConnectionError>;
  /**
   * After the upstream rejected `usedAuthorization`: a fresh credential when
   * one can be obtained (another request already refreshed, or a refresh
   * succeeds now), or none, in which case the project is marked as needing a
   * sign-in.
   */
  readonly recoverAfterRejection: (
    id: McpConnectionId,
    projectId: ProjectId | null,
    usedAuthorization: string | undefined,
  ) => Effect.Effect<Option.Option<string>>;
}

export class McpConnectionService extends Context.Service<
  McpConnectionService,
  McpConnectionServiceShape
>()("t3/mcp/connections/McpConnectionService") {}

const storageFailure = (cause: unknown) =>
  new McpConnectionError({
    reason: "storage_failed",
    detail: cause instanceof Error ? cause.message : String(cause),
  });

const sensitiveEnv = (env: ReadonlyArray<ProviderInstanceEnvironmentVariable>) =>
  env.filter((variable) => variable.sensitive);

const bearerHeader = (token: string) => (token.startsWith("Bearer ") ? token : `Bearer ${token}`);

/** The origin of an http(s) URL, or undefined for anything else. */
const httpOriginOf = (value: string): string | undefined => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stdioHost = yield* McpStdioHost.McpStdioHost;
  const statusPubSub = yield* PubSub.unbounded<McpConnectionStatuses>();
  const pendingFlows = new Map<string, PendingFlow>();
  const locks = new Map<string, Semaphore.Semaphore>();
  // The OAuth helpers need the HTTP client and crypto; capture exactly those
  // so the service's methods carry no requirements of their own.
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const httpServices = Context.make(HttpClient.HttpClient, httpClient).pipe(
    Context.add(Crypto.Crypto, crypto),
  );

  const lockFor = (id: string) =>
    Effect.suspend(() => {
      const existing = locks.get(id);
      if (existing) return Effect.succeed(existing);
      return Semaphore.make(1).pipe(Effect.tap((mutex) => Effect.sync(() => locks.set(id, mutex))));
    });
  const withLock = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    lockFor(id).pipe(Effect.flatMap((mutex) => mutex.withPermits(1)(effect)));

  const readAuth = Effect.fn("McpConnectionService.readAuth")(function* (id: string) {
    const raw = yield* secrets.get(authSecretName(id)).pipe(Effect.mapError(storageFailure));
    if (Option.isNone(raw)) return EMPTY_AUTH_RECORD;
    return yield* decodeAuthRecord(Buffer.from(raw.value).toString("utf8")).pipe(
      Effect.orElseSucceed(() => EMPTY_AUTH_RECORD),
    );
  });

  const writeAuth = Effect.fn("McpConnectionService.writeAuth")(function* (
    id: string,
    record: AuthRecord,
  ) {
    if (record.client === undefined && Object.keys(record.projects).length === 0) {
      yield* secrets.remove(authSecretName(id)).pipe(Effect.mapError(storageFailure));
      return;
    }
    const encoded = yield* encodeAuthRecord(record).pipe(Effect.mapError(storageFailure));
    yield* secrets
      .set(authSecretName(id), new TextEncoder().encode(encoded))
      .pipe(Effect.mapError(storageFailure));
  });

  const updateAuth = (id: string, update: (record: AuthRecord) => AuthRecord) =>
    withLock(id, readAuth(id).pipe(Effect.flatMap((record) => writeAuth(id, update(record)))));

  const connectionsFromSettings: Effect.Effect<Readonly<Record<string, McpConnection>>> =
    settings.getSettings.pipe(
      Effect.map((current): Readonly<Record<string, McpConnection>> => current.mcpConnections),
      Effect.orElseSucceed((): Readonly<Record<string, McpConnection>> => ({})),
    );

  const requireConnection = Effect.fn("McpConnectionService.requireConnection")(function* (
    id: McpConnectionId,
  ) {
    const connections = yield* connectionsFromSettings;
    const config = connections[id];
    if (config === undefined) {
      return yield* new McpConnectionError({
        reason: "not_found",
        detail: `No MCP connection named "${id}".`,
      });
    }
    return config;
  });

  const projectState = (
    transport: McpConnectionHttpTransport,
    record: ProjectAuthRecord | undefined,
  ): Pick<McpConnectionStatus, "state" | "detail" | "expiresAt"> => {
    if (transport.auth === "none") return { state: "not_required" };
    if (record === undefined) return { state: "needs_sign_in" };
    if (record.kind === "bearer") {
      return transport.auth === "bearer" ? { state: "connected" } : { state: "needs_sign_in" };
    }
    if (transport.auth !== "oauth") return { state: "needs_sign_in" };
    if (record.error !== undefined) return { state: "needs_sign_in", detail: record.error };
    return {
      state: "connected",
      ...(record.expiresAt === undefined
        ? {}
        : { expiresAt: DateTime.formatIso(DateTime.makeUnsafe(record.expiresAt)) }),
    };
  };

  const statuses: McpConnectionServiceShape["statuses"] = Effect.gen(function* () {
    const connections = yield* connectionsFromSettings;
    const result: Array<McpConnectionStatus> = [];
    for (const [id, config] of Object.entries(connections)) {
      const connectionId = McpConnectionId.make(id);
      if (config.transport.type === "stdio" || config.transport.auth === "none") {
        result.push({ connectionId, projectId: null, state: "not_required" });
        continue;
      }
      const auth = yield* readAuth(id).pipe(Effect.orElseSucceed(() => EMPTY_AUTH_RECORD));
      for (const [projectId, record] of Object.entries(auth.projects)) {
        result.push({
          connectionId,
          projectId: ProjectId.make(projectId),
          ...projectState(config.transport, record),
        });
      }
    }
    return result;
  });

  const publishStatuses = statuses.pipe(
    Effect.flatMap((current) => PubSub.publish(statusPubSub, current)),
    Effect.asVoid,
  );

  // Definitions change through settings; the status list follows.
  yield* settings.streamChanges.pipe(
    Stream.runForEach(() => publishStatuses),
    Effect.ignore,
    Effect.forkScoped,
  );

  const persistEnvSecrets = Effect.fn("McpConnectionService.persistEnvSecrets")(function* (
    id: McpConnectionId,
    previous: McpConnection | undefined,
    next: McpConnectionStdioTransport,
  ) {
    const previousEnv =
      previous?.transport.type === "stdio" ? sensitiveEnv(previous.transport.env) : [];
    const nextEnv: Array<ProviderInstanceEnvironmentVariable> = [];
    for (const variable of next.env) {
      if (!variable.sensitive) {
        nextEnv.push({ name: variable.name, value: variable.value, sensitive: false });
        continue;
      }
      if (variable.value.length > 0) {
        yield* secrets
          .set(envSecretName(id, variable.name), new TextEncoder().encode(variable.value))
          .pipe(Effect.mapError(storageFailure));
        nextEnv.push({ name: variable.name, value: "", sensitive: true, valueRedacted: true });
      } else if (variable.valueRedacted === true) {
        nextEnv.push({ name: variable.name, value: "", sensitive: true, valueRedacted: true });
      } else {
        yield* secrets
          .remove(envSecretName(id, variable.name))
          .pipe(Effect.mapError(storageFailure));
        nextEnv.push({ name: variable.name, value: "", sensitive: true });
      }
    }
    for (const variable of previousEnv) {
      if (!next.env.some((candidate) => candidate.name === variable.name && candidate.sensitive)) {
        yield* secrets
          .remove(envSecretName(id, variable.name))
          .pipe(Effect.mapError(storageFailure));
      }
    }
    return { ...next, env: nextEnv } satisfies McpConnectionStdioTransport;
  });

  const removeEnvSecrets = (id: McpConnectionId, config: McpConnection | undefined) =>
    config?.transport.type === "stdio"
      ? Effect.forEach(
          sensitiveEnv(config.transport.env),
          (variable) =>
            secrets.remove(envSecretName(id, variable.name)).pipe(Effect.mapError(storageFailure)),
          { discard: true },
        )
      : Effect.void;

  const upsert: McpConnectionServiceShape["upsert"] = Effect.fn("McpConnectionService.upsert")(
    function* (id, config) {
      if (MCP_CONNECTION_RESERVED_IDS.has(id)) {
        return yield* new McpConnectionError({
          reason: "reserved_id",
          detail: `"${id}" is the name of Roost's own MCP server; pick another.`,
        });
      }
      const previous = (yield* connectionsFromSettings)[id];
      const transport =
        config.transport.type === "stdio"
          ? yield* persistEnvSecrets(id, previous, config.transport)
          : config.transport;
      if (previous?.transport.type === "stdio" && transport.type !== "stdio") {
        yield* removeEnvSecrets(id, previous);
      }
      // A changed auth mode or URL invalidates every project's sign-in.
      if (
        previous !== undefined &&
        (previous.transport.type !== transport.type ||
          (transport.type === "http" &&
            previous.transport.type === "http" &&
            (previous.transport.url !== transport.url ||
              previous.transport.auth !== transport.auth)))
      ) {
        yield* updateAuth(id, () => EMPTY_AUTH_RECORD);
      }
      if (previous?.transport.type === "stdio") yield* stdioHost.stop(id);
      yield* settings
        .updateSettings({ mcpConnections: { [id]: { ...config, transport } } })
        .pipe(Effect.mapError(storageFailure));
      yield* publishStatuses;
    },
  );

  const remove: McpConnectionServiceShape["remove"] = Effect.fn("McpConnectionService.remove")(
    function* (id) {
      const previous = (yield* connectionsFromSettings)[id];
      yield* removeEnvSecrets(id, previous);
      yield* withLock(id, secrets.remove(authSecretName(id)).pipe(Effect.mapError(storageFailure)));
      yield* stdioHost.stop(id);
      yield* settings
        .updateSettings({ mcpConnections: { [id]: null } })
        .pipe(Effect.mapError(storageFailure));
      yield* publishStatuses;
    },
  );

  const setBearerToken: McpConnectionServiceShape["setBearerToken"] = Effect.fn(
    "McpConnectionService.setBearerToken",
  )(function* (id, projectId, token) {
    const config = yield* requireConnection(id);
    if (config.transport.type !== "http" || config.transport.auth !== "bearer") {
      return yield* new McpConnectionError({
        reason: "invalid",
        detail: `"${config.name}" is not an API key connection.`,
      });
    }
    yield* updateAuth(id, (record) => ({
      ...record,
      projects: { ...record.projects, [projectId]: { kind: "bearer", token: token.trim() } },
    }));
    yield* publishStatuses;
  });

  const disconnect = Effect.fn("McpConnectionService.disconnect")(function* (
    id: McpConnectionId,
    projectId: ProjectId,
  ) {
    const auth = yield* readAuth(id);
    const record = auth.projects[projectId];
    if (record?.kind === "oauth" && record.revocationEndpoint !== undefined) {
      yield* McpConnectionOAuth.revokeToken({
        revocationEndpoint: record.revocationEndpoint,
        token: record.refreshToken ?? record.accessToken,
        clientId: record.clientId,
      });
    }
    yield* updateAuth(id, (current) => {
      const { [projectId]: _removed, ...projects } = current.projects;
      return { ...current, projects };
    });
    yield* publishStatuses;
  });

  const prunePendingFlows = (now: number) => {
    for (const [state, flow] of pendingFlows) {
      if (flow.expiresAt <= now) pendingFlows.delete(state);
    }
  };

  const startOAuth = Effect.fn("McpConnectionService.startOAuth")(function* (
    input: McpConnectionConnectInput,
  ) {
    const config = yield* requireConnection(input.id);
    if (config.transport.type !== "http" || config.transport.auth !== "oauth") {
      return yield* new McpConnectionError({
        reason: "invalid",
        detail: `"${config.name}" does not sign in with OAuth.`,
      });
    }
    const origin = httpOriginOf(input.callbackOrigin);
    if (origin === undefined) {
      return yield* new McpConnectionError({
        reason: "invalid",
        detail: "The callback origin must be an HTTP(S) URL.",
      });
    }
    const redirectUri = `${origin}${MCP_OAUTH_CALLBACK_PATH}`;
    const discovery = yield* McpConnectionOAuth.discover(config.transport.url);
    const metadata = discovery.authorizationServer;
    const issuer = metadata.issuer ?? "";
    const auth = yield* readAuth(input.id);
    const configuredClientId = config.transport.oauthClientId?.trim();
    const client: McpConnectionOAuth.OAuthClientRegistration =
      configuredClientId !== undefined && configuredClientId.length > 0
        ? { issuer, redirectUri, clientId: configuredClientId }
        : auth.client !== undefined &&
            auth.client.issuer === issuer &&
            auth.client.redirectUri === redirectUri
          ? auth.client
          : yield* McpConnectionOAuth.registerClient({ metadata, redirectUri }).pipe(
              Effect.tap((registration) =>
                updateAuth(input.id, (record) => ({ ...record, client: registration })),
              ),
            );
    const pkce = yield* McpConnectionOAuth.makePkce();
    const now = yield* Clock.currentTimeMillis;
    prunePendingFlows(now);
    const scope =
      config.transport.scopes !== undefined && config.transport.scopes.length > 0
        ? config.transport.scopes
        : discovery.scopesSupported.join(" ");
    pendingFlows.set(pkce.state, {
      connectionId: input.id,
      projectId: input.projectId,
      verifier: pkce.verifier,
      redirectUri,
      resource: discovery.resource,
      tokenEndpoint: metadata.token_endpoint,
      ...(metadata.revocation_endpoint === undefined
        ? {}
        : { revocationEndpoint: metadata.revocation_endpoint }),
      clientId: client.clientId,
      ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
      ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
      expiresAt: now + PENDING_FLOW_TTL_MS,
    });
    return {
      authorizationUrl: McpConnectionOAuth.buildAuthorizationUrl({
        metadata,
        clientId: client.clientId,
        redirectUri,
        state: pkce.state,
        codeChallenge: pkce.challenge,
        resource: discovery.resource,
        ...(scope.length > 0 ? { scope } : {}),
      }),
    };
  });

  const completeOAuth = Effect.fn("McpConnectionService.completeOAuth")(function* (
    callbackUrl: URL,
  ) {
    const state = callbackUrl.searchParams.get("state") ?? "";
    const now = yield* Clock.currentTimeMillis;
    prunePendingFlows(now);
    const flow = pendingFlows.get(state);
    if (flow === undefined) {
      return yield* new McpConnectionError({
        reason: "exchange_failed",
        detail: "This sign-in link has expired or was already used. Start again from Settings.",
      });
    }
    pendingFlows.delete(state);
    const error = callbackUrl.searchParams.get("error");
    if (error !== null) {
      const description = callbackUrl.searchParams.get("error_description");
      return yield* new McpConnectionError({
        reason: "exchange_failed",
        detail: `The authorization server declined: ${error}${description ? ` - ${description}` : ""}.`,
      });
    }
    const code = callbackUrl.searchParams.get("code");
    if (code === null || code.length === 0) {
      return yield* new McpConnectionError({
        reason: "exchange_failed",
        detail: "The authorization server returned no code.",
      });
    }
    const tokens = yield* McpConnectionOAuth.exchangeCode({
      tokenEndpoint: flow.tokenEndpoint,
      clientId: flow.clientId,
      ...(flow.clientSecret === undefined ? {} : { clientSecret: flow.clientSecret }),
      code,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.verifier,
      resource: flow.resource,
    });
    yield* updateAuth(flow.connectionId, (record) => ({
      ...record,
      projects: {
        ...record.projects,
        [flow.projectId]: {
          kind: "oauth",
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
          ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
          ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
          resource: flow.resource,
          tokenEndpoint: flow.tokenEndpoint,
          ...(flow.revocationEndpoint === undefined
            ? {}
            : { revocationEndpoint: flow.revocationEndpoint }),
          clientId: flow.clientId,
          ...(flow.clientSecret === undefined ? {} : { clientSecret: flow.clientSecret }),
        },
      },
    }));
    yield* publishStatuses;
    const config = (yield* connectionsFromSettings)[flow.connectionId];
    const returnUrl = providerAuthReturnUrl(flow.returnUrl);
    return {
      connectionId: flow.connectionId,
      name: config?.name ?? flow.connectionId,
      ...(returnUrl === undefined ? {} : { returnUrl }),
    };
  });

  /**
   * The access token for one project, refreshed when it is about to expire.
   * Serialized per connection so concurrent agent requests share one refresh.
   */
  const freshOAuthToken = (id: McpConnectionId, projectId: ProjectId, force: boolean) =>
    withLock(
      id,
      Effect.gen(function* () {
        const auth = yield* readAuth(id);
        const record = auth.projects[projectId];
        if (record === undefined || record.kind !== "oauth") {
          return yield* new McpConnectionError({
            reason: "needs_sign_in",
            detail: "This project has not signed in to this MCP server.",
          });
        }
        if (record.error !== undefined) {
          return yield* new McpConnectionError({ reason: "needs_sign_in", detail: record.error });
        }
        const now = yield* Clock.currentTimeMillis;
        const stale =
          force ||
          (record.expiresAt !== undefined &&
            record.expiresAt - McpConnectionOAuth.OAUTH_REFRESH_EARLY_MS <= now);
        if (!stale) return record.accessToken;
        if (record.refreshToken === undefined) {
          const detail = "The sign-in expired and the server issued no refresh token.";
          yield* writeAuth(id, {
            ...auth,
            projects: { ...auth.projects, [projectId]: { ...record, error: detail } },
          });
          return yield* new McpConnectionError({ reason: "needs_sign_in", detail });
        }
        const refreshed = yield* McpConnectionOAuth.refreshTokens({
          tokenEndpoint: record.tokenEndpoint,
          clientId: record.clientId,
          ...(record.clientSecret === undefined ? {} : { clientSecret: record.clientSecret }),
          refreshToken: record.refreshToken,
          resource: record.resource,
        }).pipe(
          Effect.tapError((error) =>
            writeAuth(id, {
              ...auth,
              projects: { ...auth.projects, [projectId]: { ...record, error: error.detail } },
            }),
          ),
        );
        yield* writeAuth(id, {
          ...auth,
          projects: {
            ...auth.projects,
            [projectId]: {
              ...record,
              accessToken: refreshed.accessToken,
              ...(refreshed.refreshToken === undefined
                ? {}
                : { refreshToken: refreshed.refreshToken }),
              ...(refreshed.expiresAt === undefined ? {} : { expiresAt: refreshed.expiresAt }),
              ...(refreshed.scope === undefined ? {} : { scope: refreshed.scope }),
            },
          },
        });
        return refreshed.accessToken;
      }),
    );

  const materializeStdio = Effect.fn("McpConnectionService.materializeStdio")(function* (
    id: McpConnectionId,
    transport: McpConnectionStdioTransport,
  ) {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) env[name] = value;
    }
    for (const variable of transport.env) {
      if (!variable.sensitive) {
        env[variable.name] = variable.value;
        continue;
      }
      const stored = yield* secrets
        .get(envSecretName(id, variable.name))
        .pipe(Effect.mapError(storageFailure));
      if (Option.isSome(stored)) env[variable.name] = Buffer.from(stored.value).toString("utf8");
    }
    return {
      command: transport.command,
      args: transport.args,
      env,
    } satisfies McpStdioHost.McpStdioServerSpec;
  });

  const resolveUpstream = Effect.fn("McpConnectionService.resolveUpstream")(function* (
    id: McpConnectionId,
    projectId: ProjectId | null,
  ) {
    const config = yield* requireConnection(id);
    if (!config.enabled) {
      return yield* new McpConnectionError({
        reason: "not_found",
        detail: `"${config.name}" is turned off.`,
      });
    }
    if (config.transport.type === "stdio") {
      return { kind: "stdio", spec: yield* materializeStdio(id, config.transport) } as const;
    }
    const { url, auth } = config.transport;
    if (auth === "none") return { kind: "http", url } as const;
    if (projectId === null) {
      return yield* new McpConnectionError({
        reason: "needs_sign_in",
        detail: "Sign in to this MCP server for a project first.",
      });
    }
    if (auth === "bearer") {
      const record = (yield* readAuth(id)).projects[projectId];
      if (record?.kind !== "bearer") {
        return yield* new McpConnectionError({
          reason: "needs_sign_in",
          detail: "No API key is set for this project.",
        });
      }
      return { kind: "http", url, authorization: bearerHeader(record.token) } as const;
    }
    const token = yield* freshOAuthToken(id, projectId, false);
    return { kind: "http", url, authorization: bearerHeader(token) } as const;
  });

  const recoverAfterRejection = Effect.fn("McpConnectionService.recoverAfterRejection")(function* (
    id: McpConnectionId,
    projectId: ProjectId | null,
    usedAuthorization: string | undefined,
  ) {
    if (projectId === null) return Option.none<string>();
    const config = yield* requireConnection(id).pipe(Effect.option);
    if (Option.isNone(config) || config.value.transport.type !== "http")
      return Option.none<string>();
    if (config.value.transport.auth !== "oauth") {
      // A static key the server no longer accepts: nothing to refresh.
      return Option.none<string>();
    }
    const current = yield* freshOAuthToken(id, projectId, false).pipe(Effect.option);
    if (Option.isSome(current) && bearerHeader(current.value) !== usedAuthorization) {
      return Option.some(bearerHeader(current.value));
    }
    const refreshed = yield* freshOAuthToken(id, projectId, true).pipe(Effect.option);
    yield* publishStatuses;
    return Option.map(refreshed, bearerHeader);
  });

  const serversForProject: McpConnectionServiceShape["serversForProject"] = Effect.fn(
    "McpConnectionService.serversForProject",
  )(function* (projectId) {
    const connections = yield* connectionsFromSettings;
    const result: Array<McpConnectionAgentServer> = [];
    for (const [rawId, config] of Object.entries(connections)) {
      if (!config.enabled) continue;
      const id = McpConnectionId.make(rawId);
      if (config.transport.type === "stdio") {
        result.push({ id, name: config.name, projectId: null });
        continue;
      }
      if (config.transport.auth === "none") {
        result.push({ id, name: config.name, projectId: null, url: config.transport.url });
        continue;
      }
      if (projectId === null) continue;
      const auth = yield* readAuth(rawId).pipe(Effect.orElseSucceed(() => EMPTY_AUTH_RECORD));
      const state = projectState(config.transport, auth.projects[projectId]).state;
      if (mcpConnectionIsUsable(state)) {
        result.push({ id, name: config.name, projectId, url: config.transport.url });
      }
    }
    return result;
  });

  const test = Effect.fn("McpConnectionService.test")(function* (
    id: McpConnectionId,
    projectId: ProjectId | null,
  ) {
    const upstream = yield* resolveUpstream(id, projectId);
    if (upstream.kind === "stdio") {
      const initializeResult = yield* stdioHost.initializeResult(id, upstream.spec);
      const listed = yield* stdioHost.request(id, upstream.spec, "tools/list", {});
      const serverName = serverNameOf(initializeResult);
      return {
        ...(serverName === undefined ? {} : { serverName }),
        tools: toolSummaries(listed),
      };
    }
    return yield* listUpstreamTools({
      url: upstream.url,
      ...(upstream.authorization === undefined ? {} : { authorization: upstream.authorization }),
    });
  });

  const provided =
    <Args extends ReadonlyArray<unknown>, A, E>(
      method: (...args: Args) => Effect.Effect<A, E, HttpClient.HttpClient | Crypto.Crypto>,
    ) =>
    (...args: Args) =>
      method(...args).pipe(Effect.provide(httpServices));

  return McpConnectionService.of({
    upsert,
    remove,
    setBearerToken,
    disconnect: provided(disconnect),
    startOAuth: provided(startOAuth),
    completeOAuth: provided(completeOAuth),
    test: provided(test),
    statuses,
    subscribeStatuses: Stream.concat(Stream.fromEffect(statuses), Stream.fromPubSub(statusPubSub)),
    serversForProject,
    resolveUpstream: provided(resolveUpstream),
    recoverAfterRejection: provided(recoverAfterRejection),
  });
});

export const layer = Layer.effect(McpConnectionService, make);
