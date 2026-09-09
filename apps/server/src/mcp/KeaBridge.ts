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
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface KeaRuntime {
  readonly pid: number;
  readonly socket: string;
  readonly token: string;
  readonly startedAt: string;
}

/** Where kea publishes its bridge. `KEA_CONFIG_DIR` is kea's own override. */
export function runtimePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KEA_CONFIG_DIR?.trim();
  const dir = override
    ? override.startsWith("~")
      ? path.join(os.homedir(), override.slice(1))
      : override
    : path.join(os.homedir(), ".config", "kea");
  return path.join(dir, "bridge-runtime.json");
}

/** A live bridge, or undefined when kea is not running this build. */
export function runtime(env: NodeJS.ProcessEnv = process.env): KeaRuntime | undefined {
  let parsed: Partial<KeaRuntime>;
  try {
    parsed = JSON.parse(fs.readFileSync(runtimePath(env), "utf8")) as Partial<KeaRuntime>;
  } catch {
    return undefined;
  }
  const { pid, socket, token, startedAt } = parsed;
  if (typeof pid !== "number" || typeof socket !== "string" || typeof token !== "string") {
    return undefined;
  }
  try {
    // Signal 0 asks "is this process there?" without touching it.
    process.kill(pid, 0);
  } catch {
    return undefined;
  }
  return { pid, socket, token, startedAt: startedAt ?? "" };
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
    const socket = net.createConnection({ path: live.socket });
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
