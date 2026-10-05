import { create } from "zustand";

export {
  flattenOwnedThreads,
  groupOwnedThreads,
  isLiveThread,
  ownerThreadId,
  type OwnedThreadRow,
} from "@t3tools/client-runtime/state/ownedThreads";

/** Which owners the user opened or closed by hand; not kept across restarts. */
export const useOwnedThreadExpansionStore = create<{
  expandedByThreadId: Readonly<Record<string, boolean>>;
  setExpanded: (threadId: string, expanded: boolean) => void;
}>((set) => ({
  expandedByThreadId: {},
  setExpanded: (threadId, expanded) =>
    set((state) => ({
      expandedByThreadId: { ...state.expandedByThreadId, [threadId]: expanded },
    })),
}));
