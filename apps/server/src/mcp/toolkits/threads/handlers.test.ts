import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { HistorySearch, type HistorySearchInput } from "../../../historySearch/HistorySearch.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const homeProjectId = ProjectId.make("project-home");
const workProjectId = ProjectId.make("project-work");
const callerThreadId = ThreadId.make("thread-caller");
const siblingThreadId = ThreadId.make("thread-sibling");
const workThreadId = ThreadId.make("thread-work");
const archivedThreadId = ThreadId.make("thread-archived");
const doneThreadId = ThreadId.make("thread-done");

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
      : id === doneThreadId
        ? {
            turnId: TurnId.make("turn-done"),
            state: "completed",
            requestedAt: updatedAt,
            startedAt: updatedAt,
            completedAt: updatedAt,
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
  shell(doneThreadId, workProjectId, "review", "2026-09-19T10:03:00.000Z"),
];

const provider = (
  instanceId: string,
  driver: string,
  overrides: Record<string, unknown> = {},
): ServerProvider =>
  ({
    instanceId,
    driver,
    displayName: driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", email: `${driver}@example.com` },
    checkedAt: "2026-09-19T10:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: `${driver}-large`,
        name: `${driver} Large`,
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
      { slug: `${driver}-old`, name: "Old", isCustom: false, isLegacy: true, capabilities: null },
    ],
    ...overrides,
  }) as unknown as ServerProvider;

const providers = [
  provider("codex", "codex", {
    usageLimits: {
      checkedAt: "2026-09-19T10:00:00.000Z",
      windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 41.6 }],
    },
  }),
  provider("claudeAgent", "claudeAgent"),
  provider("grok", "grok", { auth: { status: "unauthenticated" } }),
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

const teamSync = {
  id: "2026.09.21-1330",
  title: "Team Sync",
  startedAt: "2026-09-21T17:30:30Z",
  durationMinutes: 52,
  projectId: null,
  projectTitle: null,
  people: ["Whisperflow"],
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

/** What a failed call said. */
const text = (result: { readonly content: ReadonlyArray<unknown> }) =>
  result.content.map((part) => String((part as { text?: unknown }).text ?? "")).join("\n");

const invocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
  threadId: ThreadId = callerThreadId,
) =>
  ({
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities,
    issuedAt: 1,
  }) satisfies McpInvocationContext.McpInvocationScope;

const makeHarness = Effect.gen(function* () {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const searched = yield* Ref.make<ReadonlyArray<HistorySearchInput>>([]);
  const usage = yield* Ref.make<ReadonlyArray<string>>([]);
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
          Effect.succeed(
            Option.fromUndefinedOr(
              activeThreads.find((t) => t.id === threadId) ??
                // A thread an agent just created: a uuid the fixtures never named.
                (/^[0-9a-f]{8}-/u.test(threadId)
                  ? shell(threadId, homeProjectId, "spawned", "2026-09-19T10:06:00.000Z")
                  : undefined),
            ),
          ),
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
    Layer.provide(Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) })),
    Layer.provide(
      Layer.mock(HistorySearch)({
        search: (input) =>
          Ref.update(searched, (inputs) => [...inputs, input]).pipe(
            Effect.as({
              searchId: 7,
              terms: ['"login"'],
              meaning: { active: true, embedded: 10, pending: 0, reason: null },
              results: [
                {
                  kind: "thread" as const,
                  id: archivedThreadId,
                  title: "old",
                  projectId: homeProjectId,
                  projectTitle: "home",
                  date: "2026-09-19T09:00:00.000Z",
                  archivedAt: "2026-09-19T09:30:00.000Z",
                  score: 100,
                  matchedBy: "both" as const,
                  matchedTerms: 1,
                  hitCount: 1,
                  hits: [
                    {
                      matchedBy: "words" as const,
                      messageId: "old-2",
                      at: null,
                      role: "user",
                      createdAt: "2026-09-19T09:01:00.000Z",
                      snippet: "the «login» loops",
                    },
                  ],
                },
                {
                  kind: "meeting" as const,
                  id: "2026.09.21-1330",
                  title: "Team Sync",
                  projectId: null,
                  projectTitle: null,
                  date: "2026-09-21T17:30:30Z",
                  archivedAt: null,
                  score: 48,
                  matchedBy: "meaning" as const,
                  matchedTerms: 0,
                  hitCount: 1,
                  hits: [
                    {
                      matchedBy: "meaning" as const,
                      messageId: null,
                      at: "12:37",
                      role: "transcript",
                      createdAt: "2026-09-21T17:30:30Z",
                      snippet: "them: the «login» keeps looping",
                    },
                  ],
                },
              ],
            }),
          ),
        recordOpen: (input) =>
          Ref.update(usage, (seen) => [...seen, `open ${input.kind} ${input.id}`]),
        recordFeedback: (input) =>
          Ref.update(usage, (seen) => [
            ...seen,
            `feedback ${input.found} ${input.searchId ?? "latest"} ${input.note ?? ""}`,
          ]).pipe(Effect.as(input.searchId ?? 7)),
        listMeetings: () => Effect.succeed([teamSync]),
        readMeeting: (input) =>
          Effect.succeed(
            input.meetingId === teamSync.id
              ? {
                  meeting: teamSync,
                  notes: input.around === undefined ? "## Decisions\n- fix the login loop" : null,
                  lines:
                    input.around === undefined
                      ? []
                      : [
                          {
                            at: "12:37",
                            seconds: 757,
                            speaker: "them",
                            text: "the login keeps looping",
                          },
                        ],
                  hasEarlier: input.around !== undefined,
                  hasLater: true,
                  notesPath: "/m/summary.md",
                  transcriptPath: "/m/transcript.md",
                }
              : null,
          ),
        readMessages: (input) =>
          Effect.succeed(
            input.threadId === doneThreadId
              ? {
                  thread: {
                    id: doneThreadId,
                    projectId: workProjectId,
                    title: "review",
                    branch: null,
                    updatedAt: "2026-09-19T10:03:00.000Z",
                    archivedAt: null,
                  },
                  messages: [
                    {
                      id: "d1",
                      role: "user",
                      text: "review the index",
                      createdAt: "2026-09-19T10:02:00.000Z",
                      streaming: false,
                    },
                    {
                      id: "d2",
                      role: "assistant",
                      text: "Two bugs: the throttle and the vocab scan.",
                      createdAt: "2026-09-19T10:03:00.000Z",
                      streaming: false,
                    },
                  ],
                  hasOlder: false,
                  hasNewer: false,
                }
              : input.threadId === archivedThreadId
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
  return { dispatched, searched, usage, layer };
});

const call = (
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["threads"]),
  as: ThreadId = callerThreadId,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(capabilities, as),
        ),
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
          threadCount: 2,
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
    ).toEqual([doneThreadId, workThreadId]);

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

it.effect("searches threads and meetings, leaving the calling thread out unless asked", () =>
  Effect.gen(function* () {
    const { searched, layer } = yield* makeHarness;
    const result = yield* call("t3_history_search", { query: "why does the login loop" }).pipe(
      Effect.provide(layer),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      terms: ['"login"'],
      meaning: { active: true, pending: 0 },
      results: [
        {
          kind: "thread",
          matchedBy: "both",
          id: archivedThreadId,
          projectTitle: "home",
          hits: [{ messageId: "old-2", snippet: "the «login» loops" }],
        },
        { kind: "meeting", id: "2026.09.21-1330", hits: [{ at: "12:37", role: "transcript" }] },
      ],
    });
    yield* call("t3_history_search", { query: "login", includeCurrent: true, role: "user" }).pipe(
      Effect.provide(layer),
    );
    const inputs = yield* Ref.get(searched);
    expect(inputs[0]).toMatchObject({
      excludeThreadId: callerThreadId,
      projectId: undefined,
      // Who asked goes into the usage record.
      caller: { threadId: callerThreadId, provider: "codex" },
    });
    expect(inputs[1]).toMatchObject({ excludeThreadId: undefined, role: "user" });
  }),
);

it.effect("records what was opened after a search, and what the agent said of it", () =>
  Effect.gen(function* () {
    const { usage, layer } = yield* makeHarness;
    yield* Effect.gen(function* () {
      const found = yield* call("t3_history_search", { query: "login" });
      expect(found.structuredContent).toMatchObject({ searchId: 7 });
      yield* call("t3_thread_read", { threadId: archivedThreadId, aroundMessageId: "old-2" });
      yield* call("t3_meeting_read", { meetingId: teamSync.id, around: "12:37" });
      const rated = yield* call("t3_history_feedback", {
        found: false,
        note: "expected the thread where the SSO loop was fixed",
      });
      expect(rated.structuredContent).toEqual({ recorded: true, searchId: 7 });
      yield* call("t3_history_feedback", { found: true, searchId: 3 });
    }).pipe(Effect.provide(layer));
    expect(yield* Ref.get(usage)).toEqual([
      `open thread ${archivedThreadId}`,
      `open meeting ${teamSync.id}`,
      "feedback false latest expected the thread where the SSO loop was fixed",
      "feedback true 3 ",
    ]);
  }),
);

it.effect("lists meetings and reads one by its notes or around a moment", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeHarness;
    const listed = yield* call("t3_meeting_list", {}).pipe(Effect.provide(layer));
    expect(listed.structuredContent).toMatchObject({ meetings: [{ id: teamSync.id }] });

    const notes = yield* call("t3_meeting_read", { meetingId: teamSync.id }).pipe(
      Effect.provide(layer),
    );
    expect(notes.structuredContent).toMatchObject({
      meeting: { title: "Team Sync", durationMinutes: 52 },
      notes: "## Decisions\n- fix the login loop",
      lines: [],
    });

    const around = yield* call("t3_meeting_read", { meetingId: teamSync.id, around: "12:37" }).pipe(
      Effect.provide(layer),
    );
    expect(around.structuredContent).toMatchObject({
      notes: null,
      lines: [{ at: "12:37", speaker: "them", text: "the login keeps looping" }],
      hasEarlier: true,
    });

    const missing = yield* call("t3_meeting_read", { meetingId: "nowhere" }).pipe(
      Effect.provide(layer),
    );
    expect(missing.isError).toBe(true);
    const ungranted = yield* call("t3_meeting_list", {}, new Set()).pipe(Effect.provide(layer));
    expect(ungranted.isError).toBe(true);
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
      started: false,
      model: { instanceId: "codex", model: "gpt-5-codex" },
    });
  }),
);

it.effect("lists the models that can be used now, marking the caller's provider", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeHarness;
    const usable = yield* call("t3_model_list", {}).pipe(Effect.provide(layer));
    const listed = usable.structuredContent as {
      providers: Array<{
        instanceId: string;
        current: boolean;
        account: string | null;
        usage: Array<{ label: string; usedPercent: number }>;
        models: Array<{
          model: string;
          options: Array<{ id: string; choices: string[]; default: unknown }>;
        }>;
      }>;
    };
    expect(listed.providers.map((p) => p.instanceId)).toEqual(["codex", "claudeAgent"]);
    expect(listed.providers[0]).toMatchObject({
      current: true,
      account: "codex@example.com",
      usage: [{ label: "Weekly", usedPercent: 42 }],
    });
    // Legacy models are not offered; options carry their choices and default.
    expect(listed.providers[1]?.models).toEqual([
      expect.objectContaining({
        model: "claudeAgent-large",
        options: [
          expect.objectContaining({ id: "effort", choices: ["medium", "high"], default: "medium" }),
        ],
      }),
    ]);

    const all = yield* call("t3_model_list", { includeUnusable: true }).pipe(Effect.provide(layer));
    expect(all.structuredContent).toMatchObject({
      providers: [{}, {}, { instanceId: "grok", usable: false, unusableBecause: "not signed in" }],
    });
  }),
);

it.effect("starts a fresh thread on a chosen model, and says who sent the first message", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* makeHarness;
    const result = yield* call("t3_thread_create", {
      title: "Review: history search",
      prompt: "Review apps/server/src/historySearch for bugs. Read-only.",
      model: { instanceId: "claudeAgent", model: "claudeAgent-large", options: { effort: "high" } },
    }).pipe(Effect.provide(layer));
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      started: true,
      model: { instanceId: "claudeAgent", model: "claudeAgent-large" },
    });
    const commands = yield* Ref.get(dispatched);
    expect(commands.map((command) => command.type)).toEqual(["thread.create", "thread.turn.start"]);
    const chosen = {
      instanceId: "claudeAgent",
      model: "claudeAgent-large",
      options: [{ id: "effort", value: "high" }],
    };
    expect(commands[0]).toMatchObject({ modelSelection: chosen, runtimeMode: "full-access" });
    expect(commands[1]).toMatchObject({
      modelSelection: chosen,
      message: { role: "user", attachments: [] },
    });
    const start = commands[1] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    expect(start.threadId).toBe((commands[0] as { threadId: ThreadId }).threadId);
    expect(start.message.text).toContain('Started by the agent in thread "caller"');
    expect(start.message.text).toContain("Review apps/server/src/historySearch for bugs.");
  }),
);

it.effect("refuses a model that is not set up, and names what is", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* makeHarness;
    const attempt = (model: Record<string, unknown>) =>
      call("t3_thread_create", { title: "x", prompt: "y", model }).pipe(Effect.provide(layer));

    const noProvider = yield* attempt({ instanceId: "gemini", model: "pro" });
    expect(noProvider.isError).toBe(true);
    expect(text(noProvider)).toContain("codex, claudeAgent, grok");
    const signedOut = yield* attempt({ instanceId: "grok", model: "grok-large" });
    expect(text(signedOut)).toContain("not signed in");
    const noModel = yield* attempt({ instanceId: "codex", model: "gpt-9" });
    expect(text(noModel)).toContain("codex-large");
    const badOption = yield* attempt({
      instanceId: "codex",
      model: "codex-large",
      options: { effort: "ludicrous" },
    });
    expect(text(badOption)).toContain("medium, high");
    expect(yield* Ref.get(dispatched)).toHaveLength(0);
  }),
);

it.effect("lets one thread start a handful an hour, and a started thread start none", () =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* makeHarness;
    yield* Effect.gen(function* () {
      const start = (as?: ThreadId) =>
        call("t3_thread_create", { title: "Review", prompt: "look" }, new Set(["threads"]), as);
      const first = yield* start();
      const spawned = (first.structuredContent as { threadId: ThreadId }).threadId;
      // The review cannot ask for a review of itself.
      const chained = yield* start(spawned);
      expect(chained.isError).toBe(true);
      expect(text(chained)).toContain("started by an agent");

      for (let index = 0; index < 4; index++) expect((yield* start()).isError).toBe(false);
      const sixth = yield* start();
      expect(sixth.isError).toBe(true);
      expect(text(sixth)).toContain("ask the user");
      // An empty thread spends nothing and is not counted.
      expect((yield* call("t3_thread_create", { title: "Later" })).isError).toBe(false);
      yield* TestClock.adjust("61 minutes");
      expect((yield* start()).isError).toBe(false);
    }).pipe(Effect.provide(layer));
    const commands = yield* Ref.get(dispatched);
    expect(commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(6);
  }),
);

it.effect("waits for a started thread and returns its answer", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeHarness;
    const done = yield* call("t3_thread_wait", { threadId: doneThreadId }).pipe(
      Effect.provide(layer),
    );
    expect(done.structuredContent).toMatchObject({
      state: "done",
      reply: "Two bugs: the throttle and the vocab scan.",
      thread: { id: doneThreadId },
    });

    // Still running when the wait runs out: said so, not hung on.
    const fiber = yield* call("t3_thread_wait", {
      threadId: siblingThreadId,
      timeoutSeconds: 10,
    }).pipe(Effect.provide(layer), Effect.forkChild);
    yield* TestClock.adjust("12 seconds");
    const running = yield* Fiber.join(fiber);
    expect(running.structuredContent).toMatchObject({ state: "running", reply: null });

    const empty = yield* call("t3_thread_wait", { threadId: workThreadId }).pipe(
      Effect.provide(layer),
    );
    expect(empty.isError).toBe(true);
    const self = yield* call("t3_thread_wait", { threadId: callerThreadId }).pipe(
      Effect.provide(layer),
    );
    expect(self.isError).toBe(true);
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
