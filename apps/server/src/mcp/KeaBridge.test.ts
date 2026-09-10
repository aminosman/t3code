// @effect-diagnostics nodeBuiltinImport:off - the runtime file IS the contract
// under test; it is written and read with the same node calls the module uses.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import * as KeaBridge from "./KeaBridge.ts";

/**
 * The runtime file is the whole discovery contract, so these exercise it
 * end to end on disk: a live pid (this process's own) reads as a bridge, a
 * dead one as none, and the MCP spawn spec comes straight off the file.
 */
describe("KeaBridge discovery", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kea-bridge-test-"));
    env = { KEA_CONFIG_DIR: dir };
  });

  afterEach(() => {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  const write = (runtime: Record<string, unknown>) => {
    NodeFS.writeFileSync(KeaBridge.runtimePath(env), JSON.stringify(runtime));
  };

  it("honours KEA_CONFIG_DIR for the runtime path", () => {
    expect(KeaBridge.runtimePath(env)).toBe(NodePath.join(dir, "bridge-runtime.json"));
  });

  it("reads a live bridge, executable included", () => {
    write({
      pid: process.pid,
      socket: "/tmp/kea.sock",
      token: "abc",
      startedAt: "2026-09-09T00:00:00Z",
      executable: "/Applications/Kea.app/Contents/MacOS/kea",
    });
    expect(KeaBridge.runtime(env)).toEqual({
      pid: process.pid,
      socket: "/tmp/kea.sock",
      token: "abc",
      startedAt: "2026-09-09T00:00:00Z",
      executable: "/Applications/Kea.app/Contents/MacOS/kea",
    });
    expect(KeaBridge.available(env)).toBe(true);
  });

  it("treats a dead pid as no bridge", () => {
    // 2^22 + 1 is above any real pid table on macOS and Linux.
    write({ pid: 4194305, socket: "/tmp/kea.sock", token: "abc", startedAt: "" });
    expect(KeaBridge.runtime(env)).toBeUndefined();
    expect(KeaBridge.available(env)).toBe(false);
  });

  it("treats a missing or malformed file as no bridge", () => {
    expect(KeaBridge.runtime(env)).toBeUndefined();
    NodeFS.writeFileSync(KeaBridge.runtimePath(env), "not json");
    expect(KeaBridge.runtime(env)).toBeUndefined();
    write({ pid: process.pid });
    expect(KeaBridge.runtime(env)).toBeUndefined();
  });

  it("spawns kea as an MCP server with the caller named", () => {
    write({
      pid: process.pid,
      socket: "/tmp/kea.sock",
      token: "abc",
      startedAt: "",
      executable: "/opt/kea/kea",
    });
    expect(KeaBridge.mcpServer("claudeAgent", env)).toEqual({
      command: "/opt/kea/kea",
      args: ["mcp", "--caller", "claudeAgent"],
    });
  });

  it("renders the server as Codex -c overrides with TOML quoting", () => {
    expect(
      KeaBridge.codexOverrides({
        command: '/Users/a b/Kea "dev".app/kea',
        args: ["mcp", "--caller", "codex"],
      }),
    ).toEqual([
      "-c",
      'mcp_servers.kea.command="/Users/a b/Kea \\"dev\\".app/kea"',
      "-c",
      'mcp_servers.kea.args=["mcp","--caller","codex"]',
    ]);
  });

  it("offers no MCP server for a kea that does not name its executable", () => {
    write({ pid: process.pid, socket: "/tmp/kea.sock", token: "abc", startedAt: "" });
    expect(KeaBridge.runtime(env)).toBeDefined();
    expect(KeaBridge.mcpServer("claudeAgent", env)).toBeUndefined();
  });
});
