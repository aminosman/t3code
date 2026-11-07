// The card wall's turn-end check for providers that can block a stop (Claude's
// Stop hook): a turn the agent ends without updating its card is sent back
// once to do it. The board registers the check; adapters only ask it.
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

type StopCheck = (threadId: string) => Promise<string | null>;

let check: StopCheck | null = null;

/** The board's check: the reason to keep the turn going, or null to let it end. */
export function setBoardStopCheck(next: StopCheck | null): void {
  check = next;
}

/** A Stop hook for this thread, or undefined when no board is running. */
export function boardStopHook(threadId: string): HookCallback | undefined {
  if (check === null) return undefined;
  return async (input) => {
    // Asked once per stop: a turn already sent back is let go.
    if (check === null || ("stop_hook_active" in input && input.stop_hook_active)) return {};
    const reason = await check(threadId).catch(() => null);
    return reason === null ? {} : { decision: "block", reason };
  };
}
