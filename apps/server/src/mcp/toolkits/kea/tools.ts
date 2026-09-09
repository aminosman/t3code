/**
 * The `kea` toolkit — one tool, and it is a conversation rather than a call.
 *
 * Every other tool an agent holds here is a function: name the operation,
 * give it arguments, get a value. `kea_ask` is not. On the other end is an
 * agent with its own tools — the screen, the browser, mail, messages, the
 * shell, the user's connected services — so the right thing to send is the
 * QUESTION, in English, and let kea work out which tools answer it. An agent
 * that tries to specify the mechanism ("run osascript to...") gets a worse
 * answer than one that says what it needs to know.
 *
 * @module mcp/toolkits/kea/tools
 */
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class KeaUnavailableError extends Schema.TaggedErrorClass<KeaUnavailableError>()(
  "KeaUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `kea could not answer: ${this.reason}`;
  }
}

export const KeaAnswer = Schema.Struct({
  answer: Schema.String.annotate({
    description: "What kea found, in plain text, or what stopped it.",
  }),
});

export const KeaAskInput = Schema.Struct({
  request: Schema.String.annotate({
    description:
      "What you need to know or want done, in plain English. Say what you want, not how to " +
      "get it — kea picks the tools. Include enough context to act on: 'which tab is he " +
      "reading right now, and what does the error on it say' beats 'read the screen'.",
  }),
});

export const KeaAskTool = Tool.make("kea_ask", {
  description:
    "Ask kea — the user's voice assistant, running on this Mac — for something you cannot " +
    "get from this repository. kea can see what is on their screen right now, read any " +
    "browser tab, inspect running apps, reach their mail, calendar, reminders, messages and " +
    "connected services, and run things outside this workspace.\n\n" +
    "kea is an AGENT, not a getter: ask in English for the fact or the outcome you need and " +
    "it decides how to obtain it. It answers with plain facts for you to act on, or with a " +
    "line saying exactly what stopped it — trust that line rather than retrying blindly.\n\n" +
    "Reading what is already in front of the user is silent and instant. Anything that takes " +
    "their screen away — switching apps, clicking, typing — makes kea interrupt them to ask, " +
    "and they may say no, in which case you get told so. Prefer questions that can be " +
    "answered by looking.\n\n" +
    "Calls are answered one at a time and kea remembers this thread's earlier questions, so " +
    "a follow-up can refer back to what it already told you.",
  parameters: KeaAskInput,
  success: KeaAnswer,
  failure: KeaUnavailableError,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Ask kea")
  .annotate(Tool.OpenWorld, true)
  // Not readonly and not idempotent: kea may act on the user's Mac, and the
  // same question asked twice can legitimately answer differently because
  // the screen moved underneath it.
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const KeaToolkit = Toolkit.make(KeaAskTool);
