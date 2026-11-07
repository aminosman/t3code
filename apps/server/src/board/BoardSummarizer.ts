// When a turn ends, a one-off Claude run (Haiku, no tools, no saved session)
// summarizes the thread and picks its column; a confident answer moves the
// card unless the user placed it during that turn. It never archives.
import { BOARD_STAGES, type BoardStage, type BoardSummary } from "@t3tools/contracts";
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
/** Summaries at once: each is a Claude process and a little quota. */
const WORKERS = 2;
/** Let a turn's last messages land before reading them. */
const SETTLE_DELAY = "4 seconds";
const CLAUDE_TIMEOUT = "90 seconds";
/** Below this the card stays put and the board shows the suggestion. */
const AUTO_MOVE_CONFIDENCE = 0.6;
const TRANSCRIPT_CHARS = 24_000;
const MESSAGE_CHARS = 1_500;

const SUMMARY_SYSTEM_PROMPT = `You keep a Trello-style card wall of coding-agent threads current.
Read the thread and answer in the JSON schema. Columns, in order:
- research: finding out. Investigating, reading code, exploring options, planning, answering questions. No code changed yet.
- fix: changing things. Editing code or config, building, running tests, iterating on a change.
- review: waiting on someone. The agent stopped for the user's answer, approval or decision, or a PR or review is open and pending.
- pushed: committed and pushed (or merged), not yet released or deployed.
- deployed: done. Released, deployed or published; or, for work with nothing to ship, finished with nothing left to do.
- archived: dead end. Abandoned, superseded, duplicated, or failed with no way forward.
Judge by what actually happened, not by what was planned. A thread that ended asking the user something is review.
summary: one or two plain sentences, at most 240 characters: what the work is and where it stands now.
next: who acts next and on what, at most 120 characters ("You: approve the migration", "Agent: rerun tests"); empty if nothing is pending.
reason: why that column, at most 80 characters.
confidence: 0 to 1, how sure you are of the column.`;

const SummaryOutput = Schema.Struct({
  summary: Schema.String,
  next: Schema.String,
  stage: Schema.Literals(BOARD_STAGES),
  reason: Schema.String,
  confidence: Schema.Number,
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

const SUMMARY_JSON_SCHEMA = encodeJson({
  type: "object",
  additionalProperties: false,
  required: ["summary", "next", "stage", "reason", "confidence"],
  properties: {
    summary: { type: "string" },
    next: { type: "string" },
    stage: { type: "string", enum: [...BOARD_STAGES] },
    reason: { type: "string" },
    confidence: { type: "number" },
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
    `Column now: ${input.stage ?? "not placed (research)"}`,
    `Last turn: ${input.turn}${input.waitingOnUser ? ", waiting on the user" : ""}`,
    input.previous === null ? "" : `Previous summary: ${input.previous}`,
    "",
    "Latest messages, oldest first:",
    ...lines,
  ].join("\n");
}

/**
 * Whether the summary moves the card: a confident, different column, never
 * into Archive (archiving is the user's), and never over a placement the
 * user made after the turn began.
 */
export function shouldAutoMove(input: {
  readonly suggested: BoardStage;
  readonly confidence: number;
  readonly current: BoardStage;
  readonly placedByUserAt: string | null;
  readonly turnStartedAt: string | null;
  readonly archived: boolean;
}): boolean {
  if (input.archived || input.suggested === "archived") return false;
  if (input.suggested === input.current || input.confidence < AUTO_MOVE_CONFIDENCE) return false;
  if (input.placedByUserAt !== null && input.turnStartedAt !== null) {
    return input.placedByUserAt < input.turnStartedAt;
  }
  return input.placedByUserAt === null;
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

  const runClaude = Effect.fn("BoardSummarizer.runClaude")(function* (prompt: string) {
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
          SUMMARY_JSON_SCHEMA,
          "--model",
          "haiku",
          "--system-prompt",
          SUMMARY_SYSTEM_PROMPT,
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
    const card = yield* board.card(threadId);
    const previous = (yield* board.summaries).find((entry) => entry.threadId === threadId);
    const waitingOnUser = shell.pendingRuntimeRequest !== null;
    const output = yield* runClaude(
      summaryPrompt({
        title: shell.title,
        stage: card?.stage ?? null,
        previous: previous?.summary ?? null,
        turn: shell.activityRunStatus ?? (shell.latestRunCompletedAt == null ? "none" : "ended"),
        waitingOnUser,
        messages: read.messages.filter((message) => !message.streaming),
      }),
    ).pipe(Effect.scoped, Effect.timeout(CLAUDE_TIMEOUT), Effect.mapError(summaryFailed));
    const summarizedAt = DateTime.formatIso(yield* DateTime.now);
    const summary: BoardSummary = {
      threadId: shell.id,
      summary: output.summary.slice(0, 400),
      next: output.next.slice(0, 200),
      suggestedStage: output.stage,
      reason: output.reason.slice(0, 160),
      confidence: Math.max(0, Math.min(1, output.confidence)),
      summarizedAt,
    };
    yield* board.saveSummary(summary);
    const turnStartedAt =
      shell.latestRunRequestedAt == null ? null : DateTime.formatIso(shell.latestRunRequestedAt);
    if (
      shouldAutoMove({
        suggested: summary.suggestedStage,
        confidence: summary.confidence,
        current: card?.stage ?? "research",
        placedByUserAt: card?.movedBy === "user" ? card.movedAt : null,
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

  if (process.env.ROOST_BOARD_SUMMARIES !== "0") {
    yield* threads.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "run.updated" && SETTLED_RUN.has(event.payload.status)
          ? enqueue([event.payload.threadId])
          : Effect.void,
      ),
      Effect.forkScoped,
    );
  }

  return BoardSummarizer.of({
    enqueue,
    pending: Ref.get(pendingIds).pipe(Effect.map((ids) => [...ids])),
  });
});

export const layer = Layer.effect(BoardSummarizer, make);
