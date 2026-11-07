import { createFileRoute } from "@tanstack/react-router";

import { BoardPage, type BoardSearch } from "~/components/board/BoardPage";

export const Route = createFileRoute("/_chat/board")({
  validateSearch: (raw: Record<string, unknown>): BoardSearch => ({
    ...(typeof raw.project === "string" && raw.project.length > 0 ? { project: raw.project } : {}),
    ...(typeof raw.thread === "string" && raw.thread.length > 0 ? { thread: raw.thread } : {}),
  }),
  component: BoardPage,
});
