/**
 * The tui screen: the Mac's display on a phone, through this server.
 *
 * tui holds one `connect` stream. While at least one phone is on
 * `subscribe`, it is told so (`viewers`) and posts JPEG frames with `frame`;
 * when the last phone leaves, it is told that too and stops capturing. The
 * phone's taps, scrolls and typing arrive with `control` and go to tui on
 * its stream, which puts them on the Mac as real input. The case it exists
 * for: an agent opens a sign-in page the user must click through themselves,
 * from wherever they are.
 *
 * Frames are not queued: a phone that falls behind gets the newest frame
 * next, not the one after the last it saw. Nothing is kept across a restart.
 */
import {
  TuiScreenError,
  type TuiScreenEvent,
  type TuiScreenFrame,
  type TuiScreenHost,
  type TuiScreenHostEvent,
  type TuiScreenInput,
  type TuiScreenStatus,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export class TuiScreen extends Context.Service<
  TuiScreen,
  {
    readonly connect: (host: TuiScreenHost) => Effect.Effect<Stream.Stream<TuiScreenHostEvent>>;
    readonly frame: (frame: TuiScreenFrame) => Effect.Effect<void>;
    readonly status: (status: TuiScreenStatus) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<TuiScreenEvent>>;
    readonly control: (input: TuiScreenInput) => Effect.Effect<void, TuiScreenError>;
  }
>()("t3/tuiScreen/TuiScreen") {}

interface Host {
  readonly clientId: string;
  readonly connectionId: string;
  readonly queue: Queue.Queue<TuiScreenHostEvent, Cause.Done>;
}

/** Frames a phone may have waiting before newer ones skip it. */
const FRAME_BACKLOG = 2;

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;

  // JavaScript runs one fiber at a time and none of these blocks yields, so
  // plain mutable state inside Effect.sync is atomic.
  let host: Host | null = null;
  let lastStatus: TuiScreenStatus = { state: "idle" };
  let lastFrame: TuiScreenFrame | null = null;
  const subscribers = new Set<Queue.Queue<TuiScreenEvent, Cause.Done>>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const broadcast = (event: TuiScreenEvent) =>
    Effect.forEach(subscribers, (queue) => Queue.offer(queue, event), { discard: true });

  const tellViewers = Effect.gen(function* () {
    if (!host) return;
    yield* Queue.offer(host.queue, { type: "viewers", count: subscribers.size });
  });

  const releaseHost = (queue: Host["queue"]) =>
    Effect.gen(function* () {
      if (host?.queue !== queue) return;
      host = null;
      lastFrame = null;
      lastStatus = { state: "idle" };
      yield* broadcast({ type: "host", connected: false });
    });

  const connect: TuiScreen["Service"]["connect"] = (registration) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<TuiScreenHostEvent, Cause.Done>();
            const connectionId = yield* uuid;
            yield* Queue.offer(queue, { type: "connected", connectionId });
            const previous = host;
            host = { clientId: registration.clientId, connectionId, queue };
            lastStatus = { state: "idle" };
            // A second tui (a relaunch, an update) replaces the first, and
            // the first is told so: it must not reconnect and take the
            // stream back, or two copies steal it from each other forever.
            if (previous) {
              yield* Queue.offer(previous.queue, { type: "superseded" });
              yield* Queue.end(previous.queue);
            }
            yield* Queue.offer(queue, { type: "viewers", count: subscribers.size });
            yield* broadcast({ type: "host", connected: true, status: lastStatus });
            yield* Effect.logInfo("tui screen: tui connected", {
              clientId: registration.clientId,
              version: registration.version,
              viewers: subscribers.size,
            });
            return queue;
          }),
          releaseHost,
        ).pipe(Effect.map((queue) => Stream.fromQueue(queue).pipe(Stream.rechunk(1)))),
      ),
    );

  const frame: TuiScreen["Service"]["frame"] = Effect.fn("TuiScreen.frame")(function* (picture) {
    lastFrame = picture;
    if (lastStatus.state !== "capturing") lastStatus = { state: "capturing" };
    yield* Effect.forEach(
      subscribers,
      (queue) =>
        Effect.gen(function* () {
          // A phone that has frames waiting is behind: this one is skipped
          // and the next catches it up, so the picture stays live.
          if ((yield* Queue.size(queue)) > FRAME_BACKLOG) return;
          yield* Queue.offer(queue, { type: "frame", frame: picture });
        }),
      { discard: true },
    );
  });

  const status: TuiScreen["Service"]["status"] = Effect.fn("TuiScreen.status")(function* (next) {
    lastStatus = next;
    if (next.state !== "capturing") lastFrame = null;
    yield* broadcast({ type: "status", status: next });
  });

  const subscribe: TuiScreen["Service"]["subscribe"] = Effect.succeed(
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<TuiScreenEvent, Cause.Done>();
          yield* Queue.offer(queue, { type: "host", connected: host !== null, status: lastStatus });
          if (lastFrame) yield* Queue.offer(queue, { type: "frame", frame: lastFrame });
          subscribers.add(queue);
          yield* tellViewers;
          return queue;
        }),
        (queue) =>
          Effect.gen(function* () {
            subscribers.delete(queue);
            yield* tellViewers;
          }),
      ).pipe(Effect.map((queue) => Stream.fromQueue(queue).pipe(Stream.rechunk(1)))),
    ),
  );

  const control: TuiScreen["Service"]["control"] = Effect.fn("TuiScreen.control")(
    function* (input) {
      if (!host) {
        return yield* new TuiScreenError({ message: "tui is not connected on the Mac." });
      }
      yield* Queue.offer(host.queue, { type: "input", input });
    },
  );

  return TuiScreen.of({ connect, frame, status, subscribe, control });
});

export const layer = Layer.effect(TuiScreen, make);
