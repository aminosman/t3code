import { createFileRoute } from "@tanstack/react-router";

import { MeetingsHome } from "~/components/meetings/MeetingsHome";

export const Route = createFileRoute("/_chat/meetings/")({
  component: MeetingsHome,
});
