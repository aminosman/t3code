// The fake MCP server and the assertions trade opaque JSON-RPC envelopes.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpStdioHost from "./McpStdioHost.ts";

/**
 * A stdio MCP server in a few lines of Node: answers initialize and
 * tools/list, echoes tools/call arguments, asks the client a question on
 * `ask`, and exits on `die`.
 */
const FAKE_SERVER = `
let calls = 0;
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let index;
  while ((index = buffered.indexOf("\\n")) !== -1) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (line.trim().length === 0) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      calls += 1;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "fake-stdio", version: "1.0.0", initializeCalls: calls },
      } }) + "\\n");
    } else if (message.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object" } }],
      } }) + "\\n");
    } else if (message.method === "tools/call") {
      if (message.params.name === "die") process.exit(3);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: JSON.stringify({ id: message.id, args: message.params.arguments }) }],
      } }) + "\\n");
    } else if (message.method === "ask") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "server-1", method: "sampling/createMessage", params: {} }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { asked: true } }) + "\\n");
    } else if (message.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } }) + "\\n");
    }
  }
});
`;

const spec: McpStdioHost.McpStdioServerSpec = {
  command: process.execPath,
  args: ["-e", FAKE_SERVER],
  env: { PATH: process.env.PATH ?? "" },
};

const TestLayer = McpStdioHost.layer.pipe(Layer.provideMerge(NodeServices.layer));

const post = (
  host: McpStdioHost.McpStdioHostShape,
  id: string,
  body: unknown,
  sessionId?: string,
) =>
  host.handle(id, spec, {
    method: "POST",
    body: JSON.stringify(body),
    ...(sessionId === undefined ? {} : { sessionId }),
  });

const parse = (response: McpStdioHost.McpStdioHostResponse) =>
  JSON.parse(response.body ?? "null") as {
    readonly id?: unknown;
    readonly result?: Record<string, unknown>;
    readonly error?: { readonly code: number; readonly message: string };
  };

describe("McpStdioHost", () => {
  it.effect("shares one process between clients and remaps their request ids", () =>
    Effect.gen(function* () {
      const host = yield* McpStdioHost.McpStdioHost;
      const first = yield* post(host, "fake", {
        jsonrpc: "2.0",
        id: "a-1",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a" } },
      });
      expect(first.status).toBe(200);
      expect(first.sessionId).toBeDefined();
      expect(parse(first).id).toBe("a-1");
      expect(parse(first).result?.serverInfo).toMatchObject({ name: "fake-stdio" });

      const second = yield* post(host, "fake", {
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "b" } },
      });
      expect(second.sessionId).not.toBe(first.sessionId);
      // The server was initialized once; the second client got the cached handshake.
      expect(parse(second).result?.serverInfo).toMatchObject({ initializeCalls: 1 });

      const initialized = yield* post(
        host,
        "fake",
        { jsonrpc: "2.0", method: "notifications/initialized" },
        first.sessionId,
      );
      expect(initialized.status).toBe(202);

      const callA = yield* post(
        host,
        "fake",
        {
          jsonrpc: "2.0",
          id: "a-2",
          method: "tools/call",
          params: { name: "echo", arguments: { x: 1 } },
        },
        first.sessionId,
      );
      const callB = yield* post(
        host,
        "fake",
        {
          jsonrpc: "2.0",
          id: "a-2",
          method: "tools/call",
          params: { name: "echo", arguments: { x: 2 } },
        },
        second.sessionId,
      );
      // Both clients used id "a-2"; each got its own answer back under that id.
      expect(parse(callA).id).toBe("a-2");
      expect(parse(callB).id).toBe("a-2");
      const contentOf = (response: McpStdioHost.McpStdioHostResponse) =>
        (parse(response).result?.content ?? []) as Array<{ text: string }>;
      const textA = contentOf(callA)[0]!.text;
      const textB = contentOf(callB)[0]!.text;
      expect(JSON.parse(textA).args).toEqual({ x: 1 });
      expect(JSON.parse(textB).args).toEqual({ x: 2 });
      // The ids the server saw were the host's, not the clients'.
      expect(JSON.parse(textA).id).not.toBe(JSON.parse(textB).id);

      const listed = yield* host.request("fake", spec, "tools/list", {});
      expect(listed).toMatchObject({ tools: [{ name: "echo" }] });
      yield* host.stop("fake");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects requests without a session and declines server-to-client requests", () =>
    Effect.gen(function* () {
      const host = yield* McpStdioHost.McpStdioHost;
      const unknown = yield* post(host, "fake2", { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(unknown.status).toBe(404);
      const init = yield* post(host, "fake2", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c" } },
      });
      const asked = yield* post(
        host,
        "fake2",
        { jsonrpc: "2.0", id: 2, method: "ask" },
        init.sessionId,
      );
      expect(parse(asked).result).toEqual({ asked: true });
      const get = yield* host.handle("fake2", spec, { method: "GET", sessionId: init.sessionId! });
      expect(get.status).toBe(405);
      const ended = yield* host.handle("fake2", spec, {
        method: "DELETE",
        sessionId: init.sessionId!,
      });
      expect(ended.status).toBe(204);
      const afterEnd = yield* post(
        host,
        "fake2",
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
        init.sessionId,
      );
      expect(afterEnd.status).toBe(404);
      yield* host.stop("fake2");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("restarts the server after it exits", () =>
    Effect.gen(function* () {
      const host = yield* McpStdioHost.McpStdioHost;
      const init = yield* post(host, "fake3", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d" } },
      });
      const died = yield* post(
        host,
        "fake3",
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "die", arguments: {} } },
        init.sessionId,
      );
      expect(parse(died).error?.message).toMatch(/exited|closed its output/u);
      const again = yield* post(host, "fake3", {
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d" } },
      });
      expect(again.status).toBe(200);
      expect(parse(again).result?.serverInfo).toMatchObject({ initializeCalls: 1 });
      yield* host.stop("fake3");
    }).pipe(Effect.provide(TestLayer)),
  );
});
