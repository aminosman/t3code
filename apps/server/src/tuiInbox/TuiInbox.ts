/**
 * The tui inbox: a phone talking to tui, the Mac's voice assistant, through
 * this server.
 *
 * tui holds one `connect` stream and hears each utterance through the same
 * front door as push-to-talk, so the phone gets tui's one decider and its
 * confirmation cards rather than a second router. The phone `send`s text or a
 * voice note, follows the conversation on `subscribe`, and answers a card or
 * stops a run with `control`. A card also goes out as a push notification with
 * Allow / Decline actions, and anything tui says while no phone is watching
 * goes out as a plain one.
 *
 * Everything is in memory: an utterance sent while tui is away waits for it,
 * and the last entries are kept for the phone to scroll back through, but a
 * server restart starts the conversation over.
 */
import {
  TUI_INBOX_PROMPT_CATEGORY,
  TuiInboxError,
  type TuiInboxControlInput,
  type TuiInboxEntry,
  type TuiInboxEvent,
  type TuiInboxHost,
  type TuiInboxHostEvent,
  type TuiInboxPost,
  type TuiInboxSendInput,
  type TuiInboxSendResult,
  type TuiInboxUtterance,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ApnsClient from "../push/ApnsClient.ts";
import { readApnsCredentials } from "../push/apnsCredentials.ts";
import * as PushDeviceRegistry from "../push/PushDeviceRegistry.ts";

const MAX_ENTRIES = 200;
/** Utterances held for an absent tui; older ones are dropped, not replayed. */
const MAX_WAITING = 20;
const WAITING_TTL_MS = 10 * 60 * 1000;
const SEEN_CLIENT_IDS = 500;

export class TuiInbox extends Context.Service<
  TuiInbox,
  {
    readonly connect: (host: TuiInboxHost) => Effect.Effect<Stream.Stream<TuiInboxHostEvent>>;
    readonly post: (post: TuiInboxPost) => Effect.Effect<void>;
    readonly send: (input: TuiInboxSendInput) => Effect.Effect<TuiInboxSendResult, TuiInboxError>;
    readonly subscribe: Effect.Effect<Stream.Stream<TuiInboxEvent>>;
    readonly control: (input: TuiInboxControlInput) => Effect.Effect<void, TuiInboxError>;
  }
>()("t3/tuiInbox/TuiInbox") {}

interface Host {
  readonly clientId: string;
  readonly connectionId: string;
  readonly queue: Queue.Queue<TuiInboxHostEvent, Cause.Done>;
}

/** The first line of a prompt, kept short enough for a lock screen. */
const pushBody = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
};

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
  const apns = yield* ApnsClient.ApnsClient;
  const scope = yield* Effect.scope;

  // JavaScript runs one fiber at a time and none of these blocks yields, so
  // plain mutable state inside Effect.sync is atomic.
  let host: Host | null = null;
  let waiting: Array<{ readonly utterance: TuiInboxUtterance; readonly at: number }> = [];
  const entries: TuiInboxEntry[] = [];
  const subscribers = new Set<Queue.Queue<TuiInboxEvent, Cause.Done>>();
  const seenClientIds = new Map<string, string>();
  const openPrompts = new Set<string>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const broadcast = (event: TuiInboxEvent) =>
    Effect.forEach(subscribers, (queue) => Queue.offer(queue, event), { discard: true });

  const record = Effect.fn("TuiInbox.record")(function* (entry: Omit<TuiInboxEntry, "id" | "at">) {
    const full: TuiInboxEntry = { ...entry, id: yield* uuid, at: yield* nowIso };
    entries.push(full);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    yield* broadcast({ type: "entry", entry: full });
    return full;
  });

  const notifyDevices = Effect.fn("TuiInbox.notifyDevices")(function* (notification: {
    readonly title: string;
    readonly body: string;
    readonly collapseId: string;
    readonly category?: string;
    readonly data: Record<string, string>;
  }) {
    const devices = yield* registry.list;
    if (devices.length === 0) return;
    const credentials = yield* readApnsCredentials({ devicesWaiting: devices.length }).pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settingsService),
    );
    if (credentials === null) return;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    yield* Effect.forEach(
      devices,
      (device) =>
        apns
          .send(credentials, {
            deviceToken: device.deviceToken,
            production: device.pushEnvironment === "production",
            title: notification.title,
            body: notification.body,
            data: { ...notification.data, environmentId, deepLink: "/tui" },
            collapseId: notification.collapseId,
            ...(notification.category ? { category: notification.category } : {}),
          })
          .pipe(
            Effect.catch((error) =>
              error.tokenRejected
                ? registry.forget(device.deviceToken)
                : Effect.logWarning("tui inbox: APNs delivery failed", {
                    status: error.status,
                    reason: error.reason,
                  }),
            ),
          ),
      { concurrency: 4, discard: true },
    );
  });

  /** Push runs beside the RPC so a slow APNs never holds tui up. */
  const notifyInBackground = (notification: Parameters<typeof notifyDevices>[0]) =>
    notifyDevices(notification).pipe(
      Effect.catchCause((cause) => Effect.logWarning("tui inbox: push failed", { cause })),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const releaseHost = (queue: Host["queue"]) =>
    Effect.gen(function* () {
      if (host?.queue !== queue) return;
      host = null;
      yield* broadcast({ type: "host", connected: false });
    });

  const connect: TuiInbox["Service"]["connect"] = (registration) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<TuiInboxHostEvent, Cause.Done>();
            const connectionId = yield* uuid;
            yield* Queue.offer(queue, { type: "connected", connectionId });
            const previous = host;
            host = { clientId: registration.clientId, connectionId, queue };
            // A second tui (a relaunch, an update) replaces the first.
            if (previous) yield* Queue.end(previous.queue);
            const cutoff = (yield* Clock.currentTimeMillis) - WAITING_TTL_MS;
            const fresh = waiting.filter((held) => held.at >= cutoff);
            waiting = [];
            yield* Effect.forEach(fresh, ({ utterance }) =>
              Queue.offer(queue, { type: "utterance", utterance }),
            );
            yield* broadcast({ type: "host", connected: true });
            yield* Effect.logInfo("tui inbox: tui connected", {
              clientId: registration.clientId,
              version: registration.version,
              delivered: fresh.length,
            });
            return queue;
          }),
          releaseHost,
        ).pipe(Effect.map((queue) => Stream.fromQueue(queue))),
      ),
    );

  const post: TuiInbox["Service"]["post"] = Effect.fn("TuiInbox.post")(function* (message) {
    yield* record({ from: "tui", post: message });
    switch (message.type) {
      case "prompt": {
        openPrompts.add(message.promptId);
        yield* notifyInBackground({
          title: "tui is asking",
          body: pushBody(message.text),
          collapseId: `tui-prompt-${message.promptId}`,
          category: TUI_INBOX_PROMPT_CATEGORY,
          data: { tuiPromptId: message.promptId },
        });
        return;
      }
      case "settled": {
        openPrompts.delete(message.promptId);
        return;
      }
      case "say": {
        // An open app hears it on its stream; a pocketed phone gets a push.
        if (subscribers.size > 0) return;
        yield* notifyInBackground({
          title: "tui",
          body: pushBody(message.text),
          collapseId: "tui-say",
          data: {},
        });
        return;
      }
      default:
        return;
    }
  });

  const send: TuiInbox["Service"]["send"] = Effect.fn("TuiInbox.send")(function* (input) {
    const text = input.text?.trim();
    if (!text && !input.voice) {
      return yield* new TuiInboxError({ message: "Send some text or a voice note." });
    }
    const seen = seenClientIds.get(input.clientMessageId);
    if (seen !== undefined) {
      return { utteranceId: seen, delivered: host !== null };
    }
    const utterance: TuiInboxUtterance = {
      id: yield* uuid,
      sentAt: yield* nowIso,
      ...(text ? { text } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
    };
    seenClientIds.set(input.clientMessageId, utterance.id);
    if (seenClientIds.size > SEEN_CLIENT_IDS) {
      const oldest = seenClientIds.keys().next().value;
      if (oldest !== undefined) seenClientIds.delete(oldest);
    }
    yield* record({
      from: "me",
      utterance: {
        id: utterance.id,
        voice: input.voice !== undefined,
        ...(text ? { text } : {}),
        ...(input.voice?.durationMs !== undefined ? { durationMs: input.voice.durationMs } : {}),
      },
    });
    if (host) {
      yield* Queue.offer(host.queue, { type: "utterance", utterance });
      return { utteranceId: utterance.id, delivered: true };
    }
    waiting.push({ utterance, at: yield* Clock.currentTimeMillis });
    if (waiting.length > MAX_WAITING) waiting = waiting.slice(-MAX_WAITING);
    return { utteranceId: utterance.id, delivered: false };
  });

  const subscribe: TuiInbox["Service"]["subscribe"] = Effect.succeed(
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<TuiInboxEvent, Cause.Done>();
          yield* Queue.offer(queue, {
            type: "snapshot",
            hostConnected: host !== null,
            entries: [...entries],
          });
          subscribers.add(queue);
          return queue;
        }),
        (queue) =>
          Effect.sync(() => {
            subscribers.delete(queue);
          }),
      ).pipe(Effect.map((queue) => Stream.fromQueue(queue))),
    ),
  );

  const control: TuiInbox["Service"]["control"] = Effect.fn("TuiInbox.control")(function* (input) {
    if (!host) {
      return yield* new TuiInboxError({ message: "tui is not connected on the Mac." });
    }
    if (input.type === "stop") {
      yield* Queue.offer(host.queue, { type: "stop" });
      return;
    }
    if (!openPrompts.has(input.promptId)) {
      return yield* new TuiInboxError({ message: "That question has already been answered." });
    }
    yield* Queue.offer(host.queue, {
      type: "verdict",
      promptId: input.promptId,
      verdict: input.verdict,
    });
  });

  return TuiInbox.of({ connect, post, send, subscribe, control });
});

export const layer = Layer.effect(TuiInbox, make).pipe(Layer.provide(ApnsClient.layer));
