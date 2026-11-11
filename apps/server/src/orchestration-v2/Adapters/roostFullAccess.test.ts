import { assert, describe, it } from "vite-plus/test";

import { roostFullAccessAllowsWithoutAsking } from "./roostFullAccess.ts";

const fullAccess = {
  permissionMode: "bypassPermissions",
  runtimeMode: "full-access",
  installPermissionCallback: false,
  matchedAskRule: undefined,
} as const;

describe("roostFullAccessAllowsWithoutAsking", () => {
  // Nov 11 2026: a careday thread stopped on `FILES=(${(f)"$(find …)"}); scp $FILES …`.
  it("answers the CLI's own safety checks in Full access", () => {
    assert.isTrue(
      roostFullAccessAllowsWithoutAsking({
        ...fullAccess,
        toolName: "Bash",
        toolInput: { command: 'FILES=(${(f)"$(ls)"}); echo ${#FILES}' },
      }),
    );
  });

  it("still asks when an ask rule someone wrote matched", () => {
    assert.isFalse(
      roostFullAccessAllowsWithoutAsking({
        ...fullAccess,
        toolName: "Bash",
        toolInput: { command: "git push" },
        matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "git push:*" },
      }),
    );
  });

  it("leaves Supervised and a bypass downgrade asking", () => {
    for (const ask of [
      {
        permissionMode: "default",
        runtimeMode: "approval-required",
        installPermissionCallback: true,
      },
      { permissionMode: "auto", runtimeMode: "full-access", installPermissionCallback: true },
      {
        permissionMode: "acceptEdits",
        runtimeMode: "auto-accept-edits",
        installPermissionCallback: true,
      },
    ]) {
      assert.isFalse(
        roostFullAccessAllowsWithoutAsking({
          ...ask,
          toolName: "Bash",
          toolInput: { command: "rm -rf build" },
          matchedAskRule: undefined,
        }),
      );
    }
  });

  describe("Plan mode in Full access", () => {
    const plan = { ...fullAccess, permissionMode: "plan" } as const;

    it("lets MCP tools through", () => {
      assert.isTrue(
        roostFullAccessAllowsWithoutAsking({
          ...plan,
          toolName: "mcp__cardwall__card_update",
          toolInput: { stage: "research" },
        }),
      );
    });

    it("lets Claude write its own plan file", () => {
      for (const file_path of [
        "/Users/amin/.claude-t3/a/plans/started-by-the-agent-jiggly-peacock.md",
        "/Users/amin/.claude/plans/quiet-river.md",
      ]) {
        assert.isTrue(
          roostFullAccessAllowsWithoutAsking({
            ...plan,
            toolName: "Edit",
            toolInput: { file_path },
          }),
          file_path,
        );
      }
    });

    it("still holds other writes and commands", () => {
      assert.isFalse(
        roostFullAccessAllowsWithoutAsking({
          ...plan,
          toolName: "Edit",
          toolInput: { file_path: "/workspace/src/plans/index.md" },
        }),
      );
      assert.isFalse(
        roostFullAccessAllowsWithoutAsking({
          ...plan,
          toolName: "Bash",
          toolInput: { command: "echo after > target.txt" },
        }),
      );
    });

    it("keeps asking for MCP tools in Supervised Plan", () => {
      assert.isFalse(
        roostFullAccessAllowsWithoutAsking({
          ...plan,
          runtimeMode: "approval-required",
          installPermissionCallback: true,
          toolName: "mcp__cardwall__card_update",
          toolInput: {},
        }),
      );
    });
  });
});
