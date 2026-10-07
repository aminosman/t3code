import type { PushReply } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { planPushReply } from "./pushReply.ts";

const reply = (overrides: Partial<PushReply>): PushReply =>
  ({ threadId: "thread-1", action: "reply", replyId: "r1", ...overrides }) as PushReply;
const waitingOn = (id: string, kind: "user_input" | "command" = "user_input") =>
  ({ pendingRuntimeRequest: { id, kind, createdAt: new Date() } }) as never;
const idle = { pendingRuntimeRequest: null };
const question = (overrides: object = {}) =>
  ({
    type: "user_input_request",
    requestId: "req-1",
    questions: [{ id: "q1", header: "h", question: "Which?", options: [], ...overrides }],
  }) as never;

describe("planPushReply", () => {
  it("approves the request the notification was about", () => {
    assert.deepEqual(
      planPushReply({
        reply: reply({ action: "approve", requestId: "req-1" }),
        thread: waitingOn("req-1", "command"),
        pending: null,
      }),
      { type: "decide", decision: "accept" },
    );
  });

  it("refuses to approve a request that was already answered", () => {
    const plan = planPushReply({
      reply: reply({ action: "decline", requestId: "req-1" }),
      thread: idle,
      pending: null,
    });
    assert.strictEqual(plan.type, "reject");
  });

  it("answers the one free-text question the thread is waiting on", () => {
    assert.deepEqual(
      planPushReply({
        reply: reply({ text: " main ", requestId: "req-1" }),
        thread: waitingOn("req-1"),
        pending: question(),
      }),
      { type: "answer", answers: { q1: "main" } },
    );
  });

  it("sends a question that takes only options as a message instead", () => {
    assert.deepEqual(
      planPushReply({
        reply: reply({ text: "main", requestId: "req-1" }),
        thread: waitingOn("req-1"),
        pending: question({ allowCustomAnswer: false }),
      }),
      { type: "send", text: "main" },
    );
  });

  it("sends a reply to a finished thread as a new message", () => {
    assert.deepEqual(
      planPushReply({ reply: reply({ text: "now open a PR" }), thread: idle, pending: null }),
      { type: "send", text: "now open a PR" },
    );
  });

  it("refuses an empty reply", () => {
    assert.strictEqual(
      planPushReply({ reply: reply({}), thread: idle, pending: null }).type,
      "reject",
    );
  });
});
