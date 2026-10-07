import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-notifications", () => ({
  setNotificationCategoryAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
}));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/session", () => ({ environmentSession: {} }));

import { threadAnswerFromResponse } from "./threadNotificationActions";

const response = (actionIdentifier: string, userText?: string) =>
  ({
    actionIdentifier,
    ...(userText === undefined ? {} : { userText }),
    notification: {
      request: {
        identifier: "n1",
        content: { data: { environmentId: "env-1", threadId: "thread-1", requestId: "req-1" } },
      },
    },
  }) as never;

describe("thread notification answers", () => {
  it("reads a typed reply", () => {
    expect(threadAnswerFromResponse(response("THREAD_REPLY", "  open a PR "))).toEqual({
      environmentId: "env-1",
      reply: {
        threadId: "thread-1",
        action: "reply",
        text: "open a PR",
        requestId: "req-1",
        replyId: "n1:THREAD_REPLY",
      },
    });
  });

  it("reads Approve and Decline", () => {
    expect(threadAnswerFromResponse(response("THREAD_APPROVE"))?.reply.action).toBe("approve");
    expect(threadAnswerFromResponse(response("THREAD_DECLINE"))?.reply.action).toBe("decline");
  });

  it("ignores a plain tap and an empty reply", () => {
    expect(
      threadAnswerFromResponse(response("expo.modules.notifications.actions.DEFAULT")),
    ).toBeNull();
    expect(threadAnswerFromResponse(response("THREAD_REPLY", "   "))).toBeNull();
  });
});
