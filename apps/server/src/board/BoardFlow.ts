// What the user does to a card that the thread's agent has to hear about: an
// approval decided on the board, or a nudge to move the card forward. Each is
// a message into the thread, so the agent picks the work back up.
import type { BoardApproval, BoardAssignee, BoardColumn, BoardComment } from "@t3tools/contracts";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { BoardError, BoardService } from "./BoardService.ts";

export interface BoardFlowShape {
  readonly decide: (input: {
    readonly threadId: string;
    readonly stage: string;
    readonly approve: boolean;
    readonly note: string;
  }) => Effect.Effect<BoardApproval, BoardError>;
  /** Asks each thread to check its card and move it forward; returns how many were told. */
  readonly nudge: (threadIds: ReadonlyArray<string>) => Effect.Effect<number, BoardError>;
  /** The user comments and/or reassigns; handing the card to the agent sends it the comments. */
  readonly card: (input: {
    readonly threadId: string;
    readonly comment?: string | undefined;
    readonly assignee?: BoardAssignee | undefined;
  }) => Effect.Effect<
    { assignee: BoardAssignee; comments: ReadonlyArray<BoardComment>; told: boolean },
    BoardError
  >;
}

export class BoardFlow extends Context.Service<BoardFlow, BoardFlowShape>()("t3/board/BoardFlow") {}

const describe = (column: BoardColumn) =>
  `"${column.title}"${column.description.trim() ? ` (${column.description.trim()})` : ""}`;

function decisionMessage(column: BoardColumn, approve: boolean, note: string): string {
  return approve
    ? `[Card wall] Approved: you may move this work into ${describe(column)}. Do that column's work now, then move the card there with t3_card_update.`
    : `[Card wall] Declined: do not move this work into ${describe(column)}.${note.trim() ? ` The user's reason: ${note.trim()}` : ""} Update the card with t3_card_update to say what happens instead.`;
}

/** The user's comments since the agent last wrote, as the message that hands the card back. */
export function handBackMessage(comments: ReadonlyArray<BoardComment>): string {
  const lastAgent = comments.findLastIndex((entry) => entry.author === "agent");
  const fresh = comments.slice(lastAgent + 1).filter((entry) => entry.author === "user");
  const said = fresh.map((entry) => `- ${entry.body.trim()}`).join("\n");
  return `[Card wall] The user handed this card back to you.${said ? ` Their comments on it:\n${said}\n` : " "}Carry on with the work and keep the card current with t3_card_update.`;
}

const NUDGE_MESSAGE =
  "[Card wall] Check your card with t3_card_update and move the work forward: if the current column's work is done and the next column's requirement is met, do it and move the card. If the next column needs approval, ask for it and stop. If something blocks you, say what in the card's next.";

const make = Effect.gen(function* () {
  const board = yield* BoardService;
  const threads = yield* ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const failed = (cause: unknown) =>
    new BoardError({ reason: cause instanceof Error ? cause.message : String(cause) });

  const send = Effect.fn("BoardFlow.send")(function* (threadId: string, text: string) {
    const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return false;
    yield* threads.sendToThread({
      projectId: shell.projectId,
      commandId: CommandId.make(yield* crypto.randomUUIDv4()),
      threadId: shell.id,
      messageId: MessageId.make(yield* crypto.randomUUIDv4()),
      text,
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
    return true;
  });

  const decide: BoardFlowShape["decide"] = Effect.fn("BoardFlow.decide")(function* ({
    threadId,
    stage,
    approve,
    note,
  }) {
    const column = (yield* board.columns).find((entry) => entry.id === stage);
    if (column === undefined) return yield* new BoardError({ reason: `no column "${stage}"` });
    const approval = yield* board.decideApproval({ threadId, stage, approve, note });
    yield* send(threadId, decisionMessage(column, approve, note));
    return approval;
  }, Effect.mapError(failed));

  const nudge: BoardFlowShape["nudge"] = Effect.fn("BoardFlow.nudge")(function* (threadIds) {
    const told = yield* Effect.forEach([...new Set(threadIds)], (id) => send(id, NUDGE_MESSAGE));
    return told.filter(Boolean).length;
  }, Effect.mapError(failed));

  const card: BoardFlowShape["card"] = Effect.fn("BoardFlow.card")(function* ({
    threadId,
    comment,
    assignee,
  }) {
    if (comment !== undefined && comment.trim().length > 0) {
      yield* board.comment(threadId, "user", comment.trim());
    }
    if (assignee !== undefined) yield* board.assign(threadId, assignee);
    const comments = yield* board.comments(threadId);
    const told = assignee === "agent" ? yield* send(threadId, handBackMessage(comments)) : false;
    const placed = yield* board.card(threadId);
    return { assignee: placed?.assignee ?? "agent", comments, told };
  }, Effect.mapError(failed));

  return BoardFlow.of({ decide, nudge, card });
});

export const layer = Layer.effect(BoardFlow, make);
