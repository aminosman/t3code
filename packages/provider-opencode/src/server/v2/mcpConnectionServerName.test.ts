import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mcpConnectionServerName } from "./adapter.ts";

it.effect("keeps user MCP connection names within OpenCode's limit and unique", () =>
  Effect.gen(function* () {
    const connectionId = "a-very-long-connection-id-that-would-overflow-the-tool-name-limit";
    const threadId = "a-very-long-delegated-thread-id-that-also-overflows-the-limit";
    const first = yield* mcpConnectionServerName(connectionId, threadId);
    const second = yield* mcpConnectionServerName(`${connectionId}-other`, threadId);

    assert.isAtMost(first.length, 64);
    assert.isAtMost(second.length, 64);
    assert.notEqual(first, second);
    assert.isTrue(first.startsWith(connectionId.slice(0, 20)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
