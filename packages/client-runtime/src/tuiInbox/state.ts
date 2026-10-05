import type { TuiInboxEntry, TuiInboxEvent, TuiInboxPost } from "@t3tools/contracts";

/**
 * The phone's view of its conversation with tui, folded from the
 * `tuiInbox.subscribe` stream: a snapshot replaces everything (a reconnect
 * starts clean), and each entry is appended once.
 */
export interface TuiInboxState {
  readonly hostConnected: boolean;
  readonly entries: ReadonlyArray<TuiInboxEntry>;
  /** Cards still waiting for ↑ / ↓, newest last. */
  readonly openPrompts: ReadonlyArray<Extract<TuiInboxPost, { type: "prompt" }>>;
  /** The hands run on the Mac, while one is going. */
  readonly running: { readonly goal: string; readonly step: string | null } | null;
  /** Utterances tui has not said done to. */
  readonly busy: boolean;
}

export const EMPTY_TUI_INBOX: TuiInboxState = {
  hostConnected: false,
  entries: [],
  openPrompts: [],
  running: null,
  busy: false,
};

const MAX_ENTRIES = 200;

function derive(hostConnected: boolean, entries: ReadonlyArray<TuiInboxEntry>): TuiInboxState {
  const prompts = new Map<string, Extract<TuiInboxPost, { type: "prompt" }>>();
  let running = null as TuiInboxState["running"];
  const pending = new Set<string>();
  for (const entry of entries) {
    if (entry.from === "me" && entry.utterance) pending.add(entry.utterance.id);
    const post = entry.post;
    if (!post) continue;
    switch (post.type) {
      case "prompt":
        prompts.set(post.promptId, post);
        break;
      case "settled":
        prompts.delete(post.promptId);
        break;
      case "hands":
        running =
          post.phase === "end"
            ? null
            : post.phase === "start"
              ? { goal: post.text, step: null }
              : { goal: (running as TuiInboxState["running"])?.goal ?? "", step: post.text };
        break;
      case "done":
        pending.delete(post.utteranceId);
        break;
      default:
        break;
    }
  }
  return {
    hostConnected,
    entries,
    openPrompts: [...prompts.values()],
    running,
    // A tui that went away is not still working on anything.
    busy: hostConnected && pending.size > 0,
  };
}

export function reduceTuiInbox(state: TuiInboxState, event: TuiInboxEvent): TuiInboxState {
  switch (event.type) {
    case "snapshot":
      return derive(event.hostConnected, event.entries.slice(-MAX_ENTRIES));
    case "host":
      return derive(event.connected, state.entries);
    case "entry": {
      if (state.entries.some((entry) => entry.id === event.entry.id)) return state;
      return derive(state.hostConnected, [...state.entries, event.entry].slice(-MAX_ENTRIES));
    }
  }
}
