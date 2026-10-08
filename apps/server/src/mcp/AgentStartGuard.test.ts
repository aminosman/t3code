import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as AgentStartGuard from "./AgentStartGuard.ts";

const user = ThreadId.make("opened-by-the-user");
let next = 0;
const fresh = () => ThreadId.make(`started-${next++}`);

const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error as { message: string }).message),
  );

it.effect("stops only a runaway: STARTS_PER_HOUR an hour, MAX_DEPTH layers deep", () =>
  Effect.gen(function* () {
    const guard = yield* AgentStartGuard.AgentStartGuard;
    const start = (caller: ThreadId) =>
      Effect.gen(function* () {
        yield* guard.admit(caller);
        const child = fresh();
        yield* guard.record(caller, [child]);
        return child;
      });

    // A started thread may start its own, down to MAX_DEPTH layers below the user.
    let child = yield* start(user);
    for (let layer = 2; layer <= AgentStartGuard.MAX_DEPTH; layer++) child = yield* start(child);
    expect(yield* refusal(start(child))).toContain(`${AgentStartGuard.MAX_DEPTH} layers`);

    for (let index = 1; index < AgentStartGuard.STARTS_PER_HOUR; index++) yield* start(user);
    expect(yield* refusal(start(user))).toContain("ask the user");
    yield* TestClock.adjust("61 minutes");
    yield* start(user);
  }).pipe(Effect.provide(AgentStartGuard.layer)),
);

it.effect("admits a batch only when all of it fits, and counts a retried start once", () =>
  Effect.gen(function* () {
    const guard = yield* AgentStartGuard.AgentStartGuard;
    const cap = AgentStartGuard.STARTS_PER_HOUR;
    expect(yield* refusal(guard.admit(user, cap + 1))).toContain(`may start ${cap}`);
    yield* guard.admit(user, 0);

    const child = fresh();
    yield* guard.record(user, [child]);
    // delegate_task with the same clientRequestId returns the same child.
    yield* guard.record(user, [child]);
    yield* guard.admit(user, cap - 1);
    expect(yield* refusal(guard.admit(user, cap))).toContain("started 1 agents");
  }).pipe(Effect.provide(AgentStartGuard.layer)),
);
