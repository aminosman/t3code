import type {
  TuiScreenEvent,
  TuiScreenFrame,
  TuiScreenRequest,
  TuiScreenStatus,
} from "@t3tools/contracts";

/**
 * The phone's view of the Mac's screen, folded from the `tuiScreen.subscribe`
 * stream: whether tui is there, why there is no picture when there is none,
 * the newest frame, and the asks agents are waiting on.
 */
export interface TuiScreenState {
  readonly hostConnected: boolean;
  readonly status: TuiScreenStatus;
  readonly frame: TuiScreenFrame | null;
  readonly requests: ReadonlyArray<TuiScreenRequest>;
}

export const EMPTY_TUI_SCREEN: TuiScreenState = {
  hostConnected: false,
  status: { state: "idle" },
  frame: null,
  requests: [],
};

export function reduceTuiScreen(state: TuiScreenState, event: TuiScreenEvent): TuiScreenState {
  switch (event.type) {
    case "host":
      return {
        ...state,
        hostConnected: event.connected,
        status: event.status ?? { state: "idle" },
        frame: event.connected ? state.frame : null,
      };
    case "status":
      return {
        ...state,
        status: event.status,
        frame: event.status.state === "capturing" ? state.frame : null,
      };
    case "frame":
      if (state.frame && event.frame.seq < state.frame.seq) return state;
      return { ...state, status: { state: "capturing" }, frame: event.frame };
    case "requests":
      return { ...state, requests: event.requests };
  }
}
