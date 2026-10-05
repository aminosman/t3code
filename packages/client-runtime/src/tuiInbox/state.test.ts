import { describe, expect, it } from "vite-plus/test";

import { EMPTY_TUI_INBOX, reduceTuiInbox } from "./state.ts";

const at = "2026-10-05T12:00:00.000Z";

describe("reduceTuiInbox", () => {
  it("tracks a card until it settles and a run until it ends", () => {
    let state = reduceTuiInbox(EMPTY_TUI_INBOX, {
      type: "snapshot",
      hostConnected: true,
      entries: [
        { id: "1", at, from: "me", utterance: { id: "u1", text: "print it", voice: false } },
      ],
    });
    expect(state.busy).toBe(true);
    state = reduceTuiInbox(state, {
      type: "entry",
      entry: { id: "2", at, from: "tui", post: { type: "prompt", promptId: "p1", text: "Go?" } },
    });
    expect(state.openPrompts.map((prompt) => prompt.promptId)).toEqual(["p1"]);
    state = reduceTuiInbox(state, {
      type: "entry",
      entry: { id: "3", at, from: "tui", post: { type: "settled", promptId: "p1", outcome: "up" } },
    });
    state = reduceTuiInbox(state, {
      type: "entry",
      entry: { id: "4", at, from: "tui", post: { type: "hands", phase: "start", text: "Print" } },
    });
    state = reduceTuiInbox(state, {
      type: "entry",
      entry: { id: "5", at, from: "tui", post: { type: "hands", phase: "step", text: "1. click" } },
    });
    expect(state.openPrompts).toEqual([]);
    expect(state.running).toEqual({ goal: "Print", step: "1. click" });
    state = reduceTuiInbox(state, {
      type: "entry",
      entry: { id: "6", at, from: "tui", post: { type: "hands", phase: "end", text: "Printed" } },
    });
    state = reduceTuiInbox(state, {
      type: "entry",
      entry: { id: "7", at, from: "tui", post: { type: "done", utteranceId: "u1" } },
    });
    expect(state.running).toBeNull();
    expect(state.busy).toBe(false);
  });

  it("appends an entry once and forgets busy when tui goes away", () => {
    const entry = {
      id: "1",
      at,
      from: "me" as const,
      utterance: { id: "u1", text: "hi", voice: false },
    };
    let state = reduceTuiInbox(EMPTY_TUI_INBOX, { type: "host", connected: true });
    state = reduceTuiInbox(state, { type: "entry", entry });
    state = reduceTuiInbox(state, { type: "entry", entry });
    expect(state.entries).toHaveLength(1);
    expect(state.busy).toBe(true);
    state = reduceTuiInbox(state, { type: "host", connected: false });
    expect(state.busy).toBe(false);
  });
});
