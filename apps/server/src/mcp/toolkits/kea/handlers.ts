/**
 * `kea_ask`, wired to the socket.
 *
 * Thin on purpose. The thread id is not a parameter — it comes off the
 * invocation scope, which is minted per provider session — so an agent
 * cannot address another thread's conversation with kea, cannot forget to
 * pass one, and cannot get one wrong. Everything else that matters (which
 * tools answer the question, whether the user has to be interrupted, what
 * the answer reads like) is kea's side of the wire.
 *
 * @module mcp/toolkits/kea/handlers
 */
import * as Effect from "effect/Effect";

import * as KeaBridge from "../../KeaBridge.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { KeaToolkit, KeaUnavailableError } from "./tools.ts";

const handlers = {
  kea_ask: Effect.fn("KeaToolkit.kea_ask")(function* (input: { readonly request: string }) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("kea")) {
      return yield* new KeaUnavailableError({
        reason: "this agent session was not granted access to kea",
      });
    }
    const reply = yield* Effect.promise(() =>
      KeaBridge.request({
        cmd: "ask",
        thread: scope.threadId,
        request: input.request,
      }),
    );
    if (!reply.ok || typeof reply.text !== "string") {
      return yield* new KeaUnavailableError({
        reason: reply.error ?? "kea returned no answer",
      });
    }
    return { answer: reply.text };
  }),
} satisfies Parameters<typeof KeaToolkit.toLayer>[0];

export const KeaToolkitHandlersLive = KeaToolkit.toLayer(handlers);
