/**
 * What a thread's notification says, and which actions it carries.
 *
 * The thread's own name leads, the project and what happened sit under it,
 * and the body is the part worth reading on a lock screen: the agent's last
 * words, the error, the question it asked, or what it wants approved.
 */
import {
  PUSH_THREAD_APPROVAL_CATEGORY,
  PUSH_THREAD_REPLY_CATEGORY,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProviderRequestKind,
} from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";

/** iOS shows about four lines; more is cut off anyway and costs payload. */
const BODY_LIMIT = 280;

export type PendingRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "approval_request" | "user_input_request" }
>;

export interface ThreadNotification {
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
  readonly category?: string;
  /** The pending request the notification's buttons answer. */
  readonly requestId?: string;
}

const STATUS: Record<AgentAwarenessState["phase"], string> = {
  starting: "Starting",
  running: "Working",
  waiting_for_approval: "Needs approval",
  waiting_for_input: "Waiting for you",
  completed: "Finished",
  failed: "Failed",
  stale: "Update delayed",
};

const REQUEST_KIND: Record<ProviderRequestKind, string> = {
  command: "Wants to run a command.",
  "file-read": "Wants to read files.",
  "file-change": "Wants to change files.",
  "mcp-elicitation": "Wants to use a tool.",
  permission: "Wants a permission.",
};

/** Markdown read aloud by a lock screen: the words, without the markup. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clip(text: string, limit = BODY_LIMIT): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function questionBody(item: Extract<PendingRequestItem, { type: "user_input_request" }>): string {
  const [first, ...rest] = item.questions;
  if (first === undefined) return "Has a question for you.";
  const options = first.options.map((option) => option.label).join(" / ");
  const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
  return `${first.question}${options ? ` ${options}` : ""}${more}`;
}

/**
 * A single question that takes free text can be answered by typing on the
 * lock screen; several questions, or a pick from fixed options, need the app.
 */
function answerableFromNotification(
  item: Extract<PendingRequestItem, { type: "user_input_request" }>,
): boolean {
  const [only, ...rest] = item.questions;
  return only !== undefined && rest.length === 0 && only.allowCustomAnswer !== false;
}

export function buildThreadNotification(input: {
  readonly state: AgentAwarenessState;
  readonly thread: Pick<OrchestrationV2ThreadShell, "latestVisibleMessage" | "lastError">;
  readonly pending: PendingRequestItem | null;
}): ThreadNotification {
  const { state, thread, pending } = input;
  const title = state.threadTitle.trim() || state.projectTitle;
  const subtitle = `${state.projectTitle} · ${STATUS[state.phase]}`;

  if (state.phase === "waiting_for_input") {
    if (pending?.type !== "user_input_request") {
      return { title, subtitle, body: "Has a question for you." };
    }
    return {
      title,
      subtitle,
      body: clip(plainText(questionBody(pending))),
      requestId: pending.requestId,
      ...(answerableFromNotification(pending) ? { category: PUSH_THREAD_REPLY_CATEGORY } : {}),
    };
  }

  if (state.phase === "waiting_for_approval") {
    if (pending?.type !== "approval_request") {
      return { title, subtitle, body: "Wants your approval." };
    }
    const prompt = pending.prompt ? plainText(pending.prompt) : "";
    return {
      title,
      subtitle,
      body: clip(prompt || REQUEST_KIND[pending.requestKind]),
      category: PUSH_THREAD_APPROVAL_CATEGORY,
      requestId: pending.requestId,
    };
  }

  if (state.phase === "failed") {
    const error = thread.lastError ? plainText(thread.lastError) : "";
    return {
      title,
      subtitle,
      body: clip(error || "The run failed."),
      category: PUSH_THREAD_REPLY_CATEGORY,
    };
  }

  const said =
    thread.latestVisibleMessage?.role === "assistant"
      ? plainText(thread.latestVisibleMessage.text)
      : "";
  return {
    title,
    subtitle,
    body: clip(said || "Finished."),
    category: PUSH_THREAD_REPLY_CATEGORY,
  };
}
