import type { Notification, NotificationBehavior } from "expo-notifications";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

export function foregroundNotificationBehavior(
  notification: Notification,
  deepLinkOnScreen: string | null,
): NotificationBehavior {
  const target = extractAgentNotificationDeepLink({ notification });
  // The tui screen shows its own conversation live; only a card still buzzes.
  if (
    target !== null &&
    target.startsWith("/tui") &&
    deepLinkOnScreen?.startsWith("/tui") === true &&
    notification.request.content.categoryIdentifier !== "TUI_PROMPT"
  ) {
    return SUPPRESS;
  }
  if (target !== null && target === deepLinkOnScreen) {
    return SUPPRESS;
  }
  return SHOW;
}
