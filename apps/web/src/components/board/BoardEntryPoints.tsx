// Roost's ways onto the card wall: a sidebar entry beside Meetings, and a
// button in a thread's header that opens that thread's own board.
import type { ThreadId } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { KanbanSquareIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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

export function ThreadBoardButton({ threadId }: { threadId: ThreadId }) {
  const navigate = useNavigate();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Open this thread's board"
            onClick={() => void navigate({ to: "/board", search: { thread: threadId } })}
          />
        }
      >
        <KanbanSquareIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="top">This thread's board</TooltipPopup>
    </Tooltip>
  );
}
