/**
 * Roost: Full access never stops to ask. While the CLI is in bypass, its own safety checks are
 * answered here; an ask rule someone wrote still asks, and so does a settings downgrade. In Plan
 * mode, MCP tools and Claude's own plan file go through; other writes still wait for the plan.
 */

const CLAUDE_FILE_WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/** `~/.claude/plans/x.md`, `~/.claude-t3/a/plans/x.md`: where Claude keeps the plan it is writing. */
const CLAUDE_PLAN_FILE = /\/\.claude[^/]*\/(?:[^/]+\/)?plans\/[^/]+\.md$/;

export interface RoostFullAccessAsk {
  readonly permissionMode: string;
  readonly runtimeMode: string | undefined;
  /** True when the thread's policy asks for approvals itself (Supervised, a bypass downgrade). */
  readonly installPermissionCallback: boolean;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly matchedAskRule: unknown;
}

export function roostFullAccessAllowsWithoutAsking(ask: RoostFullAccessAsk): boolean {
  if (ask.matchedAskRule !== undefined && ask.matchedAskRule !== null) return false;
  if (ask.permissionMode === "bypassPermissions") {
    // A Plan-mode query restored to bypass after its plan still installs the callback.
    return !ask.installPermissionCallback || ask.runtimeMode === "full-access";
  }
  if (ask.permissionMode === "plan" && ask.runtimeMode === "full-access") {
    if (ask.toolName.startsWith("mcp__")) return true;
    if (CLAUDE_FILE_WRITE_TOOLS.has(ask.toolName)) {
      const filePath = ask.toolInput.file_path;
      return typeof filePath === "string" && CLAUDE_PLAN_FILE.test(filePath);
    }
  }
  return false;
}
