import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  TUI_INBOX_PROMPT_CATEGORY,
  type TuiInboxEvent,
  type TuiInboxHostEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ApnsClient from "../push/ApnsClient.ts";
import * as PushDeviceRegistry from "../push/PushDeviceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TuiInbox from "./TuiInbox.ts";

const sent: ApnsClient.ApnsNotification[] = [];

const fakes = Layer.mergeAll(
  NodeServices.layer,
  ServerSettings.layerTest({
    push: {
      enabled: true,
      authKey: "key",
      keyId: "KEY",
      teamId: "TEAM",
      bundleId: "co.example.app",
    },
  }),
  Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      getDescriptor: Effect.die("unused"),
    }),
  ),
  Layer.succeed(
    PushDeviceRegistry.PushDeviceRegistry,
    PushDeviceRegistry.PushDeviceRegistry.of({
      list: Effect.succeed([
        {
          installationId: "phone",
          deviceToken: "abc",
          platform: "ios",
          pushEnvironment: "production",
          registeredAt: 1,
        },
      ]),
      register: () => Effect.succeed([]),
      unregister: () => Effect.void,
      forget: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ApnsClient.ApnsClient,
    ApnsClient.ApnsClient.of({
      send: (_credentials, notification) =>
        Effect.sync(() => {
          sent.push(notification);
        }),
    }),
  ),
);

const makeInbox = TuiInbox.make.pipe(Effect.provide(fakes));

const take = <A>(stream: Stream.Stream<A>, n: number) =>
  stream.pipe(Stream.take(n), Stream.runCollect, Effect.forkScoped);

it.effect("holds a phone's utterance until tui connects, then delivers it once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbox = yield* makeInbox;
      const first = yield* inbox.send({ clientMessageId: "m1", text: "open the roost thread" });
      expect(first.delivered).toBe(false);
      // A resend after a dropped socket is not heard twice.
      const again = yield* inbox.send({ clientMessageId: "m1", text: "open the roost thread" });
      expect(again.utteranceId).toBe(first.utteranceId);

      const events = yield* take(yield* inbox.connect({ clientId: "tui" }), 2);
      const received = Array.from(yield* Fiber.join(events)) as TuiInboxHostEvent[];
      expect(received[0]?.type).toBe("connected");
      expect(received[1]).toMatchObject({
        type: "utterance",
        utterance: { id: first.utteranceId, text: "open the roost thread" },
      });
    }),
  ),
);

it.effect("refuses an empty send", () =>
  Effect.gen(function* () {
    const inbox = yield* makeInbox;
    const error = yield* Effect.flip(inbox.send({ clientMessageId: "m2", text: "   " }));
    expect(error._tag).toBe("TuiInboxError");
  }).pipe(Effect.scoped),
);

it.live("relays a prompt to the phone, pushes it with actions, and routes the verdict", () =>
  Effect.scoped(
    Effect.gen(function* () {
      sent.length = 0;
      const inbox = yield* makeInbox;
      const received: TuiInboxHostEvent[] = [];
      yield* Stream.runForEach(yield* inbox.connect({ clientId: "tui" }), (event) =>
        Effect.sync(() => received.push(event)),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const phone = yield* take(yield* inbox.subscribe, 2);
      yield* Effect.yieldNow;

      yield* inbox.post({ type: "prompt", promptId: "p1", text: "Hand this to Roost?" });
      const phoneEvents = Array.from(yield* Fiber.join(phone)) as TuiInboxEvent[];
      expect(phoneEvents[0]).toMatchObject({ type: "snapshot", hostConnected: true });
      expect(phoneEvents[1]).toMatchObject({
        type: "entry",
        entry: { from: "tui", post: { type: "prompt", promptId: "p1" } },
      });

      // The push runs beside the post.
      yield* Effect.sleep("10 millis");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.category).toBe(TUI_INBOX_PROMPT_CATEGORY);
      expect(sent[0]?.data.tuiPromptId).toBe("p1");

      yield* inbox.control({ type: "verdict", promptId: "p1", verdict: "up" });
      yield* Effect.sleep("10 millis");
      expect(received[1]).toEqual({ type: "verdict", promptId: "p1", verdict: "up" });

      // A rating of what was already done is shown, never pushed.
      yield* inbox.post({ type: "prompt", promptId: "p2", text: "Right?", kind: "rate" });
      yield* Effect.sleep("10 millis");
      expect(sent).toHaveLength(1);

      yield* inbox.post({ type: "settled", promptId: "p1", outcome: "up" });
      const late = yield* Effect.flip(
        inbox.control({ type: "verdict", promptId: "p1", verdict: "down" }),
      );
      expect(late.message).toContain("already been answered");
    }),
  ),
);

it.live("says nothing by push while the phone is watching, and pushes when it is not", () =>
  Effect.scoped(
    Effect.gen(function* () {
      sent.length = 0;
      const inbox = yield* makeInbox;
      yield* inbox.post({ type: "say", text: "Opened the Roost thread." });
      yield* Effect.sleep("10 millis");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.category).toBeUndefined();

      yield* take(yield* inbox.subscribe, 99);
      yield* Effect.yieldNow;
      yield* inbox.post({ type: "say", text: "Done." });
      yield* Effect.sleep("10 millis");
      expect(sent).toHaveLength(1);
    }),
  ),
);

it.effect("tells the phone tui is away rather than dropping a verdict", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbox = yield* makeInbox;
      const error = yield* Effect.flip(inbox.control({ type: "stop" }));
      expect(error.message).toContain("not connected");
    }),
  ),
);

it.effect("tells a replaced tui it was superseded and delivers one event per chunk", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbox = yield* makeInbox;
      yield* inbox.send({ clientMessageId: "w1", text: "one" });
      yield* inbox.send({ clientMessageId: "w2", text: "two" });
      const chunks: number[] = [];
      const first: TuiInboxHostEvent[] = [];
      yield* (yield* inbox.connect({ clientId: "tui-a" })).pipe(
        Stream.chunks,
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk.length);
            first.push(...chunk);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* take(yield* inbox.connect({ clientId: "tui-b" }), 1);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(first.map((event) => event.type)).toEqual([
        "connected",
        "utterance",
        "utterance",
        "superseded",
      ]);
      expect(chunks.every((size) => size === 1)).toBe(true);
    }),
  ),
);
