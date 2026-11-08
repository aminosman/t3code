// The back of a card, as Trello has it: where the work stands, whose move it
// is, its reviews and approval request, and the comments between the user and
// the thread's agent. Handing the card to the agent sends it the comments.
import {
  BOARD_REVIEWS_WANTED,
  type BoardApproval,
  type BoardCard,
  type BoardColumn,
  type BoardSummary,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { BotIcon, MessageSquareIcon, UserIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { BranchChanges } from "./BranchChanges";
import { CardChecks } from "./CardChecks";
import { boardEnvironment } from "./boardAtoms";

const when = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};

export function CardBack({
  environmentId,
  thread,
  projectTitle,
  card,
  column,
  summary,
  approval,
  approvalColumnTitle,
  pullRequests,
  columns,
  onClose,
  onOpenThread,
  onViewDiff,
  onDecide,
  onUpdate,
}: {
  environmentId: EnvironmentId;
  thread: { readonly id: string; readonly title: string };
  projectTitle: string | null;
  card: BoardCard | undefined;
  column: BoardColumn | undefined;
  summary: BoardSummary | undefined;
  approval: BoardApproval | undefined;
  /** The title of the column the approval request is for. */
  approvalColumnTitle: string | undefined;
  pullRequests: ReadonlyArray<{ readonly url: string; readonly number: number }>;
  columns: ReadonlyArray<BoardColumn>;
  onClose: () => void;
  onOpenThread: () => void;
  onViewDiff: () => void;
  onDecide: (approve: boolean) => void;
  onUpdate: (change: {
    readonly comment?: string;
    readonly assignee?: "agent" | "user";
  }) => Promise<boolean>;
}) {
  const comments = useEnvironmentQuery(
    boardEnvironment.boardComments({ environmentId, input: { threadId: thread.id as ThreadId } }),
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const assignee = card?.assignee ?? "agent";

  const send = async (change: {
    readonly comment?: string;
    readonly assignee?: "agent" | "user";
  }) => {
    setSending(true);
    const done = await onUpdate(change);
    setSending(false);
    if (done) {
      setDraft("");
      comments.refresh();
    }
  };
  const comment = draft.trim();

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-h-[88dvh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{thread.title}</DialogTitle>
          <DialogDescription>
            {projectTitle ?? "No project"} · in <strong>{column?.title ?? "no column"}</strong>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-5">
            <section className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Assigned to</span>
              <div className="inline-flex rounded-md border border-border p-0.5">
                <button
                  type="button"
                  className="card-back-segment"
                  data-on={assignee === "agent" ? "" : undefined}
                  disabled={sending}
                  onClick={() =>
                    assignee === "agent" ? undefined : void send({ assignee: "agent" })
                  }
                >
                  <BotIcon className="size-3.5" /> Agent
                </button>
                <button
                  type="button"
                  className="card-back-segment"
                  data-on={assignee === "user" ? "" : undefined}
                  disabled={sending}
                  onClick={() =>
                    assignee === "user" ? undefined : void send({ assignee: "user" })
                  }
                >
                  <UserIcon className="size-3.5" /> You
                </button>
              </div>
              <Button size="sm" variant="outline" className="ml-auto" onClick={onOpenThread}>
                Open chat
              </Button>
            </section>

            {approval !== undefined ? (
              <section className="board-approval">
                <p>
                  Asks to move to <strong>{approvalColumnTitle ?? approval.stage}</strong>
                  {approval.note ? `: ${approval.note}` : ""}
                </p>
                <div className="board-approval-actions">
                  <button
                    type="button"
                    className="board-approval-button"
                    data-tone="approve"
                    onClick={() => onDecide(true)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="board-approval-button"
                    onClick={() => onDecide(false)}
                  >
                    Decline
                  </button>
                </div>
              </section>
            ) : null}

            <section className="grid gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Where it stands</h3>
              <p className="text-sm">{summary?.summary || "No summary yet."}</p>
              {summary?.next ? <p className="text-sm font-medium">Next: {summary.next}</p> : null}
              {summary?.reviewedBy != null ? (
                <p className="text-xs text-muted-foreground">
                  Reviews {summary.reviewedBy.length}/{BOARD_REVIEWS_WANTED}
                  {summary.reviewedBy.length > 0 ? `: ${summary.reviewedBy.join(", ")}` : ""}
                </p>
              ) : null}
            </section>

            <section className="grid gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Checks</h3>
              <CardChecks
                environmentId={environmentId}
                threadId={thread.id}
                columns={columns}
                currentStage={column?.id ?? ""}
                summary={summary}
              />
            </section>

            <section className="grid gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Changes</h3>
              <BranchChanges
                environmentId={environmentId}
                threadId={thread.id}
                pullRequests={pullRequests}
                onViewDiff={onViewDiff}
              />
            </section>

            <section className="grid gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MessageSquareIcon className="size-3.5" /> Comments
              </h3>
              <ol className="grid gap-2">
                {(comments.data?.comments ?? []).map((entry) => (
                  <li key={entry.id} className="card-back-comment" data-author={entry.author}>
                    <span className="card-back-comment-head">
                      {entry.author === "agent" ? (
                        <BotIcon className="size-3.5" />
                      ) : (
                        <UserIcon className="size-3.5" />
                      )}
                      {entry.author === "agent" ? "Agent" : "You"}
                      <span className="text-muted-foreground">{when(entry.createdAt)}</span>
                    </span>
                    <span className="whitespace-pre-wrap">{entry.body}</span>
                  </li>
                ))}
                {comments.data?.comments.length === 0 ? (
                  <li className="text-sm text-muted-foreground">No comments yet.</li>
                ) : null}
              </ol>
              <Textarea
                aria-label="Write a comment"
                placeholder="Write a comment"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sending || comment.length === 0}
                  onClick={() => void send({ comment })}
                >
                  Comment
                </Button>
                <Button
                  size="sm"
                  disabled={sending || (comment.length === 0 && assignee === "agent")}
                  onClick={() =>
                    void send(
                      comment.length > 0 ? { comment, assignee: "agent" } : { assignee: "agent" },
                    )
                  }
                >
                  {comment.length > 0 ? "Comment & hand to agent" : "Hand to agent"}
                </Button>
              </div>
            </section>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
