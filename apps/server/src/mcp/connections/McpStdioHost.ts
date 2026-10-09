// The host relays opaque JSON-RPC between agents and a stdio MCP server.
// @effect-diagnostics preferSchemaOverJson:off
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { McpConnectionError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  asJsonRpcEnvelope,
  initializeParams,
  MCP_PROTOCOL_VERSION,
  type JsonRpcEnvelope,
} from "./McpJsonRpc.ts";

/**
 * Hosts stdio MCP servers inside Roost and exposes each as a streamable HTTP
 * endpoint, so a local server is one process shared by every agent session
 * instead of one copy per CLI, and its environment (API keys) never leaves
 * the server. Agents speak the HTTP transport; this host multiplexes them
 * onto the one stdio session: `initialize` is answered from the server's
 * cached handshake, request ids are remapped per client, and anything the
 * server asks of its client (sampling, elicitation, roots) is declined, since
 * no single agent owns the session.
 */

export interface McpStdioServerSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface McpStdioHostRequest {
  readonly method: string;
  readonly sessionId?: string;
  readonly body?: string;
}

export interface McpStdioHostResponse {
  readonly status: number;
  readonly body?: string;
  readonly sessionId?: string;
}

export interface McpStdioHostShape {
  readonly handle: (
    id: string,
    spec: McpStdioServerSpec,
    request: McpStdioHostRequest,
  ) => Effect.Effect<McpStdioHostResponse, McpConnectionError>;
  /** The server's cached `initialize` result, starting it when needed. */
  readonly initializeResult: (
    id: string,
    spec: McpStdioServerSpec,
  ) => Effect.Effect<unknown, McpConnectionError>;
  /** One request against the server on the host's own behalf (Test connection). */
  readonly request: (
    id: string,
    spec: McpStdioServerSpec,
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, McpConnectionError>;
  readonly stop: (id: string) => Effect.Effect<void>;
}

export class McpStdioHost extends Context.Service<McpStdioHost, McpStdioHostShape>()(
  "t3/mcp/connections/McpStdioHost",
) {}

const INITIALIZE_TIMEOUT = Duration.seconds(30);
const REQUEST_TIMEOUT = Duration.minutes(10);
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

interface Running {
  readonly specKey: string;
  readonly scope: Scope.Closeable;
  readonly outgoing: Queue.Queue<Uint8Array>;
  readonly pending: Map<number, Deferred.Deferred<JsonRpcEnvelope, McpConnectionError>>;
  readonly initialized: Deferred.Deferred<unknown, McpConnectionError>;
  readonly sessions: Set<string>;
  nextId: number;
  dead: McpConnectionError | undefined;
}

/** JSON or undefined, never a throw, so generators stay free of try/catch. */
const parseJsonLine = (line: string): unknown | undefined => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

const specKeyOf = (spec: McpStdioServerSpec): string =>
  JSON.stringify([spec.command, spec.args, spec.env, spec.cwd ?? null]);

const upstreamFailure = (detail: string) =>
  new McpConnectionError({ reason: "upstream_failed", detail });

const jsonResponse = (status: number, payload: unknown, sessionId?: string) =>
  ({
    status,
    body: JSON.stringify(payload),
    ...(sessionId === undefined ? {} : { sessionId }),
  }) satisfies McpStdioHostResponse;

const jsonRpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

/** Splits stdout into LF-delimited lines, carrying a partial line across chunks. */
const makeLineFramer = () => {
  let remainder = "";
  return (chunk: string): ReadonlyArray<string> => {
    const text = remainder + chunk;
    const parts = text.split("\n");
    remainder = parts.pop() ?? "";
    return parts.map((line) => line.replace(/\r$/u, "")).filter((line) => line.length > 0);
  };
};

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const layerScope = yield* Effect.scope;
  const running = new Map<string, Running>();
  const starting = new Map<string, Semaphore.Semaphore>();

  const mutexFor = (id: string) =>
    Effect.suspend(() => {
      const existing = starting.get(id);
      if (existing) return Effect.succeed(existing);
      return Semaphore.make(1).pipe(
        Effect.tap((mutex) => Effect.sync(() => starting.set(id, mutex))),
      );
    });

  const shutdown = (entry: Running, reason: McpConnectionError) =>
    Effect.gen(function* () {
      entry.dead = reason;
      for (const deferred of entry.pending.values()) {
        yield* Deferred.fail(deferred, reason);
      }
      entry.pending.clear();
      yield* Deferred.fail(entry.initialized, reason).pipe(Effect.ignore);
      yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    });

  const spawn = Effect.fn("McpStdioHost.spawn")(function* (id: string, spec: McpStdioServerSpec) {
    const scope = yield* Scope.make();
    const outgoing = yield* Queue.make<Uint8Array>();
    const initialized = yield* Deferred.make<unknown, McpConnectionError>();
    const entry: Running = {
      specKey: specKeyOf(spec),
      scope,
      outgoing,
      pending: new Map(),
      initialized,
      sessions: new Set(),
      nextId: 1,
      dead: undefined,
    };
    const spawnCommand = yield* resolveSpawnCommand(spec.command, [...spec.args], {
      env: spec.env,
    }).pipe(
      Effect.mapError((cause) =>
        upstreamFailure(`Could not resolve ${spec.command}: ${String(cause)}`),
      ),
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          env: spec.env,
          extendEnv: false,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          upstreamFailure(`Could not start ${spec.command}: ${cause.message}`),
        ),
        Scope.provide(scope),
      );

    const route = (line: string) =>
      Effect.gen(function* () {
        const parsed = parseJsonLine(line);
        if (parsed === undefined) {
          yield* Effect.logDebug("Dropping non-JSON MCP stdio line", { id, length: line.length });
          return;
        }
        const envelope = asJsonRpcEnvelope(parsed);
        if (envelope === null) return;
        if (envelope.method === undefined) {
          // A response: hand it to whoever is waiting on that id.
          const key = typeof envelope.id === "number" ? envelope.id : Number.NaN;
          const waiting = entry.pending.get(key);
          if (waiting !== undefined) {
            entry.pending.delete(key);
            yield* Deferred.succeed(waiting, envelope);
          }
          return;
        }
        if (envelope.id !== undefined && envelope.id !== null) {
          // A server-to-client request. No single agent owns this session, so
          // decline it instead of guessing which client should answer.
          yield* Queue.offer(
            outgoing,
            new TextEncoder().encode(
              `${JSON.stringify(jsonRpcError(envelope.id, -32601, "This MCP server is hosted by Roost; client requests are not supported."))}\n`,
            ),
          );
        }
        // Server notifications (tools/list_changed) have no stream to fan out
        // on; agents re-list tools on their own schedule.
      });

    yield* Effect.gen(function* () {
      const frame = makeLineFramer();
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Effect.forEach(frame(chunk), route, { discard: true })),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("MCP stdio reader ended", { id, cause })),
      Effect.andThen(shutdown(entry, upstreamFailure(`${spec.command} closed its output.`))),
      Effect.forkIn(scope),
    );
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Effect.logDebug("MCP stdio server stderr", { id, text })),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(child.stdin),
      Effect.catchCause((cause) => Effect.logDebug("MCP stdio writer ended", { id, cause })),
      Effect.forkIn(scope),
    );
    yield* child.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(shutdown(entry, upstreamFailure(`${spec.command} exited.`))),
      Effect.forkIn(scope),
    );
    // Stop the child when the host goes away.
    yield* Scope.addFinalizer(layerScope, Scope.close(scope, Exit.void));
    return entry;
  });

  const send = (entry: Running, payload: unknown) =>
    Effect.gen(function* () {
      const line = JSON.stringify(payload);
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
        return yield* upstreamFailure("MCP message exceeds 8 MiB.");
      }
      if (entry.dead !== undefined) return yield* entry.dead;
      yield* Queue.offer(entry.outgoing, new TextEncoder().encode(`${line}\n`));
    });

  const call = (entry: Running, method: string, params: unknown, timeout: Duration.Duration) =>
    Effect.gen(function* () {
      const id = entry.nextId++;
      const deferred = yield* Deferred.make<JsonRpcEnvelope, McpConnectionError>();
      entry.pending.set(id, deferred);
      yield* send(entry, {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }).pipe(Effect.tapError(() => Effect.sync(() => entry.pending.delete(id))));
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.sync(() => entry.pending.delete(id)).pipe(
              Effect.andThen(upstreamFailure(`${method} timed out.`)),
            ),
        }),
      );
    });

  const ensureRunning = (id: string, spec: McpStdioServerSpec) =>
    mutexFor(id).pipe(
      Effect.flatMap((mutex) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            const current = running.get(id);
            if (
              current !== undefined &&
              current.dead === undefined &&
              current.specKey === specKeyOf(spec)
            ) {
              return current;
            }
            if (current !== undefined) {
              yield* shutdown(current, upstreamFailure("The MCP server was restarted."));
              running.delete(id);
            }
            const entry = yield* spawn(id, spec);
            running.set(id, entry);
            yield* call(entry, "initialize", initializeParams, INITIALIZE_TIMEOUT).pipe(
              Effect.flatMap((envelope) =>
                envelope.error !== undefined
                  ? upstreamFailure(`initialize failed: ${JSON.stringify(envelope.error)}`)
                  : Effect.succeed(envelope.result),
              ),
              Effect.tap((result) => Deferred.succeed(entry.initialized, result)),
              Effect.tap(() =>
                send(entry, { jsonrpc: "2.0", method: "notifications/initialized" }),
              ),
              Effect.tapError((error) => shutdown(entry, error)),
            );
            return entry;
          }),
        ),
      ),
    );

  const initializeResult: McpStdioHostShape["initializeResult"] = (id, spec) =>
    ensureRunning(id, spec).pipe(Effect.flatMap((entry) => Deferred.await(entry.initialized)));

  const request: McpStdioHostShape["request"] = (id, spec, method, params) =>
    ensureRunning(id, spec).pipe(
      Effect.flatMap((entry) => call(entry, method, params, REQUEST_TIMEOUT)),
      Effect.flatMap((envelope) =>
        envelope.error !== undefined
          ? upstreamFailure(
              typeof envelope.error === "object" && envelope.error !== null
                ? String((envelope.error as { readonly message?: unknown }).message ?? "MCP error")
                : "MCP error",
            )
          : Effect.succeed(envelope.result),
      ),
    );

  const handle: McpStdioHostShape["handle"] = (id, spec, httpRequest) =>
    Effect.gen(function* () {
      if (httpRequest.method === "DELETE") {
        if (httpRequest.sessionId !== undefined)
          running.get(id)?.sessions.delete(httpRequest.sessionId);
        return { status: 204 } satisfies McpStdioHostResponse;
      }
      if (httpRequest.method !== "POST") {
        return { status: 405 } satisfies McpStdioHostResponse;
      }
      const parsed = parseJsonLine(httpRequest.body ?? "");
      if (parsed === undefined) {
        return jsonResponse(400, jsonRpcError(null, -32700, "Parse error"));
      }
      const envelope = asJsonRpcEnvelope(parsed);
      if (envelope === null || typeof envelope.method !== "string") {
        return jsonResponse(400, jsonRpcError(null, -32600, "Invalid request"));
      }
      const isNotification = envelope.id === undefined || envelope.id === null;
      if (envelope.method === "initialize") {
        const entry = yield* ensureRunning(id, spec);
        const result = yield* Deferred.await(entry.initialized);
        const sessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        entry.sessions.add(sessionId);
        const serverResult =
          typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
        return jsonResponse(
          200,
          {
            jsonrpc: "2.0",
            id: envelope.id,
            result: {
              ...serverResult,
              protocolVersion: serverResult.protocolVersion ?? MCP_PROTOCOL_VERSION,
            },
          },
          sessionId,
        );
      }
      const entry = running.get(id);
      if (
        entry === undefined ||
        entry.dead !== undefined ||
        httpRequest.sessionId === undefined ||
        !entry.sessions.has(httpRequest.sessionId)
      ) {
        return jsonResponse(
          404,
          jsonRpcError(envelope.id, -32000, "Session not found; initialize first."),
        );
      }
      if (isNotification) {
        if (envelope.method !== "notifications/initialized") {
          yield* send(entry, {
            jsonrpc: "2.0",
            method: envelope.method,
            ...(envelope.params === undefined ? {} : { params: envelope.params }),
          }).pipe(Effect.ignore);
        }
        return { status: 202 } satisfies McpStdioHostResponse;
      }
      const response = yield* call(entry, envelope.method, envelope.params, REQUEST_TIMEOUT).pipe(
        Effect.catch((error) =>
          Effect.succeed({ error: { code: -32000, message: error.detail } } as JsonRpcEnvelope),
        ),
      );
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: envelope.id,
        ...(response.error !== undefined
          ? { error: response.error }
          : { result: response.result ?? null }),
      });
    });

  const stop: McpStdioHostShape["stop"] = (id) =>
    Effect.suspend(() => {
      const entry = running.get(id);
      if (entry === undefined) return Effect.void;
      running.delete(id);
      return shutdown(entry, upstreamFailure("The MCP server was stopped."));
    });

  return McpStdioHost.of({ handle, initializeResult, request, stop });
});

export const layer = Layer.effect(McpStdioHost, make);
