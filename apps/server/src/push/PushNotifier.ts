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
import { type AgentAwarenessPhase, projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import type { OrchestrationProjectShell, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  eventThreadId,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as PushDeviceRegistry from "./PushDeviceRegistry.ts";

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
  }
>()("t3/push/PushNotifier") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
  const apns = yield* ApnsClient.ApnsClient;

  const phaseByThread = new Map<ThreadId, AgentAwarenessPhase | null>();

  const readCredentials = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchTag("ServerSettingsError", (cause) =>
        Effect.logWarning("push: failed to read settings", { cause }).pipe(Effect.as(undefined)),
      ),
    );
    const push = settings?.push;
    if (
      !push?.enabled ||
      push.authKey.length === 0 ||
      push.keyId.length === 0 ||
      push.teamId.length === 0 ||
      push.bundleId.length === 0
    ) {
      return null;
    }
    return {
      teamId: push.teamId,
      keyId: push.keyId,
      privateKey: push.authKey,
      bundleId: push.bundleId,
    } satisfies ApnsClient.ApnsCredentials;
  });

  const notifyThread = Effect.fn("PushNotifier.notifyThread")(function* (threadId: ThreadId) {
    const credentials = yield* readCredentials;
    if (credentials === null) {
      return;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const thread = yield* snapshotQuery.getThreadShellById(threadId);
    const project = Option.isSome(thread)
      ? yield* snapshotQuery.getProjectShellById(thread.value.projectId)
      : Option.none<OrchestrationProjectShell>();

    const state =
      Option.isSome(thread) && Option.isSome(project)
        ? projectThreadAwareness({
            environmentId,
            project: project.value,
            thread: thread.value,
          })
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

    yield* Effect.logInfo("push: notifying devices of thread phase", {
      threadId,
      phase: state.phase,
      devices: devices.length,
    });

    yield* Effect.forEach(
      devices,
      (device) =>
        apns
          .send(credentials, {
            deviceToken: device.deviceToken,
            production: device.pushEnvironment === "production",
            title: `${state.projectTitle} · ${state.headline}`,
            body: state.detail ?? state.threadTitle,
            data: {
              threadId: state.threadId,
              environmentId: state.environmentId,
              deepLink: state.deepLink,
            },
            // One thread's updates replace each other on the lock screen
            // rather than stacking into a wall of stale alerts.
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

  const start = Effect.gen(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = eventThreadId(event);
        if (threadId === null || !shouldPublishAgentAwarenessEvent(event)) {
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

  return PushNotifier.of({ start });
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
