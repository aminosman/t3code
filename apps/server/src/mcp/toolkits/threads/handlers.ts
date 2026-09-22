/**
 * The `threads` toolkit, wired to the projection and the engine.
 *
 * Reads go through `ProjectionSnapshotQuery`, the same service the HTTP
 * snapshot routes use; writes go through `OrchestrationEngineService.dispatch`
 * as `thread.create` and `thread.archive` commands, so every invariant the UI
 * is held to (no archiving twice, no creating in a deleted project) holds for
 * an agent too. `thread.delete` is never dispatched from here.
 *
 * Search, and any read the snapshot cannot serve (a window around one message,
 * an archived thread), go through `HistorySearch`, which reads the projection
 * tables directly. Meetings are files on this Mac and are read there too.
 *
 * The calling thread comes off the invocation scope and is the default
 * project for listing and creating. It is also the one thread that cannot be
 * archived from here: it is running this very call.
 *
 * @module mcp/toolkits/threads/handlers
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { HistorySearch, type ThreadMessagesOutput } from "../../../historySearch/HistorySearch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { type ThreadSummary, ThreadsToolkit, ThreadToolError } from "./tools.ts";

const DEFAULT_TURN_LIMIT = 10;
const DEFAULT_MAX_CHARS = 6000;
const WAIT_REPLY_CHARS = 12_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 900;
const WAIT_POLL = "2 seconds";
/**
 * A thread an agent starts spends the user's allowance and lands in their
 * sidebar. One thread may start a handful an hour — a review, a second
 * opinion — and a thread that was itself started by an agent may start none,
 * so a review cannot ask for a review of itself without end.
 */
const STARTS_PER_HOUR = 5;
/**
 * A message to an existing thread spends the same allowance but makes no new
 * thread, so the cap is looser: enough for a conversation with a reviewer,
 * not enough for a loop between two agents to run unattended for long.
 */
const SENDS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;

/** Why a provider cannot be picked right now; null when it can. */
const unusableBecause = (provider: ServerProvider): string | null => {
  if (provider.availability === "unavailable") {
    return provider.unavailableReason ?? "its driver is not available in this build";
  }
  if (!provider.enabled) return "disabled in settings";
  if (!provider.installed) return "not installed";
  if (provider.auth.status === "unauthenticated") return "not signed in";
  if (provider.status === "error" || provider.status === "disabled") {
    return provider.message ?? `status is ${provider.status}`;
  }
  return null;
};

/**
 * A long message keeps its start and its end: the start says what was asked
 * or attempted, the end says how it came out, and the middle is where the
 * tool output and the working-out live.
 */
const clip = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…[${text.length - maxChars} characters cut]…\n${text.slice(text.length - tail)}`;
};

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
};

const failWith = (prefix: string) => (cause: unknown) =>
  new ThreadToolError({ reason: `${prefix}: ${describeCause(cause)}` });

const summarizeThread = (
  thread: Pick<
    OrchestrationThreadShell,
    "id" | "projectId" | "title" | "branch" | "latestTurn" | "updatedAt" | "archivedAt"
  >,
  callerThreadId: ThreadId,
): typeof ThreadSummary.Type => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  branch: thread.branch,
  turnState: thread.latestTurn?.state ?? null,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  current: thread.id === callerThreadId,
});

const byMostRecent = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  b.updatedAt.localeCompare(a.updatedAt);

const makeHandlers = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const history = yield* HistorySearch;
  const providerRegistry = yield* ProviderRegistry;
  const startedByAgents = yield* Ref.make<ReadonlySet<string>>(new Set());
  const startsByCaller = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map());
  const sendsByCaller = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map());
  const crypto = yield* Crypto.Crypto;

  const requireScope = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("threads")) {
      return yield* new ThreadToolError({
        reason: "this agent session was not granted access to Roost threads",
      });
    }
    return scope;
  });

  /** The thread making the call, as the projection sees it right now. */
  const requireCaller = Effect.gen(function* () {
    const scope = yield* requireScope;
    const caller = yield* query
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError(failWith("could not read the calling thread")));
    if (Option.isNone(caller)) {
      return yield* new ThreadToolError({
        reason: "the calling thread is no longer active",
      });
    }
    return caller.value;
  });

  const requireProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* query
        .getProjectShellById(projectId)
        .pipe(Effect.mapError(failWith("could not read the project")));
      if (Option.isNone(project)) {
        return yield* new ThreadToolError({ reason: `no project with id ${projectId}` });
      }
      return project.value satisfies OrchestrationProjectShell;
    });

  const fromRows = (rows: ThreadMessagesOutput, callerThreadId: ThreadId, maxChars: number) => ({
    thread: {
      id: ThreadId.make(rows.thread.id),
      projectId: rows.thread.projectId as ProjectId,
      title: rows.thread.title,
      branch: rows.thread.branch,
      // The turn state lives in the snapshot; a window read does not need it.
      turnState: null,
      updatedAt: rows.thread.updatedAt,
      archivedAt: rows.thread.archivedAt,
      current: rows.thread.id === callerThreadId,
    },
    messages: rows.messages.map((message) => ({ ...message, text: clip(message.text, maxChars) })),
    beforeCursor: null,
    hasOlder: rows.hasOlder,
    hasNewer: rows.hasNewer,
  });

  return {
    t3_history_search: Effect.fn("ThreadsToolkit.t3_history_search")(function* (input: {
      readonly query: string;
      readonly sources?: ReadonlyArray<"threads" | "meetings"> | undefined;
      readonly projectId?: ProjectId | undefined;
      readonly role?: "user" | "assistant" | undefined;
      readonly since?: string | undefined;
      readonly includeCurrent?: boolean | undefined;
      readonly limit?: number | undefined;
    }) {
      const scope = yield* requireScope;
      return yield* history
        .search({
          query: input.query,
          sources: input.sources,
          projectId: input.projectId,
          role: input.role,
          since: input.since,
          limit: input.limit,
          excludeThreadId: input.includeCurrent ? undefined : scope.threadId,
          caller: { threadId: scope.threadId, provider: scope.providerInstanceId },
        })
        .pipe(Effect.mapError((error) => new ThreadToolError({ reason: error.reason })));
    }),

    t3_history_feedback: Effect.fn("ThreadsToolkit.t3_history_feedback")(function* (input: {
      readonly found: boolean;
      readonly searchId?: number | undefined;
      readonly note?: string | undefined;
    }) {
      const scope = yield* requireScope;
      const searchId = yield* history.recordFeedback({
        callerThreadId: scope.threadId,
        searchId: input.searchId,
        found: input.found,
        note: input.note,
      });
      return { recorded: true, searchId };
    }),

    t3_meeting_list: Effect.fn("ThreadsToolkit.t3_meeting_list")(function* (input: {
      readonly since?: string | undefined;
      readonly limit?: number | undefined;
    }) {
      yield* requireScope;
      const meetings = yield* history
        .listMeetings(input)
        .pipe(Effect.mapError((error) => new ThreadToolError({ reason: error.reason })));
      return { meetings };
    }),

    t3_meeting_read: Effect.fn("ThreadsToolkit.t3_meeting_read")(function* (input: {
      readonly meetingId: string;
      readonly around?: string | undefined;
      readonly minutes?: number | undefined;
    }) {
      const scope = yield* requireScope;
      yield* history.recordOpen({
        callerThreadId: scope.threadId,
        kind: "meeting",
        id: input.meetingId,
      });
      const read = yield* history
        .readMeeting(input)
        .pipe(Effect.mapError((error) => new ThreadToolError({ reason: error.reason })));
      if (read === null) {
        return yield* new ThreadToolError({
          reason: `no meeting with id ${input.meetingId}; t3_meeting_list shows the ones there are`,
        });
      }
      return {
        ...read,
        notes: read.notes === null ? null : clip(read.notes, DEFAULT_MAX_CHARS * 2),
        lines: read.lines.map((line) => ({ at: line.at, speaker: line.speaker, text: line.text })),
      };
    }),

    t3_project_list: Effect.fn("ThreadsToolkit.t3_project_list")(function* (input: {
      readonly includeArchived?: boolean | undefined;
    }) {
      const caller = yield* requireCaller;
      const shell = yield* query
        .getShellSnapshot()
        .pipe(Effect.mapError(failWith("could not list projects")));
      const counts = new Map<ProjectId, number>();
      for (const thread of shell.threads) {
        if (thread.archivedAt !== null && !input.includeArchived) continue;
        counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
      }
      return {
        projects: shell.projects.map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          threadCount: counts.get(project.id) ?? 0,
          current: project.id === caller.projectId,
        })),
      };
    }),

    t3_thread_list: Effect.fn("ThreadsToolkit.t3_thread_list")(function* (input: {
      readonly projectId?: ProjectId | undefined;
      readonly includeArchived?: boolean | undefined;
    }) {
      const caller = yield* requireCaller;
      const projectId = input.projectId ?? caller.projectId;
      yield* requireProject(projectId);
      const active = yield* query
        .getShellSnapshot()
        .pipe(Effect.mapError(failWith("could not list threads")));
      const archived = input.includeArchived
        ? yield* query
            .getArchivedShellSnapshot()
            .pipe(Effect.mapError(failWith("could not list archived threads")))
        : null;
      const threads = [...active.threads, ...(archived?.threads ?? [])]
        .filter((thread) => thread.projectId === projectId)
        .sort(byMostRecent)
        .map((thread) => summarizeThread(thread, caller.id));
      return { threads };
    }),

    t3_thread_read: Effect.fn("ThreadsToolkit.t3_thread_read")(function* (input: {
      readonly threadId: ThreadId;
      readonly aroundMessageId?: string | undefined;
      readonly before?: number | undefined;
      readonly after?: number | undefined;
      readonly maxCharsPerMessage?: number | undefined;
      readonly turnLimit?: number | undefined;
      readonly beforeCursor?: string | undefined;
    }) {
      const caller = yield* requireCaller;
      yield* history.recordOpen({ callerThreadId: caller.id, kind: "thread", id: input.threadId });
      const maxChars = input.maxCharsPerMessage ?? DEFAULT_MAX_CHARS;
      const readRows = history
        .readMessages({
          threadId: input.threadId,
          aroundMessageId: input.aroundMessageId,
          before: input.before,
          after: input.after,
        })
        .pipe(Effect.mapError((error) => new ThreadToolError({ reason: error.reason })));
      if (input.aroundMessageId !== undefined) {
        const rows = yield* readRows;
        if (rows === null) {
          return yield* new ThreadToolError({ reason: `no thread with id ${input.threadId}` });
        }
        return fromRows(rows, caller.id, maxChars);
      }
      const snapshot = yield* query
        .getThreadDetailSnapshot(input.threadId, {
          turnLimit: input.turnLimit ?? DEFAULT_TURN_LIMIT,
          ...(input.beforeCursor !== undefined ? { beforeCursor: input.beforeCursor } : {}),
        })
        .pipe(Effect.mapError(failWith("could not read the thread")));
      if (Option.isNone(snapshot)) {
        // Archived: not in the snapshot, still in the projection.
        const rows = yield* readRows;
        if (rows === null) {
          return yield* new ThreadToolError({ reason: `no thread with id ${input.threadId}` });
        }
        return fromRows(rows, caller.id, maxChars);
      }
      const thread = snapshot.value.thread;
      return {
        thread: summarizeThread(thread, caller.id),
        messages: thread.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: clip(message.text, maxChars),
          createdAt: message.createdAt,
          streaming: message.streaming,
        })),
        beforeCursor: snapshot.value.page?.hasMore
          ? (snapshot.value.page.beforeCursor ?? null)
          : null,
        hasOlder: snapshot.value.page?.hasMore ?? false,
        hasNewer: false,
      };
    }),

    t3_model_list: Effect.fn("ThreadsToolkit.t3_model_list")(function* (input: {
      readonly includeUnusable?: boolean | undefined;
    }) {
      const caller = yield* requireCaller;
      const providers = yield* providerRegistry.getProviders;
      return {
        providers: providers
          .map((provider) => {
            const reason = unusableBecause(provider);
            const current = provider.instanceId === caller.modelSelection.instanceId;
            return {
              instanceId: provider.instanceId,
              provider: provider.driver,
              name: provider.displayName ?? provider.driver,
              account: provider.auth.email ?? provider.auth.label ?? null,
              usable: reason === null,
              unusableBecause: reason,
              current,
              usage: (provider.usageLimits?.windows ?? []).map((window) => ({
                label: window.label,
                usedPercent: Math.round(window.usedPercent),
                resetsAt: window.resetsAt ?? null,
              })),
              models: provider.models
                .filter((model) => model.isLegacy !== true)
                .map((model) => ({
                  model: model.slug,
                  name: model.name,
                  isDefault: model.isDefault === true,
                  isNew: model.badge === "new",
                  current: current && model.slug === caller.modelSelection.model,
                  options: (model.capabilities?.optionDescriptors ?? []).map((option) =>
                    option.type === "select"
                      ? {
                          id: option.id,
                          label: option.label,
                          type: "select" as const,
                          choices: option.options.map((choice) => choice.id),
                          default:
                            option.options.find((choice) => choice.isDefault === true)?.id ??
                            option.currentValue ??
                            null,
                        }
                      : {
                          id: option.id,
                          label: option.label,
                          type: "boolean" as const,
                          choices: [],
                          default: option.currentValue ?? null,
                        },
                  ),
                })),
            };
          })
          .filter((provider) => provider.usable || input.includeUnusable === true),
      };
    }),

    t3_thread_create: Effect.fn("ThreadsToolkit.t3_thread_create")(function* (input: {
      readonly title: string;
      readonly projectId?: ProjectId | undefined;
      readonly prompt?: string | undefined;
      readonly model?:
        | {
            readonly instanceId: string;
            readonly model: string;
            readonly options?: Readonly<Record<string, string | boolean>> | undefined;
          }
        | undefined;
    }) {
      const caller = yield* requireCaller;
      const project = yield* requireProject(input.projectId ?? caller.projectId);
      const prompt = input.prompt?.trim();
      const now = yield* Clock.currentTimeMillis;

      if (prompt !== undefined) {
        if ((yield* Ref.get(startedByAgents)).has(caller.id)) {
          return yield* new ThreadToolError({
            reason:
              "this thread was itself started by an agent, and such a thread cannot start " +
              "others; report back in your reply and let the thread that asked decide",
          });
        }
        const recent = ((yield* Ref.get(startsByCaller)).get(caller.id) ?? []).filter(
          (at) => now - at < HOUR_MS,
        );
        if (recent.length >= STARTS_PER_HOUR) {
          return yield* new ThreadToolError({
            reason: `this thread has already started ${STARTS_PER_HOUR} threads in the last hour; ask the user before starting more`,
          });
        }
      }

      let modelSelection: ModelSelection = project.defaultModelSelection ?? caller.modelSelection;
      if (input.model !== undefined) {
        const chosen = input.model;
        const providers = yield* providerRegistry.getProviders;
        const provider = providers.find((candidate) => candidate.instanceId === chosen.instanceId);
        if (provider === undefined) {
          return yield* new ThreadToolError({
            reason: `no provider instance "${chosen.instanceId}"; t3_model_list shows the ones set up (${providers.map((p) => p.instanceId).join(", ")})`,
          });
        }
        const reason = unusableBecause(provider);
        if (reason !== null) {
          return yield* new ThreadToolError({
            reason: `provider "${chosen.instanceId}" cannot be used right now: ${reason}`,
          });
        }
        const model = provider.models.find(
          (candidate) =>
            candidate.slug === chosen.model || candidate.aliases?.includes(chosen.model) === true,
        );
        if (model === undefined) {
          return yield* new ThreadToolError({
            reason: `"${chosen.instanceId}" has no model "${chosen.model}"; it has: ${provider.models.map((m) => m.slug).join(", ")}`,
          });
        }
        const descriptors = model.capabilities?.optionDescriptors ?? [];
        const options = Object.entries(chosen.options ?? {});
        for (const [id, value] of options) {
          const descriptor = descriptors.find((candidate) => candidate.id === id);
          if (descriptor === undefined) {
            return yield* new ThreadToolError({
              reason: `model "${model.slug}" has no option "${id}"; it has: ${descriptors.map((d) => d.id).join(", ") || "none"}`,
            });
          }
          if (
            descriptor.type === "select" &&
            !descriptor.options.some((choice) => choice.id === value)
          ) {
            return yield* new ThreadToolError({
              reason: `option "${id}" of "${model.slug}" takes one of: ${descriptor.options.map((c) => c.id).join(", ")}`,
            });
          }
        }
        modelSelection = {
          instanceId: ProviderInstanceId.make(provider.instanceId),
          model: model.slug,
          ...(options.length > 0 ? { options: options.map(([id, value]) => ({ id, value })) } : {}),
        } as ModelSelection;
      }

      const threadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const title = input.title.trim();
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId,
          threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        })
        .pipe(Effect.mapError(failWith("could not create the thread")));

      if (prompt !== undefined) {
        // Said in the message itself, so the user reading the new thread and
        // the agent answering it both know nobody typed this.
        const text =
          `[Started by the agent in thread "${caller.title}" (${caller.id}), not typed by the user. ` +
          `You have none of that thread's context beyond what follows; t3_thread_read can read it ` +
          `if you need it. Answer in your reply — that thread will read it.]\n\n${prompt}`;
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
            threadId,
            message: {
              messageId: MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
              role: "user",
              text,
              attachments: [],
            },
            modelSelection,
            runtimeMode: caller.runtimeMode,
            interactionMode: caller.interactionMode,
            createdAt,
          })
          .pipe(Effect.mapError(failWith("the thread was created but could not be started")));
        yield* Ref.update(startedByAgents, (set) => new Set([...set, threadId]));
        yield* Ref.update(startsByCaller, (map) => {
          const recent = (map.get(caller.id) ?? []).filter((at) => now - at < HOUR_MS);
          return new Map([...map, [caller.id, [...recent, now]]]);
        });
      }
      return {
        threadId,
        projectId: project.id,
        title,
        started: prompt !== undefined,
        model: { instanceId: modelSelection.instanceId, model: modelSelection.model },
      };
    }),

    t3_thread_send: Effect.fn("ThreadsToolkit.t3_thread_send")(function* (input: {
      readonly threadId: ThreadId;
      readonly message: string;
    }) {
      const caller = yield* requireCaller;
      if (input.threadId === caller.id) {
        return yield* new ThreadToolError({
          reason: "a thread cannot send a message to itself; just carry on",
        });
      }
      const shell = yield* query
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(failWith("could not read the thread")));
      if (Option.isNone(shell)) {
        return yield* new ThreadToolError({
          reason: `no active thread with id ${input.threadId} (archived, or never existed); t3_thread_list shows the active ones`,
        });
      }
      const target = shell.value;
      if (target.latestTurn?.state === "running") {
        return yield* new ThreadToolError({
          reason: `thread "${target.title}" is working; t3_thread_wait for its turn to end, then send`,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const recent = ((yield* Ref.get(sendsByCaller)).get(caller.id) ?? []).filter(
        (at) => now - at < HOUR_MS,
      );
      if (recent.length >= SENDS_PER_HOUR) {
        return yield* new ThreadToolError({
          reason: `this thread has already sent ${SENDS_PER_HOUR} messages to other threads in the last hour; ask the user before sending more`,
        });
      }
      // Said in the message itself, so the user reading that thread and the
      // agent answering it both know nobody typed this.
      const text =
        `[Sent by the agent in thread "${caller.title}" (${caller.id}), not typed by the user. ` +
        `Answer in your reply — that thread will read it.]\n\n${input.message.trim()}`;
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          threadId: target.id,
          message: {
            messageId: MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
            role: "user",
            text,
            attachments: [],
          },
          modelSelection: target.modelSelection,
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(failWith("could not send the message")));
      yield* Ref.update(sendsByCaller, (map) => new Map([...map, [caller.id, [...recent, now]]]));
      return {
        threadId: target.id,
        title: target.title,
        sent: true as const,
        model: { instanceId: target.modelSelection.instanceId, model: target.modelSelection.model },
      };
    }),

    t3_thread_wait: Effect.fn("ThreadsToolkit.t3_thread_wait")(function* (input: {
      readonly threadId: ThreadId;
      readonly timeoutSeconds?: number | undefined;
    }) {
      const caller = yield* requireCaller;
      if (input.threadId === caller.id) {
        return yield* new ThreadToolError({ reason: "a thread cannot wait for itself" });
      }
      const timeoutMs =
        Math.min(MAX_WAIT_SECONDS, input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
      const startedAt = yield* Clock.currentTimeMillis;
      const look = Effect.gen(function* () {
        const shell = yield* query
          .getThreadShellById(input.threadId)
          .pipe(Effect.mapError(failWith("could not read the thread")));
        if (Option.isNone(shell)) {
          return yield* new ThreadToolError({
            reason: `no active thread with id ${input.threadId}`,
          });
        }
        const thread = shell.value;
        const state =
          thread.hasPendingApprovals || thread.hasPendingUserInput
            ? ("needs-user" as const)
            : thread.latestTurn === null || thread.latestTurn.state === "running"
              ? ("running" as const)
              : thread.latestTurn.state === "completed"
                ? ("done" as const)
                : thread.latestTurn.state;
        return { thread, state };
      });

      let seen = yield* look;
      if (seen.thread.latestTurn === null && seen.thread.latestUserMessageAt === null) {
        return yield* new ThreadToolError({
          reason: "nothing has been sent to that thread, so there is no turn to wait for",
        });
      }
      while (seen.state === "running" && (yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
        yield* Effect.sleep(WAIT_POLL);
        seen = yield* look;
      }
      const tail = yield* history
        .readMessages({ threadId: input.threadId, before: 8, after: 0 })
        .pipe(Effect.mapError((error) => new ThreadToolError({ reason: error.reason })));
      const reply = tail?.messages.findLast((message) => message.role === "assistant") ?? null;
      return {
        thread: summarizeThread(seen.thread, caller.id),
        state: seen.state,
        reply: reply === null ? null : clip(reply.text, WAIT_REPLY_CHARS),
        waitedSeconds: Math.round(((yield* Clock.currentTimeMillis) - startedAt) / 1000),
      };
    }),

    t3_thread_archive: Effect.fn("ThreadsToolkit.t3_thread_archive")(function* (input: {
      readonly threadId: ThreadId;
    }) {
      const caller = yield* requireCaller;
      if (input.threadId === caller.id) {
        return yield* new ThreadToolError({
          reason: "a thread cannot archive itself while it is running; ask the user to",
        });
      }
      const target = yield* query
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(failWith("could not read the thread")));
      if (Option.isNone(target)) {
        return yield* new ThreadToolError({
          reason: `no active thread with id ${input.threadId} (already archived, or never existed)`,
        });
      }
      const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      yield* engine
        .dispatch({ type: "thread.archive", commandId, threadId: input.threadId })
        .pipe(Effect.mapError(failWith("could not archive the thread")));
      return { threadId: input.threadId, archived: true as const };
    }),
  } satisfies Parameters<typeof ThreadsToolkit.toLayer>[0];
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(makeHandlers);
