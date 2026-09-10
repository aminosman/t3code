// @effect-diagnostics nodeBuiltinImport:off - kea's runtime file and unix
// socket are a Node boundary: discovery is one synchronous read at call time,
// with no Effect environment to thread through a tool handler.
/**
 * KeaBridge — the socket kea leaves open for threads running here.
 *
 * The T3 side of a link whose other half lives in kea (`Sources/kea/
 * KeaBridge.swift`, `Sources/kea/ThreadAgent.swift`). kea already drives T3:
 * it discovers this server's runtime file, pairs through the bundled CLI, and
 * dispatches threads. This is the return path — an agent mid-turn asking the
 * Mac something no repository can answer.
 *
 * Deliberately not a Context.Service. There is no state to own, no
 * connection to keep alive and nothing to inject in tests beyond the two
 * paths this module reads from the environment; a service would be three
 * files of ceremony around one socket write.
 *
 * Discovery mirrors what kea does to us: read the runtime file the other
 * side writes beside its state, and trust it only while the pid it names is
 * alive. A stale file is treated as no bridge, so a kea that crashed reads
 * as absent rather than as a hang.
 *
 * @module mcp/KeaBridge
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface KeaRuntime {
  readonly pid: number;
  readonly socket: string;
  readonly token: string;
  readonly startedAt: string;
  /** kea's own binary, so `<executable> mcp` can be spawned without guessing where it lives. */
  readonly executable?: string;
}

/** Where kea publishes its bridge. `KEA_CONFIG_DIR` is kea's own override. */
export function runtimePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KEA_CONFIG_DIR?.trim();
  const dir = override
    ? override.startsWith("~")
      ? NodePath.join(NodeOS.homedir(), override.slice(1))
      : override
    : NodePath.join(NodeOS.homedir(), ".config", "kea");
  return NodePath.join(dir, "bridge-runtime.json");
}

/** A live bridge, or undefined when kea is not running this build. */
export function runtime(env: NodeJS.ProcessEnv = process.env): KeaRuntime | undefined {
  let parsed: Partial<KeaRuntime>;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(runtimePath(env), "utf8")) as Partial<KeaRuntime>;
  } catch {
    return undefined;
  }
  const { pid, socket, token, startedAt, executable } = parsed;
  if (typeof pid !== "number" || typeof socket !== "string" || typeof token !== "string") {
    return undefined;
  }
  try {
    // Signal 0 asks "is this process there?" without touching it.
    process.kill(pid, 0);
  } catch {
    return undefined;
  }
  return {
    pid,
    socket,
    token,
    startedAt: startedAt ?? "",
    ...(typeof executable === "string" && executable.length > 0 ? { executable } : {}),
  };
}

export interface KeaMcpServer {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * kea as an MCP server for an agent to spawn: `<kea> mcp --caller <who>`.
 *
 * The collection surface — what is on this Mac, read-only — offered to every
 * model, over the standard transport, from the one kea the user is already
 * talking to (`kea mcp` is a proxy onto the daemon's socket, not a second
 * daemon). The caller is the provider instance id, which is what kea matches
 * against the user's allowlist for the personal surface (dictation history,
 * messages, mail); an unlisted caller gets collection only.
 *
 * Undefined when kea is not running, or runs a build that predates the
 * executable field — the same "absent, not broken" reading as `runtime()`.
 */
export function mcpServer(
  caller: string,
  env: NodeJS.ProcessEnv = process.env,
): KeaMcpServer | undefined {
  const live = runtime(env);
  if (!live?.executable) return undefined;
  return { command: live.executable, args: ["mcp", "--caller", caller] };
}

/** A TOML basic string: quoted, with the two characters that need escaping escaped. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The same server as Codex `-c` config overrides — Codex takes its MCP
 * servers from its TOML config, and the app server accepts dotted overrides
 * on the command line, one `-c key=value` pair per key.
 */
export function codexOverrides(server: KeaMcpServer): ReadonlyArray<string> {
  return [
    "-c",
    `mcp_servers.kea.command=${tomlString(server.command)}`,
    "-c",
    `mcp_servers.kea.args=[${server.args.map(tomlString).join(",")}]`,
  ];
}

export interface KeaReply {
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
}

/**
 * One request, one reply, one connection.
 *
 * The timeout is generous because the thing on the other end is an agent
 * loop, not a getter: reading a window is fast, but "find out which of his
 * tabs has the failing build" is a dozen rounds. It is an inactivity
 * timeout rather than a deadline — kea writes nothing until it is done, so
 * any traffic at all means an answer is arriving.
 */
export function request(
  payload: Record<string, unknown>,
  options: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<KeaReply> {
  const live = runtime(options.env);
  if (!live) {
    return Promise.resolve({
      ok: false,
      error: "kea is not running on this Mac (no live bridge-runtime.json)",
    });
  }
  const timeoutMs = options.timeoutMs ?? 300_000;
  return new Promise<KeaReply>((resolve) => {
    let settled = false;
    const finish = (reply: KeaReply) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reply);
    };
    const socket = NodeNet.createConnection({ path: live.socket });
    socket.setTimeout(timeoutMs);
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ ...payload, token: live.token })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)) as KeaReply);
      } catch {
        finish({ ok: false, error: "kea sent a reply this build could not parse" });
      }
    });
    socket.on("timeout", () => {
      finish({ ok: false, error: `kea did not answer within ${Math.round(timeoutMs / 1000)}s` });
    });
    socket.on("error", (error) => {
      finish({ ok: false, error: `could not reach kea: ${error.message}` });
    });
    socket.on("close", () => {
      finish({ ok: false, error: "kea closed the connection without answering" });
    });
  });
}

/** Is there a kea to ask? Used to decide whether to advertise the toolkit. */
export function available(env: NodeJS.ProcessEnv = process.env): boolean {
  return runtime(env) !== undefined;
}
