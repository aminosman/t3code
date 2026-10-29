import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

// These in-memory limits prevent runaway agent loops, not ordinary delegation.
// Both reset when the server restarts.
export const STARTS_PER_HOUR = 200;
export const MAX_DEPTH = 50;
const HOUR_MS = 3_600_000;

export class AgentStartGuard extends Context.Service<
  AgentStartGuard,
  {
    /** Refuses when `count` more starts would pass either limit for this caller. */
    readonly admit: (
      callerId: ThreadId,
      count?: number,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Counts the threads the caller just set working; a thread already counted is not counted again. */
    readonly record: (callerId: ThreadId, started: ReadonlyArray<ThreadId>) => Effect.Effect<void>;
  }
>()("t3/mcp/AgentStartGuard") {}

const make = Effect.gen(function* () {
  const depthByThread = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const startsByCaller = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map());

  const admit = Effect.fn("AgentStartGuard.admit")(function* (callerId: ThreadId, count = 1) {
    if (count <= 0) return;
    const depth = (yield* Ref.get(depthByThread)).get(callerId) ?? 0;
    if (depth >= MAX_DEPTH) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          `This thread is ${MAX_DEPTH} layers of agent-started threads below the user, the most ` +
          "allowed; report back in your reply and let the thread that asked decide.",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const recent = ((yield* Ref.get(startsByCaller)).get(callerId) ?? []).filter(
      (at) => now - at < HOUR_MS,
    );
    if (recent.length + count > STARTS_PER_HOUR) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          `This thread has started ${recent.length} agents in the last hour and may start ` +
          `${STARTS_PER_HOUR}; ask the user before starting more.`,
      });
    }
  });

  const record = Effect.fn("AgentStartGuard.record")(function* (
    callerId: ThreadId,
    started: ReadonlyArray<ThreadId>,
  ) {
    const known = yield* Ref.get(depthByThread);
    const fresh = started.filter((threadId) => !known.has(threadId));
    if (fresh.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const depth = (known.get(callerId) ?? 0) + 1;
    yield* Ref.update(
      depthByThread,
      (map) => new Map([...map, ...fresh.map((threadId) => [threadId, depth] as const)]),
    );
    yield* Ref.update(startsByCaller, (map) => {
      const recent = (map.get(callerId) ?? []).filter((at) => now - at < HOUR_MS);
      return new Map([...map, [callerId, [...recent, ...fresh.map(() => now)]]]);
    });
  });

  return AgentStartGuard.of({ admit, record });
});

export const layer: Layer.Layer<AgentStartGuard> = Layer.effect(AgentStartGuard, make);
