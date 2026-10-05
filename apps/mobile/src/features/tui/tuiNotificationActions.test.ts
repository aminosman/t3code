import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-notifications", () => ({ setNotificationCategoryAsync: vi.fn() }));

import { extractAgentNotificationDeepLink } from "../agent-awareness/notificationPayload";
import {
  routeTuiNotificationAnswer,
  setTuiNotificationAnswerHandler,
  tuiAnswerFromResponse,
} from "./tuiNotificationActions";

const response = (actionIdentifier: string, data: Record<string, unknown>) =>
  ({
    actionIdentifier,
    notification: { request: { identifier: "n1", content: { data } } },
  }) as never;

describe("tui notification answers", () => {
  it("reads Allow and Decline off a tui card's push", () => {
    const data = { tuiPromptId: "p1", environmentId: "env-1", deepLink: "/tui" };
    expect(tuiAnswerFromResponse(response("TUI_ALLOW", data))).toEqual({
      environmentId: "env-1",
      promptId: "p1",
      verdict: "up",
    });
    expect(tuiAnswerFromResponse(response("TUI_DECLINE", data))?.verdict).toBe("down");
    // A plain tap opens the screen and answers nothing.
    expect(
      tuiAnswerFromResponse(response("expo.modules.notifications.actions.DEFAULT", data)),
    ).toBeNull();
  });

  it("holds an answer from a cold launch until the handler is up", () => {
    const answers: unknown[] = [];
    setTuiNotificationAnswerHandler(null);
    routeTuiNotificationAnswer(response("TUI_ALLOW", { tuiPromptId: "p2", environmentId: "e" }));
    expect(answers).toHaveLength(0);
    setTuiNotificationAnswerHandler((answer) => answers.push(answer));
    expect(answers).toEqual([{ environmentId: "e", promptId: "p2", verdict: "up" }]);
    setTuiNotificationAnswerHandler(null);
  });

  it("deep-links a tui push to the tui screen for its environment", () => {
    expect(
      extractAgentNotificationDeepLink(response("x", { deepLink: "/tui", environmentId: "env 1" })),
    ).toBe("/tui/env%201");
  });
});
