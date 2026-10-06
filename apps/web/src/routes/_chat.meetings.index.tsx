import { createFileRoute } from "@tanstack/react-router";

import { MeetingsHome } from "~/components/meetings/MeetingsHome";

export interface MeetingsHomeSearch {
  /** The chat open in the panel: a thread id, or "new" for a chat not yet asked. */
  readonly chat?: string;
}

export const Route = createFileRoute("/_chat/meetings/")({
  validateSearch: (raw: Record<string, unknown>): MeetingsHomeSearch =>
    typeof raw.chat === "string" && raw.chat.length > 0 ? { chat: raw.chat } : {},
  component: MeetingsHome,
});
