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

it.effect("lets one thread start a handful an hour, and a chain go four layers deep", () =>
  Effect.gen(function* () {
    const guard = yield* AgentStartGuard.AgentStartGuard;
    const start = (caller: ThreadId) =>
      Effect.gen(function* () {
        yield* guard.admit(caller);
        const child = fresh();
        yield* guard.record(caller, [child]);
        return child;
      });

    // A started thread may start its own, down to four layers below the user.
    let child = yield* start(user);
    for (let layer = 2; layer <= 4; layer++) child = yield* start(child);
    expect(yield* refusal(start(child))).toContain("4 layers");

    for (let index = 0; index < 4; index++) yield* start(user);
    expect(yield* refusal(start(user))).toContain("ask the user");
    yield* TestClock.adjust("61 minutes");
    yield* start(user);
  }).pipe(Effect.provide(AgentStartGuard.layer)),
);

it.effect("admits a batch only when all of it fits, and counts a retried start once", () =>
  Effect.gen(function* () {
    const guard = yield* AgentStartGuard.AgentStartGuard;
    expect(yield* refusal(guard.admit(user, 6))).toContain("may start 5");
    yield* guard.admit(user, 0);

    const child = fresh();
    yield* guard.record(user, [child]);
    // delegate_task with the same clientRequestId returns the same child.
    yield* guard.record(user, [child]);
    yield* guard.admit(user, 4);
    expect(yield* refusal(guard.admit(user, 5))).toContain("started 1 agents");
  }).pipe(Effect.provide(AgentStartGuard.layer)),
);
