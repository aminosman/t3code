import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadSearch, type ThreadSearchInput } from "../../../threadSearch/ThreadSearch.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const homeProjectId = ProjectId.make("project-home");
const workProjectId = ProjectId.make("project-work");
const callerThreadId = ThreadId.make("thread-caller");
const siblingThreadId = ThreadId.make("thread-sibling");
const workThreadId = ThreadId.make("thread-work");
const archivedThreadId = ThreadId.make("thread-archived");

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

const project = (id: ProjectId, title: string): OrchestrationProject => ({
  id,
  title,
  workspaceRoot: `/tmp/${title}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-19T10:00:00.000Z",
  updatedAt: "2026-09-19T10:00:00.000Z",
  deletedAt: null,
});

const shell = (
  id: ThreadId,
  projectId: ProjectId,
  title: string,
  updatedAt: string,
  archivedAt: string | null = null,
): OrchestrationThreadShell => ({
  id,
  projectId,
  title,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn:
    id === siblingThreadId
      ? {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: updatedAt,
          startedAt: updatedAt,
          completedAt: null,
          assistantMessageId: null,
        }
      : null,
  createdAt: updatedAt,
  updatedAt,
  archivedAt,
  pullRequests: [],
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const projects = [project(homeProjectId, "home"), project(workProjectId, "work")];
const activeThreads = [
  shell(callerThreadId, homeProjectId, "caller", "2026-09-19T10:01:00.000Z"),
  shell(siblingThreadId, homeProjectId, "sibling", "2026-09-19T10:05:00.000Z"),
  shell(workThreadId, workProjectId, "work thread", "2026-09-19T10:02:00.000Z"),
];
const archivedThreads = [
  shell(
    archivedThreadId,
    homeProjectId,
    "old",
    "2026-09-19T09:00:00.000Z",
    "2026-09-19T09:30:00.000Z",
  ),
];

const siblingDetail: OrchestrationThread = {
  ...activeThreads[1]!,
  messages: [
    {
      id: MessageId.make("m1"),
      role: "user",
      text: "hello",
      turnId: TurnId.make("turn-1"),
      streaming: false,
      createdAt: "2026-09-19T10:04:00.000Z",
      updatedAt: "2026-09-19T10:04:00.000Z",
    },
    {
      id: MessageId.make("m2"),
      role: "assistant",
      text: "hi",
      turnId: TurnId.make("turn-1"),
      streaming: true,
      createdAt: "2026-09-19T10:05:00.000Z",
      updatedAt: "2026-09-19T10:05:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  deletedAt: null,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (capabilities: ReadonlySet<McpInvocationContext.McpCapability>) =>
  ({
    environmentId: EnvironmentId.make("environment-1"),
    threadId: callerThreadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities,
    issuedAt: 1,
  }) satisfies McpInvocationContext.McpInvocationScope;

const makeHarness = Effect.gen(function* () {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const searched = yield* Ref.make<ReadonlyArray<ThreadSearchInput>>([]);
  const layer = McpHttpServer.ThreadsToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects,
            threads: activeThreads,
            updatedAt: "2026-09-19T10:05:00.000Z",
          }),
        getArchivedShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects,
            threads: archivedThreads,
            updatedAt: "2026-09-19T10:05:00.000Z",
          }),
        getProjectShellById: (projectId) =>
          Effect.succeed(Option.fromUndefinedOr(projects.find((p) => p.id === projectId))),
        getThreadShellById: (threadId) =>
          Effect.succeed(Option.fromUndefinedOr(activeThreads.find((t) => t.id === threadId))),
        getThreadDetailSnapshot: (threadId, window) =>
          Effect.succeed(
            threadId === siblingThreadId
              ? Option.some({
                  snapshotSequence: 1,
                  thread: siblingDetail,
                  page: {
                    beforeCursor: `cursor-${window?.turnLimit ?? "all"}`,
                    hasMore: true,
                    snapshotSequence: 1,
                  },
                })
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadSearch)({
        search: (input) =>
          Ref.update(searched, (inputs) => [...inputs, input]).pipe(
            Effect.as({
              terms: ['"login"'],
              results: [
                {
                  threadId: archivedThreadId,
                  projectId: homeProjectId,
                  projectTitle: "home",
                  title: "old",
                  updatedAt: "2026-09-19T09:00:00.000Z",
                  archivedAt: "2026-09-19T09:30:00.000Z",
                  score: 4.2,
                  matchedTerms: 1,
                  hitCount: 1,
                  hits: [
                    {
                      messageId: "old-2",
                      role: "user",
                      createdAt: "2026-09-19T09:01:00.000Z",
                      snippet: "the «login» loops",
                    },
                  ],
                },
              ],
            }),
          ),
        readMessages: (input) =>
          Effect.succeed(
            input.threadId === archivedThreadId
              ? {
                  thread: {
                    id: archivedThreadId,
                    projectId: homeProjectId,
                    title: "old",
                    branch: null,
                    updatedAt: "2026-09-19T09:00:00.000Z",
                    archivedAt: "2026-09-19T09:30:00.000Z",
                  },
                  messages: [
                    {
                      id: "old-2",
                      role: "user",
                      text: `the login loops ${"x".repeat(200)} and that is the end`,
                      createdAt: "2026-09-19T09:01:00.000Z",
                      streaming: false,
                    },
                  ],
                  hasOlder: input.aroundMessageId !== undefined,
                  hasNewer: false,
                }
              : null,
          ),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { dispatched, searched, layer };
});

const call = (
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["threads"]),
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("lists projects with active thread counts and marks the caller's project", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeHarness;
    const result = yield* call("t3_project_list", {}).pipe(Effect.provide(layer));
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      projects: [
        {
          id: homeProjectId,
          title: "home",
          workspaceRoot: "/tmp/home",
          threadCount: 2,
          current: true,
        },
        {
          id: workProjectId,
          title: "work",
          workspaceRoot: "/tmp/work",
          threadCount: 1,
          current: false,
        },
      ],
    });
  }),
);

it.effect("lists the caller's project by default, newest first, archived only on request", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeHarness;
    const active = yield* call("t3_thread_list", {}).pipe(Effect.provide(layer));
    const activeThreadsOut = (active.structuredContent as { threads: Array<{ id: string }> })
      .threads;
    expect(activeThreadsOut.map((t) => t.id)).toEqual([siblingThreadId, callerThreadId]);
    expect(
      (active.structuredContent as { threads: Array<{ turnState: string | null }> }).threads[0]
        ?.turnState,
    ).toBe("running");

    const withArchived = yield* call("t3_thread_list", { includeArchived: true }).pipe(
      Effect.provide(layer),
    );
    expect(
      (withArchived.structuredContent as { threads: Array<{ id: string }> }).threads.map(
        (t) => t.id,
      ),
    ).toEqual([siblingThreadId, callerThreadId, archivedThreadId]);

    const other = yield* call("t3_thread_list", { projectId: workProjectId }).pipe(
      Effect.provide(layer),
    );
    expect(
      (other.structuredContent as { threads: Array<{ id: string }> }).threads.map((t) => t.id),
    ).toEqual([workThreadId]);

    const missing = yield* call("t3_thread_list", { projectId: "project-missing" }).pipe(
      Effect.provide(layer),
    );
    expect(missing.isError).toBe(true);
  }),
);

it.effect("reads a thread's messages with a paging cursor", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeHarness;
    const result = yield* call("t3_thread_read", { threadId: siblingThreadId, turnLimit: 3 }).pipe(
      Effect.provide(layer),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      thread: { id: siblingThreadId, current: false, turnState: "running" },
      messages: [
        { id: "m1", role: "user", text: "hello", streaming: false },
        { id: "m2", role: "assistant", text: "hi", streaming: true },
      ],
      beforeCursor: "cursor-3",
    });

    const missing = yield* call("t3_thread_read", { threadId: "thread-nowhere" }).pipe(
      Effect.provide(layer),
    );
    expect(missing.isError).toBe(true);
  }),
);

it.effect("searches every project, leaving the calling thread out unless asked", () =>
  Effect.gen(function* () {
    const { searched, layer } = yield* makeHarness;
    const result = yield* call("t3_thread_search", { query: "why does the login loop" }).pipe(
      Effect.provide(layer),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      terms: ['"login"'],
      results: [
        {
          threadId: archivedThreadId,
          projectTitle: "home",
          hits: [{ messageId: "old-2", snippet: "the «login» loops" }],
        },
      ],
    });
    yield* call("t3_thread_search", { query: "login", includeCurrent: true, role: "user" }).pipe(
      Effect.provide(layer),
    );
    const inputs = yield* Ref.get(searched);
    expect(inputs[0]).toMatchObject({ excludeThreadId: callerThreadId, projectId: undefined });
    expect(inputs[1]).toMatchObject({ excludeThreadId: undefined, role: "user" });
  }),
);

it.effect("reads around a search hit, archived threads included, and clips long messages", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeHarness;
    const around = yield* call("t3_thread_read", {
      threadId: archivedThreadId,
      aroundMessageId: "old-2",
      maxCharsPerMessage: 60,
    }).pipe(Effect.provide(layer));
    expect(around.isError).toBe(false);
    const content = around.structuredContent as {
      thread: { id: string; archivedAt: string | null };
      messages: Array<{ id: string; text: string }>;
      hasOlder: boolean;
    };
    expect(content.thread).toMatchObject({ id: archivedThreadId });
    expect(content.thread.archivedAt).not.toBeNull();
    expect(content.hasOlder).toBe(true);
    expect(content.messages[0]?.text.startsWith("the login loops")).toBe(true);
    expect(content.messages[0]?.text.endsWith("that is the end")).toBe(true);
    expect(content.messages[0]?.text).toContain("characters cut");

    // No anchor: an archived thread is not in the snapshot, and still reads.
    const latest = yield* call("t3_thread_read", { threadId: archivedThreadId }).pipe(
      Effect.provide(layer),
    );
    expect(latest.isError).toBe(false);
    expect(latest.structuredContent).toMatchObject({ hasOlder: false, beforeCursor: null });
  }),
);

it.effect("creates a thread in the caller's project with the caller's modes", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* makeHarness;
    const result = yield* call("t3_thread_create", { title: "  Follow up  " }).pipe(
      Effect.provide(layer),
    );
    expect(result.isError).toBe(false);
    const commands = yield* Ref.get(dispatched);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.create",
      projectId: homeProjectId,
      title: "Follow up",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    expect(result.structuredContent).toMatchObject({
      projectId: homeProjectId,
      title: "Follow up",
    });
  }),
);

it.effect("archives another thread but never itself, and never deletes", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* makeHarness;
    const self = yield* call("t3_thread_archive", { threadId: callerThreadId }).pipe(
      Effect.provide(layer),
    );
    expect(self.isError).toBe(true);

    const gone = yield* call("t3_thread_archive", { threadId: archivedThreadId }).pipe(
      Effect.provide(layer),
    );
    expect(gone.isError).toBe(true);

    const ok = yield* call("t3_thread_archive", { threadId: siblingThreadId }).pipe(
      Effect.provide(layer),
    );
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent).toEqual({ threadId: siblingThreadId, archived: true });

    const commands = yield* Ref.get(dispatched);
    expect(commands).toEqual([
      expect.objectContaining({ type: "thread.archive", threadId: siblingThreadId }),
    ]);
    expect(commands.some((command) => command.type === "thread.delete")).toBe(false);
  }),
);

it.effect("refuses every tool when the session lacks the threads capability", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* makeHarness;
    const result = yield* call("t3_project_list", {}, new Set(["preview"])).pipe(
      Effect.provide(layer),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "this agent session was not granted access to Roost threads" },
    ]);
    expect(yield* Ref.get(dispatched)).toEqual([]);
  }),
);
