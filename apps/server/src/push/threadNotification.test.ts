import {
  PUSH_THREAD_APPROVAL_CATEGORY,
  PUSH_THREAD_REPLY_CATEGORY,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { assert, describe, it } from "@effect/vitest";

import { buildThreadNotification, clip, plainText } from "./threadNotification.ts";

const state = (phase: AgentAwarenessState["phase"]): AgentAwarenessState => ({
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
  projectTitle: "tui",
  threadTitle: "Fix the double push",
  phase,
  headline: "",
  modelTitle: "claude",
  updatedAt: "2026-10-07T00:00:00.000Z",
  deepLink: "/threads/env-1/thread-1",
});

const noError = { lastError: null };

const base = { id: "item-1", status: "pending" } as never as Record<string, never>;

describe("buildThreadNotification", () => {
  it("leads with the thread and ends with what the agent said", () => {
    const notification = buildThreadNotification({
      state: state("completed"),
      thread: noError,
      lastAssistantText: "**Done.** The registry now keeps one entry per `token`.",
      pending: null,
    });
    assert.deepEqual(notification, {
      title: "Fix the double push",
      subtitle: "tui · Finished",
      body: "Done. The registry now keeps one entry per token.",
      category: PUSH_THREAD_REPLY_CATEGORY,
    });
  });

  it("says why a run failed", () => {
    const notification = buildThreadNotification({
      state: state("failed"),
      thread: { lastError: "Usage limit reached" },
      lastAssistantText: null,
      pending: null,
    });
    assert.strictEqual(notification.subtitle, "tui · Failed");
    assert.strictEqual(notification.body, "Usage limit reached");
  });

  it("asks the question, answerable by typing when it takes free text", () => {
    const notification = buildThreadNotification({
      state: state("waiting_for_input"),
      thread: noError,
      lastAssistantText: "ignored",
      pending: {
        ...base,
        type: "user_input_request",
        requestId: "req-1",
        questions: [
          {
            id: "q1",
            header: "Branch",
            question: "Which branch should I use?",
            options: [
              { label: "main", description: "the default" },
              { label: "dev", description: "the other" },
            ],
          },
        ],
      } as never,
    });
    assert.strictEqual(notification.body, "Which branch should I use? main / dev");
    assert.strictEqual(notification.category, PUSH_THREAD_REPLY_CATEGORY);
    assert.strictEqual(notification.requestId, "req-1");
  });

  it("leaves several questions to the app", () => {
    const question = (id: string) => ({ id, header: id, question: `${id}?`, options: [] });
    const notification = buildThreadNotification({
      state: state("waiting_for_input"),
      thread: noError,
      lastAssistantText: "ignored",
      pending: {
        ...base,
        type: "user_input_request",
        requestId: "req-1",
        questions: [question("one"), question("two")],
      } as never,
    });
    assert.strictEqual(notification.body, "one? (+1 more)");
    assert.isUndefined(notification.category);
  });

  it("offers approve and decline for an approval", () => {
    const notification = buildThreadNotification({
      state: state("waiting_for_approval"),
      thread: noError,
      lastAssistantText: "ignored",
      pending: {
        ...base,
        type: "approval_request",
        requestId: "req-2",
        requestKind: "command",
      } as never,
    });
    assert.deepEqual(notification, {
      title: "Fix the double push",
      subtitle: "tui · Needs approval",
      body: "Wants to run a command.",
      category: PUSH_THREAD_APPROVAL_CATEGORY,
      requestId: "req-2",
    });
  });
});

describe("plainText", () => {
  it("drops code blocks, links and list marks", () => {
    assert.strictEqual(
      plainText("## Result\n- see [the PR](https://x.y/1)\n```ts\nconst a = 1;\n```\nok"),
      "Result see the PR ok",
    );
  });
});

describe("clip", () => {
  it("cuts at a word and marks the cut", () => {
    assert.strictEqual(clip("alpha beta gamma delta", 20), "alpha beta gamma…");
  });
});
