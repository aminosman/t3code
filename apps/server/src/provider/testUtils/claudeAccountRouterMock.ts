/**
 * A `ClaudeAccountRouter` that never rotates, for harnesses that build the
 * command reactor without the instance registry behind the real router.
 * Matches production behaviour for any instance without an `accountGroup`.
 *
 * @module provider/testUtils/claudeAccountRouterMock
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ClaudeAccountRouter } from "../Layers/ClaudeAccountRouter.ts";

export const ClaudeAccountRouterNoopLayer = Layer.succeed(
  ClaudeAccountRouter,
  ClaudeAccountRouter.of({
    listCandidates: () => Effect.succeed([]),
    resolve: (instanceId) =>
      Effect.succeed({
        _tag: "Stay" as const,
        instanceId,
        reason: "ungrouped" as const,
        standing: undefined,
      }),
  }),
);
