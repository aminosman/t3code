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
 * An agent thread blocked on the user at the Mac asks with `ask` (the
 * `t3_screen_hand_over` MCP tool). The ask is listed to phones and to tui,
 * which shows the display holding the window it names; the phone's Done or
 * Not now comes back through `resolve` and is handed to the asker's answer,
 * which sends it into the thread.
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
  type TuiScreenRequest,
  type TuiScreenResolve,
  type TuiScreenStatus,
  type TuiScreenTarget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
    /**
     * Ask the user to do something at the screen. `answer` runs once, in
     * the background, when a phone says Done or Not now. A thread that asks
     * again replaces its earlier ask, whose answer is never run.
     */
    readonly ask: (
      input: TuiScreenAsk,
      answer: (resolution: TuiScreenResolve) => Effect.Effect<void>,
    ) => Effect.Effect<{ readonly request: TuiScreenRequest; readonly hostConnected: boolean }>;
    readonly resolve: (input: TuiScreenResolve) => Effect.Effect<void, TuiScreenError>;
    /** Whether tui holds the stream now. */
    readonly hostConnected: Effect.Effect<boolean>;
  }
>()("t3/tuiScreen/TuiScreen") {}

export interface TuiScreenAsk {
  readonly reason: string;
  readonly threadId?: string;
  readonly threadTitle?: string;
  readonly target?: TuiScreenTarget;
}

interface Pending {
  readonly request: TuiScreenRequest;
  readonly answer: (resolution: TuiScreenResolve) => Effect.Effect<void>;
}

/** An ask nobody answers is let go after this long. */
const ASK_TTL_MS = 60 * 60 * 1000;

interface Host {
  readonly clientId: string;
  readonly connectionId: string;
  readonly queue: Queue.Queue<TuiScreenHostEvent, Cause.Done>;
}

/** Frames a phone may have waiting before newer ones skip it. */
const FRAME_BACKLOG = 2;

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;

  // JavaScript runs one fiber at a time and none of these blocks yields, so
  // plain mutable state inside Effect.sync is atomic.
  let host: Host | null = null;
  let lastStatus: TuiScreenStatus = { state: "idle" };
  let lastFrame: TuiScreenFrame | null = null;
  const subscribers = new Set<Queue.Queue<TuiScreenEvent, Cause.Done>>();
  const pending = new Map<string, Pending>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const broadcast = (event: TuiScreenEvent) =>
    Effect.forEach(subscribers, (queue) => Queue.offer(queue, event), { discard: true });

  const requests = Effect.gen(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - ASK_TTL_MS;
    for (const [id, entry] of pending) if (entry.request.createdAt < cutoff) pending.delete(id);
    return Array.from(pending.values(), (entry) => entry.request);
  });

  const tellRequests = Effect.gen(function* () {
    const list = yield* requests;
    yield* broadcast({ type: "requests", requests: list });
    if (host) yield* Queue.offer(host.queue, { type: "requests", requests: list });
  });

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
            const asks = yield* requests;
            // Only when there are any: a fresh connection starts with none.
            if (asks.length > 0) yield* Queue.offer(queue, { type: "requests", requests: asks });
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
          const asks = yield* requests;
          if (asks.length > 0) yield* Queue.offer(queue, { type: "requests", requests: asks });
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

  const ask: TuiScreen["Service"]["ask"] = Effect.fn("TuiScreen.ask")(function* (input, answer) {
    if (input.threadId !== undefined) {
      for (const [id, entry] of pending)
        if (entry.request.threadId === input.threadId) pending.delete(id);
    }
    const request: TuiScreenRequest = {
      id: yield* uuid,
      reason: input.reason,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.threadTitle === undefined ? {} : { threadTitle: input.threadTitle }),
      ...(input.target === undefined ? {} : { target: input.target }),
      createdAt: yield* Clock.currentTimeMillis,
    };
    pending.set(request.id, { request, answer });
    yield* tellRequests;
    yield* Effect.logInfo("tui screen: an agent asked for the user", {
      threadId: input.threadId,
      hostConnected: host !== null,
    });
    return { request, hostConnected: host !== null };
  });

  const resolve: TuiScreen["Service"]["resolve"] = Effect.fn("TuiScreen.resolve")(
    function* (input) {
      const entry = pending.get(input.id);
      if (!entry) {
        return yield* new TuiScreenError({ message: "That ask has already been answered." });
      }
      pending.delete(input.id);
      yield* tellRequests;
      yield* entry.answer(input).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("tui screen: answering the ask failed", { cause }),
        ),
        Effect.forkIn(scope),
      );
    },
  );

  return TuiScreen.of({
    connect,
    frame,
    status,
    subscribe,
    control,
    ask,
    resolve,
    hostConnected: Effect.sync(() => host !== null),
  });
});

export const layer = Layer.effect(TuiScreen, make);
