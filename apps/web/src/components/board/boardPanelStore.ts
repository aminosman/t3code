// Where the Board tab of the right panel is looking. One for the whole app,
// not per thread, so the board stays put while the chat beside it changes.
import { create } from "zustand";

import type { BoardSearch } from "./BoardView";

interface BoardPanelState {
  /** "follow": the project of the chat beside it. */
  readonly scope: "follow" | BoardSearch;
  readonly setScope: (scope: "follow" | BoardSearch) => void;
}

export const useBoardPanelStore = create<BoardPanelState>()((set) => ({
  scope: "follow",
  setScope: (scope) => set({ scope }),
}));
