/**
 * Which threads "Update thread model" moves to a newly picked model, and
 * which it leaves alone and why.
 *
 * Amin, Sep 24 2026: "a quick way to flip the default or the model for every
 * thread that's active … interacted with in the last few days". A thread
 * that has started can only move where the composer's own picker would let
 * it: the same agent, the same continuation history, and not onto a provider
 * that refuses model changes mid-conversation.
 *
 * @module UpdateThreadModel.logic
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { ThreadShell } from "../../types";
import { threadShellHasStarted } from "../ChatView.logic";

export const UPDATE_THREAD_MODEL_RECENT_DAYS = 3;

type PlannedThread = Pick<
  ThreadShell,
  | "id"
  | "modelSelection"
  | "session"
  | "latestTurn"
  | "latestUserMessageAt"
  | "createdAt"
  | "archivedAt"
>;

export type UpdateThreadModelSkipReason =
  /** A started thread on another agent; its history cannot move across. */
  | "otherAgent"
  /** Same agent, but a different continuation history (another home). */
  | "otherHistory"
  /** The provider only takes a model at the start of a conversation. */
  | "fixedModel"
  /** Its provider is not configured here, so nothing can be checked. */
  | "unknownProvider";

export interface UpdateThreadModelPlan<T extends PlannedThread> {
  readonly update: ReadonlyArray<T>;
  readonly unchanged: ReadonlyArray<T>;
  readonly skipped: ReadonlyArray<{
    readonly thread: T;
    readonly reason: UpdateThreadModelSkipReason;
  }>;
}

/** The last time the user touched a thread: their last message, else its creation. */
function lastInteractionMs(thread: PlannedThread): number {
  return Date.parse(thread.latestUserMessageAt ?? thread.createdAt);
}

export function planUpdateThreadModel<T extends PlannedThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly providers: ReadonlyArray<
    Pick<
      ServerProvider,
      "instanceId" | "driver" | "continuation" | "requiresNewThreadForModelChange"
    >
  >;
  readonly target: ModelSelection;
  readonly nowMs: number;
  readonly recentDays?: number;
  /** Instances that stand for the same accounts as the target (its account group). */
  readonly sameAccountsAsTarget?: ReadonlySet<string>;
}): UpdateThreadModelPlan<T> {
  const cutoffMs = input.nowMs - (input.recentDays ?? UPDATE_THREAD_MODEL_RECENT_DAYS) * 86_400_000;
  const targetProvider = input.providers.find(
    (provider) => provider.instanceId === input.target.instanceId,
  );
  const update: T[] = [];
  const unchanged: T[] = [];
  const skipped: Array<{ thread: T; reason: UpdateThreadModelSkipReason }> = [];

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (!(lastInteractionMs(thread) >= cutoffMs)) continue;

    const currentInstanceId =
      thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
    const sameInstance =
      currentInstanceId === input.target.instanceId ||
      (input.sameAccountsAsTarget?.has(currentInstanceId) ?? false);
    if (sameInstance && thread.modelSelection.model === input.target.model) {
      unchanged.push(thread);
      continue;
    }
    if (!threadShellHasStarted(thread)) {
      update.push(thread);
      continue;
    }

    const currentProvider = input.providers.find(
      (provider) => provider.instanceId === currentInstanceId,
    );
    if (!currentProvider || !targetProvider) {
      skipped.push({ thread, reason: "unknownProvider" });
      continue;
    }
    if (currentProvider.driver !== targetProvider.driver) {
      skipped.push({ thread, reason: "otherAgent" });
      continue;
    }
    const currentGroup = currentProvider.continuation?.groupKey;
    const targetGroup = targetProvider.continuation?.groupKey;
    if (currentGroup && targetGroup && currentGroup !== targetGroup) {
      skipped.push({ thread, reason: "otherHistory" });
      continue;
    }
    if (
      currentProvider.requiresNewThreadForModelChange === true ||
      targetProvider.requiresNewThreadForModelChange === true
    ) {
      skipped.push({ thread, reason: "fixedModel" });
      continue;
    }
    update.push(thread);
  }

  return { update, unchanged, skipped };
}

const SKIP_REASON_TEXT: Record<UpdateThreadModelSkipReason, string> = {
  otherAgent: "on another agent",
  otherHistory: "on another account's history",
  fixedModel: "on a provider that can't switch mid-conversation",
  unknownProvider: "on a provider that isn't set up here",
};

export function describeUpdateThreadModelResult(input: {
  readonly modelLabel: string;
  readonly updated: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly skipped: ReadonlyArray<{ readonly reason: UpdateThreadModelSkipReason }>;
  readonly projectDefaults: number;
}): { readonly title: string; readonly description: string } {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const lines = [
    `New threads start on ${input.modelLabel}` +
      (input.projectDefaults > 0
        ? `, as do ${plural(input.projectDefaults, "project default")}.`
        : "."),
  ];
  if (input.unchanged > 0) lines.push(`${plural(input.unchanged, "thread")} already on it.`);
  const byReason = new Map<UpdateThreadModelSkipReason, number>();
  for (const { reason } of input.skipped) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  for (const [reason, count] of byReason) {
    lines.push(`${plural(count, "thread")} left as is, ${SKIP_REASON_TEXT[reason]}.`);
  }
  if (input.failed > 0) lines.push(`${plural(input.failed, "thread")} failed to update.`);
  return {
    title: `${plural(input.updated, "thread")} moved to ${input.modelLabel}`,
    description: lines.join(" "),
  };
}
