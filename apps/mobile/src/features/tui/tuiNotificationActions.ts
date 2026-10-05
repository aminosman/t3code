import {
  TUI_INBOX_PROMPT_ALLOW_ACTION,
  TUI_INBOX_PROMPT_CATEGORY,
  TUI_INBOX_PROMPT_DECLINE_ACTION,
} from "@t3tools/contracts";
import * as Notifications from "expo-notifications";

/**
 * Allow / Decline on a tui card's push, from the lock screen.
 *
 * The response can arrive before the environment that sent it has
 * reconnected (a cold launch from the notification), so an answer is held
 * until the tui screen's handler is registered, then sent once.
 */
export interface TuiNotificationAnswer {
  readonly environmentId: string;
  readonly promptId: string;
  readonly verdict: "up" | "down";
}

/** Resolves true once the answer reached the environment. */
type Handler = (answer: TuiNotificationAnswer) => Promise<boolean>;

let handler: Handler | null = null;
const held: Array<TuiNotificationAnswer & { readonly heldAt: number }> = [];
/** tui waits three minutes for a card from the phone; no point trying longer. */
const ANSWER_TTL_MS = 3 * 60 * 1000;
let retry: ReturnType<typeof setTimeout> | null = null;

/**
 * Sends what is held, keeping what did not go: on a cold launch from the
 * notification the environment's socket is still coming up, and the first
 * attempts fail.
 */
async function flush(): Promise<void> {
  retry = null;
  const current = handler;
  if (!current) return;
  const now = Date.now();
  const pending = held.splice(0).filter((answer) => now - answer.heldAt < ANSWER_TTL_MS);
  for (const answer of pending) {
    const delivered = await current(answer).catch(() => false);
    if (!delivered) held.push(answer);
  }
  if (held.length > 0 && retry === null) retry = setTimeout(() => void flush(), 2000);
}

function dataOf(response: Notifications.NotificationResponse): Record<string, unknown> {
  const data = response.notification.request.content.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/** The answer a notification response carries, or null when it is not one. */
export function tuiAnswerFromResponse(
  response: Notifications.NotificationResponse,
): TuiNotificationAnswer | null {
  const verdict =
    response.actionIdentifier === TUI_INBOX_PROMPT_ALLOW_ACTION
      ? "up"
      : response.actionIdentifier === TUI_INBOX_PROMPT_DECLINE_ACTION
        ? "down"
        : null;
  if (verdict === null) return null;
  const data = dataOf(response);
  const promptId = data.tuiPromptId;
  const environmentId = data.environmentId;
  if (typeof promptId !== "string" || typeof environmentId !== "string") return null;
  return { environmentId, promptId, verdict };
}

/** Called for every notification response; true when it was a tui answer. */
export function routeTuiNotificationAnswer(response: Notifications.NotificationResponse): boolean {
  const answer = tuiAnswerFromResponse(response);
  if (answer === null) return false;
  if (!held.some((h) => h.promptId === answer.promptId))
    held.push({ ...answer, heldAt: Date.now() });
  void flush();
  return true;
}

export function setTuiNotificationAnswerHandler(next: Handler | null): void {
  handler = next;
  if (next) void flush();
}

let registered = false;

/** The Allow / Decline buttons iOS shows on a tui card's push. */
export async function registerTuiNotificationCategory(): Promise<void> {
  if (registered) return;
  registered = true;
  try {
    await Notifications.setNotificationCategoryAsync(TUI_INBOX_PROMPT_CATEGORY, [
      {
        identifier: TUI_INBOX_PROMPT_ALLOW_ACTION,
        buttonTitle: "Allow",
        // Opens Roost so the answer goes out on a live connection and the
        // run can be watched; a background launch may not get a socket up.
        options: { opensAppToForeground: true, isAuthenticationRequired: true },
      },
      {
        identifier: TUI_INBOX_PROMPT_DECLINE_ACTION,
        buttonTitle: "Decline",
        options: { opensAppToForeground: true, isDestructive: true },
      },
    ]);
  } catch {
    registered = false;
  }
}

export function tuiDeepLink(environmentId: string): string {
  return `/tui/${encodeURIComponent(environmentId)}`;
}
