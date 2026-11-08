import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_BOARD_COLUMNS,
  EnvironmentId,
  type BoardComment,
  type BoardSummary,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { checkRecorded } from "../BoardChecks.ts";
import { BoardFlow } from "../BoardFlow.ts";
import { BoardService } from "../BoardService.ts";
import * as BoardHandlers from "./handlers.ts";
import { BoardToolkit } from "./tools.ts";

const homeProjectId = ProjectId.make("project-home");
const workProjectId = ProjectId.make("project-work");
const callerThreadId = ThreadId.make("thread-caller");
const siblingThreadId = ThreadId.make("thread-sibling");
const workThreadId = ThreadId.make("thread-work");
const doneThreadId = ThreadId.make("thread-done");

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

const shell = (
  id: ThreadId,
  projectId: ProjectId,
  title: string,
  updatedAt: string,
  archivedAt: string | null = null,
): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId,
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { relationshipToParent: null },
    latestRunId:
      id === siblingThreadId
        ? RunId.make("run-1")
        : id === doneThreadId
          ? RunId.make("run-done")
          : null,
    activeRunId:
      id === callerThreadId
        ? RunId.make("run-caller")
        : id === siblingThreadId
          ? RunId.make("run-1")
          : null,
    activityRunStatus: id === siblingThreadId ? "running" : null,
    status: id === siblingThreadId ? "running" : id === doneThreadId ? "completed" : "idle",
    providerInstanceId: modelSelection.instanceId,
    deletedAt: null,
    pendingRuntimeRequest: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(updatedAt),
    updatedAt: DateTime.makeUnsafe(updatedAt),
    archivedAt: archivedAt === null ? null : DateTime.makeUnsafe(archivedAt),
  }) as unknown as OrchestrationV2ThreadShell;

const threads = [
  shell(callerThreadId, homeProjectId, "caller", "2026-09-19T10:01:00.000Z"),
  shell(workThreadId, workProjectId, "work thread", "2026-09-19T10:02:00.000Z"),
];

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

const invocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
  threadId: ThreadId = callerThreadId,
) =>
  ({
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    client: undefined,
    thread: {
      threadId,
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    capabilities,
    issuedAt: 1,
  }) satisfies McpInvocationContext.McpInvocationScope;

const makeHarness = Effect.gen(function* () {
  const moved = yield* Ref.make<ReadonlyArray<string>>([]);
  const placed = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const saved = yield* Ref.make<ReadonlyArray<BoardSummary>>([]);
  const approvals = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const notes = yield* Ref.make<ReadonlyArray<BoardComment>>([]);
  const assigned = yield* Ref.make<ReadonlyMap<string, "agent" | "user">>(new Map());
  const layer = McpHttpServer.toolkitRegistration(BoardToolkit, BoardHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(threads.find((thread) => thread.id === threadId) ?? null),
      }),
    ),
    Layer.provide(
      Layer.mock(BoardFlow)({
        // Recorded facts as the board reads them; git facts taken as holding.
        checkColumn: (threadId, column) =>
          Ref.get(saved).pipe(
            Effect.map((list) =>
              (column.checks ?? []).map(
                (check) =>
                  checkRecorded(
                    check,
                    list.find((entry) => entry.threadId === threadId),
                  ) ?? { kind: check.kind, ok: true, detail: "holds" },
              ),
            ),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(BoardService)({
        // Committed & pushed needs approval in every project.
        columns: Effect.succeed(
          DEFAULT_BOARD_COLUMNS.map((column) =>
            column.id === "pushed" ? { ...column, requireApprovalIn: ["*"] } : column,
          ),
        ),
        requestApproval: (input) =>
          Ref.modify(approvals, (map) => {
            const status = map.get(`${input.threadId}:${input.stage}`) ?? "pending";
            return [
              {
                threadId: input.threadId,
                stage: input.stage,
                status,
                requestedAt: "",
                decidedAt: null,
                note: input.note,
              } as never,
              new Map([...map, [`${input.threadId}:${input.stage}`, status]]),
            ];
          }),
        useApproval: (threadId, stage) =>
          Ref.update(approvals, (map) => {
            const next = new Map(map);
            next.delete(`${threadId}:${stage}`);
            return next;
          }),
        move: (input) =>
          Ref.update(moved, (seen) => [
            ...seen,
            `${input.threadIds.join(",")} ${input.stage} ${input.movedBy}`,
          ]).pipe(
            Effect.andThen(
              Ref.update(
                placed,
                (map) =>
                  new Map([...map, ...input.threadIds.map((id) => [id, input.stage] as const)]),
              ),
            ),
            Effect.as([]),
          ),
        card: (threadId) =>
          Ref.get(placed).pipe(
            Effect.map((map) => {
              const stage = map.get(threadId);
              return stage === undefined
                ? null
                : ({
                    threadId,
                    stage,
                    movedAt: "2026-11-07T00:00:00.000Z",
                    movedBy: "agent",
                    assignee: "agent",
                  } as never);
            }),
          ),
        summaries: Ref.get(saved),
        comment: (threadId, author, body) =>
          Ref.modify(notes, (list) => {
            const entry = {
              id: list.length + 1,
              threadId,
              author,
              body,
              createdAt: "",
            } as BoardComment;
            return [entry, [...list, entry]];
          }),
        comments: (threadId) =>
          Ref.get(notes).pipe(
            Effect.map((list) => list.filter((entry) => entry.threadId === threadId)),
          ),
        assign: (threadId, assignee) =>
          Ref.update(assigned, (map) => new Map([...map, [threadId, assignee]])),
        saveSummary: (summary) =>
          Ref.update(saved, (list) => [
            ...list.filter((entry) => entry.threadId !== summary.threadId),
            summary,
          ]),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { moved, saved, approvals, layer };
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

it.effect(
  "updates the caller's own card by default, another thread's by id, and no unknown one",
  () =>
    Effect.gen(function* () {
      const { moved, saved, approvals, layer } = yield* makeHarness;
      yield* Effect.gen(function* () {
        const own = yield* call("t3_card_update", {
          stage: "fix",
          summary: "Fixing the login loop.",
          next: "Agent: rerun the tests",
          reviewedBy: ["GPT-6 Sol"],
        });
        expect(own.structuredContent).toMatchObject({
          threadId: callerThreadId,
          stage: "fix",
          summary: "Fixing the login loop.",
          next: "Agent: rerun the tests",
          reviewedBy: ["GPT-6 Sol"],
          reviewsWanted: 2,
        });
        // A later report keeps what it leaves out.
        const later = yield* call("t3_card_update", { reviewedBy: ["GPT-6 Sol", "Amin"] });
        expect(later.structuredContent).toMatchObject({
          stage: "fix",
          summary: "Fixing the login loop.",
          reviewedBy: ["GPT-6 Sol", "Amin"],
        });
        // No arguments: reads the card and the board's columns, changes nothing.
        const read = yield* call("t3_card_update", {});
        expect((read.structuredContent as { columns: unknown[] }).columns).toHaveLength(
          DEFAULT_BOARD_COLUMNS.length,
        );
        // Handing the card to the user with what they need to do.
        const handed = yield* call("t3_card_update", {
          assignee: "user",
          comment: "Sign in to Gusto and set the 401(k) to 16.5% pre-tax.",
        });
        expect(handed.structuredContent).toMatchObject({
          assignee: "user",
          comments: [
            { author: "agent", body: "Sign in to Gusto and set the 401(k) to 16.5% pre-tax." },
          ],
        });
        // A column's checks come first: no reviews recorded, so the card stays.
        const unchecked = yield* call("t3_card_update", {
          stage: "Committed to branch",
          threadId: workThreadId,
        });
        expect(unchecked.structuredContent).toMatchObject({
          stage: "research",
          approval: null,
          checks: [
            { kind: "reviews", ok: false },
            { kind: "feature-branch", ok: true },
            { kind: "pushed", ok: true },
          ],
        });
        expect((unchecked.structuredContent as { instruction: string }).instruction).toContain(
          "Not moved",
        );
        // Reviews recorded in the same call: the checks pass, and the column needs approval.
        const asked = yield* call("t3_card_update", {
          stage: "Committed to branch",
          threadId: workThreadId,
          reviewedBy: ["GPT-6.1-Sol", "Claude Opus 5.5"],
          next: "You: approve pushing to main",
        });
        expect(asked.structuredContent).toMatchObject({
          approval: { stage: "pushed", status: "pending" },
        });
        yield* Ref.update(
          approvals,
          (map) => new Map([...map, [`${workThreadId}:pushed`, "approved"]]),
        );
        const granted = yield* call("t3_card_update", { stage: "pushed", threadId: workThreadId });
        expect(granted.structuredContent).toMatchObject({
          stage: "pushed",
          approval: { status: "used" },
        });
        const unknown = yield* call("t3_card_update", { stage: "qa" });
        expect(unknown.isError).toBe(true);
        const missing = yield* call("t3_card_update", { stage: "review", threadId: "thread-nope" });
        expect(missing.isError).toBe(true);
      }).pipe(Effect.provide(layer));
      expect(yield* Ref.get(moved)).toEqual([
        `${callerThreadId} fix agent`,
        `${workThreadId} pushed agent`,
      ]);
      expect((yield* Ref.get(saved)).map((entry) => [entry.threadId, entry.source])).toEqual([
        [callerThreadId, "agent"],
        [workThreadId, "agent"],
      ]);
      expect([...(yield* Ref.get(approvals)).keys()]).toEqual([]);
    }),
);
