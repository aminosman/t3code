/**
 * Environment-delivered push notifications.
 *
 * The relay path publishes agent activity to T3 Connect and lets the relay
 * decide who to notify. This does the same job without the middleman: the
 * environment watches its own orchestration events, projects the same shared
 * awareness state, and posts straight to APNs with its own auth key. Devices
 * register with the environment, so a self-hosted server notifies its own
 * phone with nobody else in the path.
 */
import { type AgentAwarenessPhase, projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ApnsClient from "./ApnsClient.ts";
import { readApnsCredentials } from "./apnsCredentials.ts";
import * as PushDeviceRegistry from "./PushDeviceRegistry.ts";
import { buildThreadNotification, type PendingRequestItem } from "./threadNotification.ts";

/**
 * Phases worth interrupting someone for. "running"/"starting" are progress,
 * not news — the whole point of this feature is the phone buzzing when the
 * agent stops needing nothing and starts needing you.
 */
const NOTIFIABLE_PHASES = new Set<AgentAwarenessPhase>([
  "completed",
  "failed",
  "waiting_for_approval",
  "waiting_for_input",
]);

/**
 * A session boots at "ready", which the shared projection reads as completed
 * for an instant. Publishing that immediately sends a "Done" alert at thread
 * birth, so a thread's first observed phase never notifies — the relay path
 * solves the same race with a deferred confirmation.
 */
export function shouldNotifyPhaseTransition(input: {
  readonly previous: AgentAwarenessPhase | null | undefined;
  readonly next: AgentAwarenessPhase | null;
}): boolean {
  if (input.next === null || !NOTIFIABLE_PHASES.has(input.next)) {
    return false;
  }
  if (input.previous === undefined) {
    return false;
  }
  return input.previous !== input.next;
}

export class PushNotifier extends Context.Service<
  PushNotifier,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** Sends one device a test notification; the message says why when it did not go. */
    readonly sendTest: (
      installationId: string,
    ) => Effect.Effect<{ readonly delivered: boolean; readonly message?: string }>;
  }
>()("t3/push/PushNotifier") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
  const apns = yield* ApnsClient.ApnsClient;

  const phaseByThread = new Map<ThreadId, AgentAwarenessPhase | null>();

  const notifyThread = Effect.fn("PushNotifier.notifyThread")(function* (threadId: ThreadId) {
    const registered = yield* registry.list;
    const credentials = yield* readApnsCredentials({ devicesWaiting: registered.length }).pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settingsService),
    );
    if (credentials === null) {
      return;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const thread = yield* threads.getThreadShell(threadId);
    const project =
      thread !== null && thread.archivedAt === null
        ? yield* projects.getById(thread.projectId)
        : Option.none();

    const state =
      thread !== null && Option.isSome(project)
        ? projectThreadAwarenessV2({ environmentId, project: project.value, thread })
        : null;

    const previous = phaseByThread.get(threadId);
    const next = state?.phase ?? null;
    const notify = shouldNotifyPhaseTransition({ previous, next });
    phaseByThread.set(threadId, next);
    if (!notify || state === null) {
      return;
    }

    const devices = yield* registry.list;
    if (devices.length === 0) {
      return;
    }

    const pendingRequestId = thread?.pendingRuntimeRequest?.id;
    const pending =
      thread !== null && pendingRequestId !== undefined
        ? yield* threads
            .getProjectThreadRecords({ projectId: thread.projectId, threadId }, ["turnItems"], {
              turnItemTypes: ["approval_request", "user_input_request"],
            })
            .pipe(
              Effect.map(
                (records) =>
                  (records.turnItems.find(
                    (item) =>
                      (item.type === "approval_request" || item.type === "user_input_request") &&
                      item.requestId === pendingRequestId,
                  ) ?? null) as PendingRequestItem | null,
              ),
              Effect.orElseSucceed(() => null),
            )
        : null;
    // The shell carries no message bodies; the finished run's own messages
    // hold what the agent said last.
    const latestRunId = thread?.latestRunId ?? null;
    const lastAssistantText =
      thread !== null && latestRunId !== null && state.phase === "completed"
        ? yield* threads
            .getProjectThreadRecords({ projectId: thread.projectId, threadId }, ["messages"], {
              messageRoles: ["assistant"],
              messageRunIds: [latestRunId],
            })
            .pipe(
              Effect.map((records) => {
                const said = records.messages.filter((message) => message.text.trim().length > 0);
                return said.at(-1)?.text ?? null;
              }),
              Effect.orElseSucceed(() => null),
            )
        : null;
    const notification = buildThreadNotification({
      state,
      thread: { lastError: thread?.lastError ?? null },
      lastAssistantText,
      pending,
    });

    yield* Effect.logInfo("push: notifying devices of thread phase", {
      threadId,
      phase: state.phase,
      devices: devices.length,
      title: notification.title,
      subtitle: notification.subtitle,
      body: notification.body,
      category: notification.category ?? null,
    });

    yield* Effect.forEach(
      devices,
      (device) =>
        apns
          .send(credentials, {
            deviceToken: device.deviceToken,
            production: device.pushEnvironment === "production",
            title: notification.title,
            subtitle: notification.subtitle,
            body: notification.body,
            data: {
              threadId: state.threadId,
              environmentId: state.environmentId,
              deepLink: state.deepLink,
              ...(notification.requestId ? { requestId: notification.requestId } : {}),
            },
            ...(notification.category ? { category: notification.category } : {}),
            // One thread's notifications stack together, and its updates
            // replace each other rather than piling up stale alerts.
            threadId: state.threadId,
            collapseId: state.threadId,
          })
          .pipe(
            Effect.catch((error) =>
              error.tokenRejected
                ? registry.forget(device.deviceToken)
                : Effect.logWarning("push: APNs delivery failed", {
                    status: error.status,
                    reason: error.reason,
                  }),
            ),
          ),
      { concurrency: 4, discard: true },
    );
  });

  const sendTest = Effect.fn("PushNotifier.sendTest")(function* (installationId: string) {
    const devices = yield* registry.list;
    const device = devices.find((entry) => entry.installationId === installationId);
    if (device === undefined) {
      return { delivered: false, message: "That device is no longer registered." };
    }
    const credentials = yield* readApnsCredentials().pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settingsService),
    );
    if (credentials === null) {
      return {
        delivered: false,
        message: "Push is not configured: add the APNs key under Voice → Phone notifications.",
      };
    }
    return yield* apns
      .send(credentials, {
        deviceToken: device.deviceToken,
        production: device.pushEnvironment === "production",
        title: "Test notification",
        subtitle: device.deviceName ?? "This device",
        body: "Notifications from this environment reach this device.",
        data: {},
      })
      .pipe(
        Effect.as({ delivered: true }),
        Effect.catch((error) =>
          (error.tokenRejected ? registry.forget(device.deviceToken) : Effect.void).pipe(
            Effect.as({
              delivered: false,
              message: error.tokenRejected
                ? "Apple says this device's token is no longer valid; it was removed."
                : error.message,
            }),
          ),
        ),
      );
  });

  const start = Effect.gen(function* () {
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) => {
        const threadId = event.threadId;
        if (!shouldPublishAgentAwarenessEvent(event)) {
          return Effect.void;
        }
        return notifyThread(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("push: thread notification failed", { threadId, cause }),
          ),
        );
      }),
    );
  });

  return PushNotifier.of({ start, sendTest });
});

const serviceLayer = Layer.effect(PushNotifier, make);

/**
 * Self-arming: the subscription starts when the layer builds, so wiring push
 * into the server is one `provideMerge` and no edits to the orchestration
 * reactor. Keeps this feature additive against upstream.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const notifier = yield* PushNotifier;
    yield* notifier.start;
  }),
).pipe(Layer.provideMerge(serviceLayer));
