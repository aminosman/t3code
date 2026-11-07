// When a turn ends, a one-off Claude run (Haiku, no tools, no saved session)
// summarizes the thread and picks its column; a confident answer moves the
// card unless the user placed it during that turn. It never archives.
import {
  type BoardColumn,
  type BoardStage,
  type BoardSummary,
  columnNeedsApproval,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HistorySearch } from "../historySearch/HistorySearch.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import {
  hasClaudeManagedMcpConfig,
  makeClaudeEnvironment,
} from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BoardService } from "./BoardService.ts";

class SummaryError extends Schema.TaggedError<SummaryError>()("BoardSummaryError", {
  reason: Schema.String,
}) {}

const isSummaryError = Schema.is(SummaryError);
const summaryFailed = (cause: unknown) =>
  isSummaryError(cause)
    ? cause
    : new SummaryError({ reason: cause instanceof Error ? cause.message : String(cause) });

export interface BoardSummarizerShape {
  /** Queues threads for a summary; returns how many were newly queued. */
  readonly enqueue: (threadIds: ReadonlyArray<string>) => Effect.Effect<number>;
  /** Threads queued or being summarized. */
  readonly pending: Effect.Effect<ReadonlyArray<string>>;
}

export class BoardSummarizer extends Context.Service<BoardSummarizer, BoardSummarizerShape>()(
  "t3/board/BoardSummarizer",
) {}

/** Runs ended this way are worth a fresh summary. */
const SETTLED_RUN = new Set(["completed", "failed", "interrupted", "cancelled", "waiting"]);
/** A run beginning; later updates of a running run do not count. */
const STARTED_RUN = new Set(["preparing", "queued", "starting"]);
/** Summaries at once: each is a Claude process and a little quota. */
const WORKERS = 2;
/** Let a turn's last messages land before reading them. */
const SETTLE_DELAY = "4 seconds";
const CLAUDE_TIMEOUT = "90 seconds";
/** Below this the card stays put and the board shows the suggestion. */
const AUTO_MOVE_CONFIDENCE = 0.6;
const TRANSCRIPT_CHARS = 24_000;
const MESSAGE_CHARS = 1_500;

/** The instructions, with the user's own columns and what each is for. */
export function summarySystemPrompt(columns: ReadonlyArray<BoardColumn>): string {
  const lines = columns.map(
    (column) =>
      `- ${column.id} ("${column.title}")${column.description.trim() ? `: ${column.description.trim()}` : ""}`,
  );
  return `You keep a Trello-style card wall of coding-agent threads current.
Read the thread and answer in the JSON schema. The user's columns, in board order, with what belongs in each:
${lines.join("\n")}
Pick the column whose description fits what actually happened, not what was planned. stage is the column id.
${SUMMARY_FIELDS}`;
}

const SUMMARY_FIELDS = `summary: one or two plain sentences, at most 240 characters: what the work is and where it stands now.
next: who acts next and on what, at most 120 characters ("You: approve the migration", "Agent: rerun tests"); empty if nothing is pending.
reason: why that column, at most 80 characters.
confidence: 0 to 1, how sure you are of the column.
codeChanged: whether the thread changed code (edits, commits, a PR).
needsUser: whether the thread ended waiting on the user to answer, decide, approve or do something.
ask: when needsUser, exactly what the user has to do, as a short instruction to them; else "".
reviewedBy: who independently reviewed the current code changes, as named in the thread (a reviewer agent's model, a person who approved a PR); empty if nobody has.`;

const SummaryOutput = Schema.Struct({
  summary: Schema.String,
  next: Schema.String,
  stage: Schema.String,
  reason: Schema.String,
  confidence: Schema.Number,
  codeChanged: Schema.Boolean,
  needsUser: Schema.Boolean,
  ask: Schema.String,
  reviewedBy: Schema.Array(Schema.String),
});

const ClaudeResult = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ structured_output: Schema.optional(Schema.Unknown) }),
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        structured_output: Schema.optional(Schema.Unknown),
      }),
    ),
  ]),
);
const decodeClaudeResult = Schema.decodeEffect(ClaudeResult);
const decodeSummary = Schema.decodeUnknownEffect(SummaryOutput);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const summaryJsonSchema = (columns: ReadonlyArray<BoardColumn>) =>
  encodeJson({
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "next",
      "stage",
      "reason",
      "confidence",
      "codeChanged",
      "reviewedBy",
      "needsUser",
      "ask",
    ],
    properties: {
      summary: { type: "string" },
      next: { type: "string" },
      stage: { type: "string", enum: columns.map((column) => column.id) },
      reason: { type: "string" },
      confidence: { type: "number" },
      codeChanged: { type: "boolean" },
      needsUser: { type: "boolean" },
      ask: { type: "string" },
      reviewedBy: { type: "array", items: { type: "string" } },
    },
  });

export interface SummaryPromptInput {
  readonly title: string;
  readonly stage: BoardStage | null;
  readonly previous: string | null;
  readonly turn: string;
  readonly waitingOnUser: boolean;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max / 2)}\n…\n${text.slice(-max / 2)}`;

/** The thread as the summarizer reads it: newest messages kept when it is long. */
export function summaryPrompt(input: SummaryPromptInput): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of input.messages.toReversed()) {
    const line = `[${message.role}] ${clip(message.text.trim(), MESSAGE_CHARS)}`;
    if (used + line.length > TRANSCRIPT_CHARS) break;
    used += line.length;
    lines.unshift(line);
  }
  return [
    `Thread: ${input.title}`,
    `Column now: ${input.stage ?? "not placed yet"}`,
    `Last turn: ${input.turn}${input.waitingOnUser ? ", waiting on the user" : ""}`,
    input.previous === null ? "" : `Previous summary: ${input.previous}`,
    "",
    "Latest messages, oldest first:",
    ...lines,
  ].join("\n");
}

/**
 * Whether the summary moves the card: a confident, different column, never
 * into the last archiving column (putting work away is the user's), and
 * never over a placement the user made after the turn began.
 */
export function shouldAutoMove(input: {
  readonly suggested: BoardStage;
  readonly suggestedPutsAway: boolean;
  readonly confidence: number;
  readonly current: BoardStage;
  readonly placedByUserAt: string | null;
  readonly turnStartedAt: string | null;
  readonly archived: boolean;
}): boolean {
  if (input.archived || input.suggestedPutsAway) return false;
  if (input.suggested === input.current || input.confidence < AUTO_MOVE_CONFIDENCE) return false;
  if (input.placedByUserAt !== null && input.turnStartedAt !== null) {
    return input.placedByUserAt < input.turnStartedAt;
  }
  return input.placedByUserAt === null;
}

/** Whether the thread's own agent updated its card during the turn that just ended. */
export function agentReportedTurn(
  previous: Pick<BoardSummary, "source" | "summarizedAt"> | undefined,
  turnStartedAt: string | null,
): boolean {
  return (
    previous?.source === "agent" && turnStartedAt !== null && previous.summarizedAt >= turnStartedAt
  );
}

const make = Effect.gen(function* () {
  const board = yield* BoardService;
  const threads = yield* ThreadManagementService;
  const history = yield* HistorySearch;
  const settings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const queue = yield* Queue.unbounded<string>();
  const pendingIds = yield* Ref.make<ReadonlySet<string>>(new Set());

  const enqueue: BoardSummarizerShape["enqueue"] = Effect.fn("BoardSummarizer.enqueue")(
    function* (threadIds) {
      const fresh = yield* Ref.modify(pendingIds, (current) => {
        const added = threadIds.filter((id) => !current.has(id));
        return [added, new Set([...current, ...added])] as const;
      });
      yield* Queue.offerAll(queue, fresh);
      return fresh.length;
    },
  );

  /** The Claude account summaries run on: the first enabled real Claude instance. */
  const claudeInstance = settings.getSettings.pipe(
    Effect.map((current) =>
      Object.entries(current.providerInstances ?? {}).find(
        ([, instance]) =>
          instance.driver === "claudeAgent" &&
          instance.enabled !== false &&
          !(instance.environment ?? []).some(
            (variable) => variable.sensitive || variable.name === "ANTHROPIC_MODEL",
          ),
      ),
    ),
  );

  const runClaude = Effect.fn("BoardSummarizer.runClaude")(function* (
    prompt: string,
    columns: ReadonlyArray<BoardColumn>,
  ) {
    const found = yield* claudeInstance;
    if (found === undefined) {
      return yield* new SummaryError({ reason: "no Claude account to summarize with" });
    }
    const [, instance] = found;
    const config = (instance.config ?? {}) as { binaryPath?: string; homePath?: string };
    const baseEnv = yield* mergeProviderInstanceEnvironment(instance.environment);
    const env = yield* makeClaudeEnvironment({ homePath: config.homePath ?? "" }, baseEnv);
    const managedMcp = yield* hasClaudeManagedMcpConfig();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "roost-board-summary-" });
    const child = yield* spawner.spawn(
      ChildProcess.make(
        config.binaryPath?.trim() || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          summaryJsonSchema(columns),
          "--model",
          "haiku",
          "--system-prompt",
          summarySystemPrompt(columns),
          "--tools",
          "",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--settings",
          encodeJson({ disableAllHooks: true }),
          ...(managedMcp ? [] : ["--strict-mcp-config"]),
          "--permission-mode",
          "dontAsk",
        ],
        {
          env,
          cwd,
          stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
          forceKillAfter: "1 second",
        },
      ),
    );
    const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (acc, chunk) => acc + chunk,
        ),
        Effect.mapError(summaryFailed),
      );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [text(child.stdout), text(child.stderr), child.exitCode.pipe(Effect.mapError(summaryFailed))],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new SummaryError({
        reason: `claude exited ${exitCode}: ${(stderr || stdout).slice(0, 300)}`,
      });
    }
    const parsed = yield* decodeClaudeResult(stdout);
    const envelope = Array.isArray(parsed)
      ? parsed.findLast((entry) => entry.type === "result")
      : parsed;
    return yield* decodeSummary(envelope?.structured_output);
  }, Effect.mapError(summaryFailed));

  const summarize = Effect.fn("BoardSummarizer.summarize")(function* (threadId: string) {
    // Read failures and Claude failures alike only skip this summary.
    yield* Effect.sleep(SETTLE_DELAY);
    const shell = yield* threads.getThreadShell(threadId as never);
    if (shell === null || shell.deletedAt !== null) return;
    const read = yield* history.readMessages({ threadId, before: 40 });
    if (read === null || read.messages.length === 0) return;
    const columns = yield* board.columns;
    const card = yield* board.card(threadId);
    const firstOpen = columns.find((column) => !column.archives)!;
    const current = columns.find((column) => column.id === card?.stage) ?? firstOpen;
    const previous = (yield* board.summaries).find((entry) => entry.threadId === threadId);
    const turnStartedAt =
      shell.latestRunRequestedAt == null ? null : DateTime.formatIso(shell.latestRunRequestedAt);
    // The thread's agent keeps its own card; summarize only a turn it left unreported.
    if (agentReportedTurn(previous, turnStartedAt)) return;
    const waitingOnUser = shell.pendingRuntimeRequest !== null;
    const output = yield* runClaude(
      summaryPrompt({
        title: shell.title,
        stage: card === null ? null : current.id,
        previous: previous?.summary ?? null,
        turn: shell.activityRunStatus ?? (shell.latestRunCompletedAt == null ? "none" : "ended"),
        waitingOnUser,
        messages: read.messages.filter((message) => !message.streaming),
      }),
      columns,
    ).pipe(Effect.scoped, Effect.timeout(CLAUDE_TIMEOUT), Effect.mapError(summaryFailed));
    const suggested = columns.find((column) => column.id === output.stage);
    if (suggested === undefined) {
      return yield* new SummaryError({ reason: `no column "${output.stage}"` });
    }
    const summarizedAt = DateTime.formatIso(yield* DateTime.now);
    const summary: BoardSummary = {
      threadId: shell.id,
      summary: output.summary.slice(0, 400),
      next: output.next.slice(0, 200),
      suggestedStage: output.stage,
      reason: output.reason.slice(0, 160),
      confidence: Math.max(0, Math.min(1, output.confidence)),
      summarizedAt,
      source: "auto",
      reviewedBy: output.codeChanged ? output.reviewedBy.slice(0, 8) : null,
    };
    yield* board.saveSummary(summary);
    // A turn that ended on the user hands them the card, with what they have to do.
    if (output.needsUser && card?.assignee !== "user" && shell.archivedAt === null) {
      const ask = (output.ask.trim() || output.next.trim()).slice(0, 600);
      if (ask.length > 0) yield* board.comment(threadId, "agent", ask);
      yield* board.assign(threadId, "user");
    }
    if (
      shouldAutoMove({
        suggested: summary.suggestedStage,
        // The last archiving column, and any column that needs approval: suggested, never moved to.
        suggestedPutsAway:
          suggested.id === columns.findLast((column) => column.archives)?.id ||
          columnNeedsApproval(suggested, shell.projectId),
        confidence: summary.confidence,
        current: current.id,
        // A placement by the user or the thread's agent during the turn stands.
        placedByUserAt: card !== null && card.movedBy !== "auto" ? card.movedAt : null,
        turnStartedAt,
        archived: shell.archivedAt !== null,
      })
    ) {
      yield* board.move({ threadIds: [threadId], stage: summary.suggestedStage, movedBy: "auto" });
    }
  });

  const worker = Effect.forever(
    Effect.gen(function* () {
      const threadId = yield* Queue.take(queue);
      yield* summarize(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board summary failed").pipe(
            Effect.annotateLogs({ threadId, cause: String(cause).slice(0, 500) }),
          ),
        ),
        Effect.ensuring(
          Ref.update(pendingIds, (current) => {
            const next = new Set(current);
            next.delete(threadId);
            return next;
          }),
        ),
      );
    }),
  );
  for (let index = 0; index < WORKERS; index += 1) yield* Effect.forkScoped(worker);

  const summariesOn = process.env.ROOST_BOARD_SUMMARIES !== "0";
  // A turn starting means the user answered (in the chat or on the card): the agent has the card again.
  const takeBack = (threadId: string) =>
    board.card(threadId).pipe(
      Effect.flatMap((placed) =>
        placed?.assignee === "user" ? board.assign(threadId, "agent") : Effect.void,
      ),
      Effect.ignore,
    );
  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach((event) => {
      if (event.type !== "run.updated") return Effect.void;
      if (STARTED_RUN.has(event.payload.status)) return takeBack(event.payload.threadId);
      if (summariesOn && SETTLED_RUN.has(event.payload.status)) {
        return enqueue([event.payload.threadId]);
      }
      return Effect.void;
    }),
    Effect.forkScoped,
  );

  return BoardSummarizer.of({
    enqueue,
    pending: Ref.get(pendingIds).pipe(Effect.map((ids) => [...ids])),
  });
});

export const layer = Layer.effect(BoardSummarizer, make);
