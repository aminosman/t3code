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

type Handler = (answer: TuiNotificationAnswer) => void;

let handler: Handler | null = null;
const held: TuiNotificationAnswer[] = [];

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
  if (handler) handler(answer);
  else held.push(answer);
  return true;
}

export function setTuiNotificationAnswerHandler(next: Handler | null): void {
  handler = next;
  if (!next) return;
  for (const answer of held.splice(0)) next(answer);
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
