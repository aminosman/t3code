// Roost's ways onto the card wall: a sidebar entry beside Meetings, a button
// in a thread's header that opens the Board tab beside the chat, and a
// button on each sidebar project that opens that project's board.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { KanbanSquareIcon } from "lucide-react";
import { memo, useEffect } from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { resolveThreadRouteRef } from "~/threadRoutes";

import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useBoardPanelStore } from "./boardPanelStore";

export const SidebarBoardEntry = memo(function SidebarBoardEntry() {
  const { isMobile, setOpenMobile } = useSidebar();
  const onBoard = useLocation({ select: (current) => current.pathname === "/board" });
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={onBoard}
          render={<Link to="/board" search={{}} />}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <KanbanSquareIcon />
          <span className="flex-1 truncate">Board</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});

/** Whether this thread's right panel is open on the Board tab. */
function boardShownFor(ref: ScopedThreadRef | null): boolean {
  if (ref === null) return false;
  const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  return state.isOpen && state.activeSurfaceId === "board";
}

type AppRouter = ReturnType<typeof useRouter>;

const routeThreadRef = (router: AppRouter) =>
  resolveThreadRouteRef(router.state.matches[router.state.matches.length - 1]?.params ?? {});

let followingRouter: AppRouter | null = null;

/**
 * The board stays beside the chat: a chat opened while the one left showed the
 * Board tab opens with it too (right-panel tabs are kept per thread). Follows
 * the router, once for the app, since chat views can stay mounted.
 */
function useBoardFollowsChat() {
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes once to the router to carry the Board tab from the chat left to the chat opened
  useEffect(() => {
    if (followingRouter === router) return;
    followingRouter = router;
    let previous = routeThreadRef(router);
    router.subscribe("onResolved", () => {
      const next = routeThreadRef(router);
      if (next === null) return;
      if (
        previous !== null &&
        previous.threadId !== next.threadId &&
        boardShownFor(previous) &&
        !boardShownFor(next)
      ) {
        useRightPanelStore.getState().open(next, "board");
      }
      previous = next;
    });
  }, [router]);
}

export function ThreadBoardButton({ threadRef }: { threadRef: ScopedThreadRef }) {
  useBoardFollowsChat();
  const shown = useRightPanelStore((state) => {
    const panel = selectThreadRightPanelState(state.byThreadKey, threadRef);
    return panel.isOpen && panel.activeSurfaceId === "board";
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Board beside this chat"
            aria-pressed={shown}
            onClick={() => {
              const store = useRightPanelStore.getState();
              if (shown) store.close(threadRef);
              else store.open(threadRef, "board");
            }}
          />
        }
      >
        <KanbanSquareIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="top">{shown ? "Hide the board" : "Board beside this chat"}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Opens one project's board: in the Board tab beside the chat when a chat is
 * open, else as the full page.
 */
function useOpenProjectBoard() {
  const router = useRouter();
  const navigate = useNavigate();
  return (projectId: string) => {
    const ref = routeThreadRef(router);
    if (ref !== null) {
      useBoardPanelStore.getState().setScope({ project: projectId });
      useRightPanelStore.getState().open(ref, "board");
      return;
    }
    void navigate({ to: "/board", search: { project: projectId } });
  };
}

/** The board icon a sidebar project shows on hover, beside its compose icon. */
export function ProjectBoardButton({
  projectId,
  projectName,
  className,
  rowId,
}: {
  projectId: string;
  projectName: string;
  /** A plain button with these classes; without it, the ghost icon Button. */
  className?: string;
  rowId?: string;
}) {
  const openProjectBoard = useOpenProjectBoard();
  const onClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    openProjectBoard(projectId);
  };
  const label = `Board for ${projectName}`;
  const actionFor = rowId === undefined ? {} : { "data-sidebar-action-for": rowId };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          className === undefined ? (
            <Button
              {...actionFor}
              size="icon-xs"
              variant="ghost-muted"
              aria-label={label}
              onClick={onClick}
            />
          ) : (
            <button
              type="button"
              {...actionFor}
              aria-label={label}
              className={className}
              onClick={onClick}
            />
          )
        }
      >
        <KanbanSquareIcon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">Board</TooltipPopup>
    </Tooltip>
  );
}
