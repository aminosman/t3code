// The full-page board at /board; its scope lives in the URL.
import { useNavigate, useSearch } from "@tanstack/react-router";

import { BoardView, type BoardSearch } from "./BoardView";

export type { BoardSearch };

export function BoardPage() {
  const search = useSearch({ from: "/_chat/board" });
  const navigate = useNavigate();
  return (
    <BoardView
      variant="page"
      search={search}
      onScopeChange={(next) => void navigate({ to: "/board", search: next })}
      onOpenCard={(thread) =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
        })
      }
    />
  );
}
