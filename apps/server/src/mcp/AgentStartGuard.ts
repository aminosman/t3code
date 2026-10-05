import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Roost: how many agents one thread may set working, and how deep a chain of
 * them may go — the same two limits whichever tool starts them
 * (delegate_task, t3_thread_launch, create_threads).
 *
 * An agent an agent starts spends the user's allowance and lands in their
 * sidebar. One thread may start a handful an hour — a review, a second
 * opinion — and a thread started by an agent may itself start others, down to
 * MAX_DEPTH layers below a thread the user opened, so a review can ask for a
 * review of its own work but not without end (Amin, Sep 26 2026: "we should be
 * able to go … four layers deep, not just one"). These limits were Roost's own
 * t3_thread_create's; upstream's tools have none, and they replaced it
 * (Oct 5 2026). Both are in memory and reset with the server.
 */
export const STARTS_PER_HOUR = 5;
export const MAX_DEPTH = 4;
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

  const admit = (callerId: ThreadId, count = 1) =>
    Effect.gen(function* () {
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

  const record = (callerId: ThreadId, started: ReadonlyArray<ThreadId>) =>
    Effect.gen(function* () {
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
