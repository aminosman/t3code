/**
 * Reply, Approve and Decline on a thread's notification, without opening the app.
 *
 * iOS hands the action to the app in the background (launching it when it
 * was not running). The answer goes to the environment over plain HTTP, which
 * needs only the saved connection, not a socket. On a cold launch even that
 * takes a moment to restore, so an answer is held and retried briefly; one
 * that cannot go is said in a local notification that opens the thread.
 */
import {
  EnvironmentId,
  PUSH_APPROVE_ACTION,
  PUSH_DECLINE_ACTION,
  PUSH_REPLY_ACTION,
  PUSH_THREAD_APPROVAL_CATEGORY,
  PUSH_THREAD_REPLY_CATEGORY,
  type PushReply,
  ThreadId,
} from "@t3tools/contracts";
import { sendPushReply } from "@t3tools/client-runtime/state/pushHttp";
import * as Option from "effect/Option";
import * as Notifications from "expo-notifications";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";

export interface ThreadNotificationAnswer {
  readonly environmentId: string;
  readonly reply: PushReply;
}

type Outcome = "delivered" | "retry" | { readonly refused: string };

/** iOS keeps a backgrounded app awake only briefly; past this, say so instead. */
const ANSWER_TTL_MS = 25_000;
const RETRY_MS = 1_500;

const held: Array<ThreadNotificationAnswer & { readonly heldAt: number }> = [];
const seen = new Set<string>();
let retry: ReturnType<typeof setTimeout> | null = null;

function dataOf(response: Notifications.NotificationResponse): Record<string, unknown> {
  const data = response.notification.request.content.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

/** The answer a notification action carries, or null for a plain tap. */
export function threadAnswerFromResponse(
  response: Notifications.NotificationResponse,
): ThreadNotificationAnswer | null {
  const action =
    response.actionIdentifier === PUSH_REPLY_ACTION
      ? "reply"
      : response.actionIdentifier === PUSH_APPROVE_ACTION
        ? "approve"
        : response.actionIdentifier === PUSH_DECLINE_ACTION
          ? "decline"
          : null;
  if (action === null) return null;
  const data = dataOf(response);
  const environmentId = text(data.environmentId);
  const threadId = text(data.threadId);
  if (environmentId === null || threadId === null) return null;
  const typed = response.userText?.trim() ?? "";
  if (action === "reply" && typed.length === 0) return null;
  const requestId = text(data.requestId);
  return {
    environmentId,
    reply: {
      threadId: ThreadId.make(threadId),
      action,
      ...(action === "reply" ? { text: typed } : {}),
      ...(requestId ? { requestId } : {}),
      // The same notification and button is the same answer, however often
      // iOS or a cold launch hands it over.
      replyId: `${response.notification.request.identifier}:${response.actionIdentifier}`,
    },
  };
}

async function send(answer: ThreadNotificationAnswer): Promise<Outcome> {
  const prepared = Option.getOrNull(
    appAtomRegistry.get(
      environmentSession.preparedConnectionValueAtom(EnvironmentId.make(answer.environmentId)),
    ),
  );
  // The saved connection is still being restored after a cold launch.
  if (!prepared) return "retry";
  return runtime
    .runPromise(sendPushReply({ prepared, signer: Option.none(), reply: answer.reply }))
    .then(
      (): Outcome => "delivered",
      (error: { readonly status?: number; readonly message?: string }): Outcome =>
        // The environment heard it and said no (already answered, thread
        // gone): retrying cannot help. Anything else may be the network.
        error.status !== undefined && error.status >= 400 && error.status < 500
          ? { refused: error.message ?? "The thread did not take it." }
          : "retry",
    );
}

async function tellNotSent(answer: ThreadNotificationAnswer, why: string): Promise<void> {
  const what =
    answer.reply.action === "reply"
      ? `“${answer.reply.text}”`
      : answer.reply.action === "approve"
        ? "Approval"
        : "Decline";
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Not sent",
      body: `${what}: ${why} Tap to open the thread.`,
      data: { environmentId: answer.environmentId, threadId: answer.reply.threadId },
    },
    trigger: null,
  }).catch(() => undefined);
}

async function flush(): Promise<void> {
  retry = null;
  const now = Date.now();
  for (const answer of held.splice(0)) {
    const outcome = await send(answer).catch((): Outcome => "retry");
    if (outcome === "delivered") continue;
    if (outcome === "retry") {
      if (now - answer.heldAt < ANSWER_TTL_MS) held.push(answer);
      else await tellNotSent(answer, "the environment could not be reached.");
      continue;
    }
    await tellNotSent(answer, outcome.refused);
  }
  if (held.length > 0 && retry === null) retry = setTimeout(() => void flush(), RETRY_MS);
}

/** Called for every notification response; true when it was a thread action. */
export function routeThreadNotificationAnswer(
  response: Notifications.NotificationResponse,
): boolean {
  const answer = threadAnswerFromResponse(response);
  if (answer === null) return false;
  if (seen.has(answer.reply.replyId)) return true;
  seen.add(answer.reply.replyId);
  held.push({ ...answer, heldAt: Date.now() });
  void flush();
  return true;
}

let registered = false;

/** The buttons iOS shows on a thread's notification. */
export async function registerThreadNotificationCategories(): Promise<void> {
  if (registered) return;
  registered = true;
  try {
    const reply: Notifications.NotificationAction = {
      identifier: PUSH_REPLY_ACTION,
      buttonTitle: "Reply",
      textInput: { submitButtonTitle: "Send", placeholder: "Reply to the agent" },
      options: { opensAppToForeground: false },
    };
    await Notifications.setNotificationCategoryAsync(PUSH_THREAD_REPLY_CATEGORY, [reply]);
    await Notifications.setNotificationCategoryAsync(PUSH_THREAD_APPROVAL_CATEGORY, [
      {
        identifier: PUSH_APPROVE_ACTION,
        buttonTitle: "Approve",
        // Approving runs something on the Mac: not from a locked phone.
        options: { opensAppToForeground: false, isAuthenticationRequired: true },
      },
      {
        identifier: PUSH_DECLINE_ACTION,
        buttonTitle: "Decline",
        options: { opensAppToForeground: false, isDestructive: true },
      },
    ]);
  } catch {
    registered = false;
  }
}
