import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { TuiScreenEvent, TuiScreenHostEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as TuiScreen from "./TuiScreen.ts";

const makeScreen = TuiScreen.make.pipe(Effect.provide(NodeServices.layer));

const frame = (seq: number) => ({ seq, width: 2, height: 1, jpegBase64: `f${seq}` });

it.effect("tells tui when a phone starts and stops watching, and relays its input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const screen = yield* makeScreen;
      const received: TuiScreenHostEvent[] = [];
      yield* Stream.runForEach(yield* screen.connect({ clientId: "tui" }), (event) =>
        Effect.sync(() => received.push(event)),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(received[0]?.type).toBe("connected");
      expect(received[1]).toEqual({ type: "viewers", count: 0 });

      const phone = yield* Effect.scoped(
        Effect.gen(function* () {
          const events = yield* (yield* screen.subscribe).pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* TestClock.adjust("5 millis");
          expect(received[2]).toEqual({ type: "viewers", count: 1 });
          yield* screen.control({ type: "click", x: 0.5, y: 0.25 });
          yield* screen.frame(frame(1));
          yield* TestClock.adjust("5 millis");
          expect(received[3]).toEqual({
            type: "input",
            input: { type: "click", x: 0.5, y: 0.25 },
          });
          return Array.from(yield* Fiber.join(events)) as TuiScreenEvent[];
        }),
      );
      expect(phone[0]).toMatchObject({ type: "host", connected: true, status: { state: "idle" } });
      expect(phone[1]).toMatchObject({ type: "frame", frame: { seq: 1 } });
      yield* TestClock.adjust("5 millis");
      expect(received.at(-1)).toEqual({ type: "viewers", count: 0 });
    }),
  ),
);

it.effect("a phone that falls behind skips to a newer frame, and a late one gets the last", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const screen = yield* makeScreen;
      yield* Stream.runDrain(yield* screen.connect({ clientId: "tui" })).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const stream = yield* screen.subscribe;
      // Not drained yet: the queue fills past the backlog and frames skip.
      const events = yield* stream.pipe(Stream.take(5), Stream.runCollect, Effect.forkScoped);
      yield* TestClock.adjust("5 millis");
      for (let seq = 1; seq <= 10; seq += 1) yield* screen.frame(frame(seq));
      yield* screen.status({ state: "capturing" });
      const seen = Array.from(yield* Fiber.join(events)) as TuiScreenEvent[];
      const seqs = seen.flatMap((event) => (event.type === "frame" ? [event.frame.seq] : []));
      expect(seqs.length).toBeLessThan(10);
      expect(seqs[0]).toBe(1);

      const late = yield* (yield* screen.subscribe).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const lateEvents = Array.from(yield* Fiber.join(late)) as TuiScreenEvent[];
      expect(lateEvents[0]).toMatchObject({ type: "host", connected: true });
      expect(lateEvents[1]).toMatchObject({ type: "frame", frame: { seq: 10 } });
    }),
  ),
);

it.effect("refuses input while tui is away", () =>
  Effect.gen(function* () {
    const screen = yield* makeScreen;
    const error = yield* Effect.flip(screen.control({ type: "key", key: "enter" }));
    expect(error._tag).toBe("TuiScreenError");
  }).pipe(Effect.scoped),
);

it.effect(
  "an agent's ask reaches tui and the phone, and the phone's answer reaches the agent once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const screen = yield* makeScreen;
        const host: TuiScreenHostEvent[] = [];
        yield* Stream.runForEach(yield* screen.connect({ clientId: "tui" }), (event) =>
          Effect.sync(() => host.push(event)),
        ).pipe(Effect.forkScoped);
        const phone: TuiScreenEvent[] = [];
        yield* Stream.runForEach(yield* screen.subscribe, (event) =>
          Effect.sync(() => phone.push(event)),
        ).pipe(Effect.forkScoped);
        yield* TestClock.adjust("5 millis");

        const answers: string[] = [];
        const answer = (label: string) => (resolution: { outcome: string }) =>
          Effect.sync(() => answers.push(`${label}:${resolution.outcome}`));
        const first = yield* screen.ask({ reason: "Sign in", threadId: "t1" }, answer("first"));
        expect(first.hostConnected).toBe(true);
        // The same thread asking again replaces its first ask.
        const second = yield* screen.ask(
          { reason: "Enter the code", threadId: "t1", target: { app: "Google Chrome" } },
          answer("second"),
        );
        yield* TestClock.adjust("5 millis");
        const lastHost = host.filter((event) => event.type === "requests").at(-1);
        expect(lastHost).toMatchObject({
          requests: [{ id: second.request.id, target: { app: "Google Chrome" } }],
        });
        expect(phone.filter((event) => event.type === "requests").at(-1)).toMatchObject({
          requests: [{ reason: "Enter the code" }],
        });

        const stale = yield* Effect.flip(screen.resolve({ id: first.request.id, outcome: "done" }));
        expect(stale._tag).toBe("TuiScreenError");
        yield* screen.resolve({ id: second.request.id, outcome: "done" });
        yield* TestClock.adjust("5 millis");
        expect(answers).toEqual(["second:done"]);
        expect(phone.at(-1)).toEqual({ type: "requests", requests: [] });
        const again = yield* Effect.flip(
          screen.resolve({ id: second.request.id, outcome: "done" }),
        );
        expect(again._tag).toBe("TuiScreenError");
      }),
    ),
);
