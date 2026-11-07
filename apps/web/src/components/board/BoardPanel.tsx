// The board as a right-panel tab, beside the chat. Clicking a card opens that
// chat with the board still beside it; opening a chat marks its card.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useBoardPanelStore } from "./boardPanelStore";
import { BoardView, type BoardSearch } from "./BoardView";

export function BoardPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const thread = useThreadShell(threadRef);
  const scope = useBoardPanelStore((state) => state.scope);
  const setScope = useBoardPanelStore((state) => state.setScope);
  const following = scope === "follow";
  const search: BoardSearch = following
    ? thread === null
      ? {}
      : { project: thread.projectId }
    : scope;

  const openCard = (target: { readonly environmentId: string; readonly id: string }) => {
    const ref = scopeThreadRef(target.environmentId as EnvironmentId, target.id as ThreadId);
    // The chat opens with the board still beside it.
    useRightPanelStore.getState().open(ref, "board");
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: target.environmentId, threadId: target.id },
    });
  };

  return (
    <BoardView
      variant="panel"
      search={search}
      focusThreadId={threadRef.threadId}
      follow={{ active: following, onFollow: () => setScope("follow") }}
      onScopeChange={setScope}
      onOpenCard={openCard}
      controls={
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="board-icon-button board-bar-button"
                aria-label="Open the full board"
                onClick={() => void navigate({ to: "/board", search })}
              />
            }
          >
            <Maximize2Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open the full board</TooltipPopup>
        </Tooltip>
      }
    />
  );
}
