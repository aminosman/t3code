/**
 * Answers a thread from its notification, without opening the app.
 *
 * The phone posts what the user did on the lock screen: typed a reply, or
 * tapped Approve or Decline. A reply to a question the thread is still
 * waiting on answers it; any other reply is a new message, queued behind
 * whatever the thread is doing. The phone's reply id becomes the command id,
 * so a reply retried after a dropped connection is applied once.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type PushReply,
  type PushReplyResult,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { PendingRequestItem } from "./threadNotification.ts";

export class PushReplyError extends Data.TaggedError("PushReplyError")<{
  /** HTTP status the route answers with. */
  readonly status: 404 | 409 | 422 | 502;
  readonly message: string;
}> {}

export type PushReplyPlan =
  | { readonly type: "decide"; readonly decision: "accept" | "decline" }
  | { readonly type: "answer"; readonly answers: Record<string, string> }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "reject"; readonly status: 409 | 422; readonly message: string };

/** What a notification action does to the thread as it is now. */
export function planPushReply(input: {
  readonly reply: PushReply;
  readonly thread: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest">;
  readonly pending: PendingRequestItem | null;
}): PushReplyPlan {
  const { reply, thread, pending } = input;
  const stillPending =
    reply.requestId !== undefined && thread.pendingRuntimeRequest?.id === reply.requestId;

  if (reply.action === "approve" || reply.action === "decline") {
    if (!stillPending) {
      return { type: "reject", status: 409, message: "That request was already answered." };
    }
    return { type: "decide", decision: reply.action === "approve" ? "accept" : "decline" };
  }

  const text = reply.text?.trim() ?? "";
  if (text.length === 0) {
    return { type: "reject", status: 422, message: "The reply was empty." };
  }
  if (stillPending && pending?.type === "user_input_request" && pending.questions.length === 1) {
    const [question] = pending.questions;
    if (question !== undefined && question.allowCustomAnswer !== false) {
      return { type: "answer", answers: { [question.id]: text } };
    }
  }
  return { type: "send", text };
}

export const replyFromNotification = Effect.fn("PushReply.replyFromNotification")(function* (
  reply: PushReply,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const thread = yield* threads
    .getThreadShell(reply.threadId)
    .pipe(
      Effect.mapError(
        (cause) =>
          new PushReplyError({ status: 502, message: `Could not read the thread: ${cause}` }),
      ),
    );
  if (thread === null || thread.archivedAt !== null) {
    return yield* new PushReplyError({ status: 404, message: "That thread is gone or archived." });
  }

  const pendingId = thread.pendingRuntimeRequest?.id;
  const pending =
    pendingId !== undefined && pendingId === reply.requestId
      ? yield* threads
          .getProjectThreadRecords(
            { projectId: thread.projectId, threadId: thread.id },
            ["turnItems"],
            { turnItemTypes: ["user_input_request"] },
          )
          .pipe(
            Effect.map(
              (records) =>
                (records.turnItems.find(
                  (item) => item.type === "user_input_request" && item.requestId === pendingId,
                ) ?? null) as PendingRequestItem | null,
            ),
            Effect.orElseSucceed(() => null),
          )
      : null;

  const plan = planPushReply({ reply, thread, pending });
  const commandId = CommandId.make(`push-reply:${reply.replyId}`);
  const failed = (cause: unknown) =>
    new PushReplyError({ status: 502, message: `The thread did not take it: ${String(cause)}` });

  switch (plan.type) {
    case "reject":
      return yield* new PushReplyError({ status: plan.status, message: plan.message });
    case "decide":
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId,
          threadId: thread.id,
          requestId: RuntimeRequestId.make(reply.requestId!),
          decision: plan.decision,
        })
        .pipe(Effect.mapError(failed));
      return {
        delivery: plan.decision === "accept" ? "approved" : "declined",
      } satisfies PushReplyResult;
    case "answer":
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId,
          threadId: thread.id,
          requestId: RuntimeRequestId.make(reply.requestId!),
          answers: plan.answers,
        })
        .pipe(Effect.mapError(failed));
      return { delivery: "answered" } satisfies PushReplyResult;
    case "send":
      yield* threads
        .sendToThread({
          projectId: thread.projectId,
          commandId,
          threadId: thread.id,
          messageId: MessageId.make(`push-reply:${reply.replyId}`),
          text: plan.text,
          attachments: [],
          // Behind a run still going, never steering it.
          mode: "queue",
          createdBy: "user",
          creationSource: "mobile",
        })
        .pipe(Effect.mapError(failed));
      return { delivery: "sent" } satisfies PushReplyResult;
  }
});
