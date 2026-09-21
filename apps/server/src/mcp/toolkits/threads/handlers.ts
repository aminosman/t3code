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
 * an archived thread), go through `ThreadSearch`, which reads the projection
 * tables directly.
 *
 * The calling thread comes off the invocation scope and is the default
 * project for listing and creating. It is also the one thread that cannot be
 * archived from here: it is running this very call.
 *
 * @module mcp/toolkits/threads/handlers
 */
import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadSearch, type ThreadMessagesOutput } from "../../../threadSearch/ThreadSearch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { type ThreadSummary, ThreadsToolkit, ThreadToolError } from "./tools.ts";

const DEFAULT_TURN_LIMIT = 10;
const DEFAULT_MAX_CHARS = 6000;

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
  const threadSearch = yield* ThreadSearch;
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
    t3_thread_search: Effect.fn("ThreadsToolkit.t3_thread_search")(function* (input: {
      readonly query: string;
      readonly projectId?: ProjectId | undefined;
      readonly role?: "user" | "assistant" | undefined;
      readonly since?: string | undefined;
      readonly includeCurrent?: boolean | undefined;
      readonly limit?: number | undefined;
    }) {
      const scope = yield* requireScope;
      const found = yield* threadSearch
        .search({
          query: input.query,
          projectId: input.projectId,
          role: input.role,
          since: input.since,
          limit: input.limit,
          excludeThreadId: input.includeCurrent ? undefined : scope.threadId,
        })
        .pipe(Effect.mapError((error) => new ThreadToolError({ reason: error.reason })));
      return {
        terms: found.terms,
        results: found.results.map((result) => ({
          ...result,
          threadId: ThreadId.make(result.threadId),
          projectId: result.projectId as ProjectId,
        })),
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
      const maxChars = input.maxCharsPerMessage ?? DEFAULT_MAX_CHARS;
      const readRows = threadSearch
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

    t3_thread_create: Effect.fn("ThreadsToolkit.t3_thread_create")(function* (input: {
      readonly title: string;
      readonly projectId?: ProjectId | undefined;
    }) {
      const caller = yield* requireCaller;
      const project = yield* requireProject(input.projectId ?? caller.projectId);
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
          modelSelection: project.defaultModelSelection ?? caller.modelSelection,
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        })
        .pipe(Effect.mapError(failWith("could not create the thread")));
      return { threadId, projectId: project.id, title };
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
