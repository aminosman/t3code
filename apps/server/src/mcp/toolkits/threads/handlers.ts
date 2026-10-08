/**
 * The `threads` toolkit, wired to the V2 orchestrator.
 *
 * Shells and commands go through `ThreadManagementService`, the same service
 * upstream's own MCP thread tools use; writes are `message.dispatch` and
 * `thread.archive` commands, so every invariant the UI is held to (no
 * archiving twice, no sending to a deleted thread) holds for
 * an agent too. `thread.delete` is never dispatched from here. Unlike
 * upstream's tools, these reach every project, not only the caller's.
 *
 * Message reads (the latest window, a window around one message, an archived
 * thread) go through `HistorySearch`, which reads the projection tables
 * directly. Meetings are files on this Mac and are read there too.
 *
 * The calling thread comes off the invocation scope and is the default
 * project for listing. It is also the one thread that cannot be
 * archived from here: it is running this very call.
 *
 * @module mcp/toolkits/threads/handlers
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
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
 * A message to an existing thread spends the user's allowance but makes no new
 * thread. Like AgentStartGuard's limits this only stops a runaway loop between
 * two agents, never a real conversation (Amin, Oct 7 2026: "really
 * permissive"); it was 30 until then.
 */
export const SENDS_PER_HOUR = 1000;
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

/** The V2 shell's status, in the words the tool has always used. */
const turnStateOf = (thread: OrchestrationV2ThreadShell): string | null => {
  if (thread.activeRunId !== null || thread.activityRunStatus != null) return "running";
  switch (thread.status) {
    case "idle":
      return thread.latestRunId === null ? null : "completed";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "interrupted";
    default:
      return "running";
  }
};

const summarizeThread = (
  thread: OrchestrationV2ThreadShell,
  callerThreadId: ThreadId,
): typeof ThreadSummary.Type => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  branch: thread.branch,
  turnState: turnStateOf(thread),
  updatedAt: DateTime.formatIso(thread.updatedAt),
  archivedAt: thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
  current: thread.id === callerThreadId,
});

const byMostRecent = (a: OrchestrationV2ThreadShell, b: OrchestrationV2ThreadShell) =>
  b.updatedAt.epochMilliseconds - a.updatedAt.epochMilliseconds;

const makeHandlers = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const history = yield* HistorySearch;
  const providerRegistry = yield* ProviderRegistry;
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
    const caller = yield* threads
      .getThreadShell(scope.threadId)
      .pipe(Effect.mapError(failWith("could not read the calling thread")));
    if (caller === null || caller.archivedAt !== null) {
      return yield* new ThreadToolError({
        reason: "the calling thread is no longer active",
      });
    }
    return caller;
  });

  const requireProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(failWith("could not read the project")));
      if (Option.isNone(project)) {
        return yield* new ThreadToolError({ reason: `no project with id ${projectId}` });
      }
      return project.value;
    });

  /** A thread that exists and is not archived, or a reason why not. */
  const requireActiveThread = (threadId: ThreadId, missing: string) =>
    Effect.gen(function* () {
      const thread = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(failWith("could not read the thread")));
      if (thread === null || thread.archivedAt !== null) {
        return yield* new ThreadToolError({ reason: missing });
      }
      return thread;
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
      readonly meetingParts?:
        | ReadonlyArray<"notes" | "action" | "decision" | "transcript" | "slides">
        | undefined;
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
          meetingParts: input.meetingParts,
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

    t3_any_thread_list: Effect.fn("ThreadsToolkit.t3_any_thread_list")(function* (input: {
      readonly projectId?: ProjectId | undefined;
      readonly includeArchived?: boolean | undefined;
    }) {
      const caller = yield* requireCaller;
      const projectId = input.projectId ?? caller.projectId;
      yield* requireProject(projectId);
      const active = yield* threads
        .getShellSnapshot()
        .pipe(Effect.mapError(failWith("could not list threads")));
      const archived = input.includeArchived
        ? yield* threads
            .getShellSnapshot({ location: "archive" })
            .pipe(Effect.mapError(failWith("could not list archived threads")))
        : null;
      const listed = [...active.threads, ...(archived?.archivedThreads ?? [])]
        .filter(
          (thread) =>
            thread.projectId === projectId && thread.lineage.relationshipToParent !== "subagent",
        )
        .sort(byMostRecent)
        .map((thread) => summarizeThread(thread, caller.id));
      return { threads: listed };
    }),

    t3_any_thread_read: Effect.fn("ThreadsToolkit.t3_any_thread_read")(function* (input: {
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
      const readRows = (window: {
        readonly aroundMessageId?: string | undefined;
        readonly before?: number | undefined;
        readonly after?: number | undefined;
      }) =>
        history
          .readMessages({ threadId: input.threadId, ...window })
          .pipe(Effect.mapError((error) => new ThreadToolError({ reason: error.reason })));
      if (input.aroundMessageId !== undefined) {
        const rows = yield* readRows({
          aroundMessageId: input.aroundMessageId,
          before: input.before,
          after: input.after,
        });
        if (rows === null) {
          return yield* new ThreadToolError({ reason: `no thread with id ${input.threadId}` });
        }
        return fromRows(rows, caller.id, maxChars);
      }
      // A turn is a prompt and its answer; the cursor is the oldest message
      // returned, and the next page is the window before it.
      const count = (input.turnLimit ?? DEFAULT_TURN_LIMIT) * 2;
      const rows =
        input.beforeCursor === undefined
          ? yield* readRows({ before: count - 1, after: 0 })
          : yield* readRows({ aroundMessageId: input.beforeCursor, before: count, after: 0 });
      if (rows === null) {
        return yield* new ThreadToolError({ reason: `no thread with id ${input.threadId}` });
      }
      const page =
        input.beforeCursor === undefined
          ? rows
          : { ...rows, messages: rows.messages.slice(0, -1), hasNewer: true };
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(failWith("could not read the thread")));
      const read = fromRows(page, caller.id, maxChars);
      return {
        ...read,
        thread: shell === null ? read.thread : summarizeThread(shell, caller.id),
        beforeCursor: page.hasOlder ? (page.messages[0]?.id ?? null) : null,
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

    t3_any_thread_send: Effect.fn("ThreadsToolkit.t3_any_thread_send")(function* (input: {
      readonly threadId: ThreadId;
      readonly message: string;
    }) {
      const caller = yield* requireCaller;
      if (input.threadId === caller.id) {
        return yield* new ThreadToolError({
          reason: "a thread cannot send a message to itself; just carry on",
        });
      }
      const target = yield* requireActiveThread(
        input.threadId,
        `no active thread with id ${input.threadId} (archived, or never existed); t3_any_thread_list shows the active ones`,
      );
      if (turnStateOf(target) === "running") {
        return yield* new ThreadToolError({
          reason: `thread "${target.title}" is working; t3_any_thread_wait for its turn to end, then send`,
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
      yield* threads
        .sendToThread({
          projectId: target.projectId,
          commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          threadId: target.id,
          senderThreadId: caller.id,
          messageId: MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          text,
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "mcp",
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

    t3_any_thread_wait: Effect.fn("ThreadsToolkit.t3_any_thread_wait")(function* (input: {
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
        const thread = yield* requireActiveThread(
          input.threadId,
          `no active thread with id ${input.threadId}`,
        );
        const turnState = turnStateOf(thread);
        const state =
          thread.pendingRuntimeRequest !== null
            ? ("needs-user" as const)
            : turnState === null || turnState === "running"
              ? ("running" as const)
              : turnState === "completed"
                ? ("done" as const)
                : (turnState as "interrupted" | "error");
        return { thread, state };
      });

      let seen = yield* look;
      if (seen.thread.latestRunId === null && seen.thread.latestUserMessageAt === null) {
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
        // A turn still running has no answer yet, only a draft of one.
        reply:
          reply === null || seen.state === "running" ? null : clip(reply.text, WAIT_REPLY_CHARS),
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
      yield* requireActiveThread(
        input.threadId,
        `no active thread with id ${input.threadId} (already archived, or never existed)`,
      );
      const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      yield* threads
        .dispatch({ type: "thread.archive", commandId, threadId: input.threadId })
        .pipe(Effect.mapError(failWith("could not archive the thread")));
      return { threadId: input.threadId, archived: true as const };
    }),
  } satisfies Parameters<typeof ThreadsToolkit.toLayer>[0];
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(makeHandlers);
