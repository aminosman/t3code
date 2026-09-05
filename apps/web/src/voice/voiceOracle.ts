import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
} from "@t3tools/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import type { VoiceToolDefinition } from "./realtimeVoiceSession";

/** The thread facts the oracle's tools read. Refreshed every render. */
export interface VoiceOracleThreadView {
  readonly threadTitle: string;
  readonly projectName: string | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
}

export const VOICE_ORACLE_TOOLS: ReadonlyArray<VoiceToolDefinition> = [
  {
    name: "get_agent_status",
    description:
      "Check what the coding agent is doing right now: whether it is working, the state of its latest turn, and which provider is running.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_thread_transcript",
    description:
      "Read the most recent messages in the conversation between the user and the coding agent. Use this to ground answers about what was asked and what the agent did.",
    parameters: {
      type: "object",
      properties: {
        message_count: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "How many of the latest messages to fetch. Defaults to 10.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "send_message_to_agent",
    description:
      "Send a new instruction or follow-up message to the coding agent in this thread. The agent starts a new turn; a system event will report back when it finishes.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "The full message for the coding agent, written as a clear standalone instruction.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "end_voice_session",
    description:
      "Hang up and close the voice overlay. Call this as soon as the conversation reaches a natural stop — above all right after handing work to the coding agent, which can run for many minutes. Do not sit on an open microphone waiting for it. Say one short closing line as you call this; the session ends when you finish speaking, and the user can tap the voice button to pick the conversation back up.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short reason, e.g. 'work handed to the agent' or 'user said goodbye'.",
        },
      },
      additionalProperties: false,
    },
  },
];

export function providerDisplayName(providerName: string | null | undefined): string {
  if (!providerName) return "the coding agent";
  return (
    (PROVIDER_DISPLAY_NAMES as Record<string, string | undefined>)[providerName] ?? providerName
  );
}

export function buildOracleInstructions(view: VoiceOracleThreadView): string {
  const provider = providerDisplayName(view.session?.providerName);
  const project = view.projectName ? ` on the project "${view.projectName}"` : "";
  return [
    `You are the T3 Code oracle: a calm, sharp spoken copilot helping the user direct ${provider}${project}, in the thread "${view.threadTitle}".`,
    "You are voice-only. Keep replies short — one to three sentences — and conversational. No markdown, no lists, no code unless the user asks you to read some aloud.",
    "Ground yourself with get_thread_transcript and get_agent_status before answering questions about the work; never invent agent output.",
    "When the user wants the agent to do something, compose a clear standalone instruction and call send_message_to_agent. Confirm first only when the request is ambiguous or destructive.",
    "System messages will tell you when the agent starts and finishes a turn. When it finishes, briefly summarize the outcome and surface anything that needs the user's decision.",
    "Do not linger on an open microphone. Once you have handed work to the agent, or the user is done talking, say one short closing line and call end_voice_session. Agent turns can run for many minutes, and the user will tap the voice button again when they want you back — you will be caught up on what happened while you were away.",
  ].join("\n");
}

/**
 * Seed context spoken at the start of every session. Voice sessions are
 * deliberately short-lived — the oracle hangs up while the agent works — so
 * each one reopens cold and must re-establish where the work stands before
 * the user has to explain it.
 */
export function buildResumeContext(view: VoiceOracleThreadView): string {
  const activity = describeAgentActivity(view);
  const lastAgentMessage = view.messages
    .toReversed()
    .find((message) => message.role === "assistant" && message.text.trim().length > 0)?.text;
  const lastUserMessage = view.messages
    .toReversed()
    .find((message) => message.role === "user" && message.text.trim().length > 0)?.text;

  return [
    "The user just opened voice mode on this thread. You are picking the conversation back up — you may have been away while the agent worked.",
    `Agent status: ${activity.label}${activity.working ? " (still running right now)" : ""}.`,
    lastUserMessage
      ? `The user's most recent instruction was:\n${truncateForVoice(lastUserMessage, 600)}`
      : "The user has not sent an instruction yet.",
    lastAgentMessage
      ? `The agent's most recent message was:\n${truncateForVoice(lastAgentMessage, 1_500)}`
      : "The agent has not replied yet.",
    activity.working
      ? "Open with one short line on what the agent is working on, then ask what they want to do. If they only wanted a status check, hang up with end_voice_session."
      : "Open with one or two short sentences on where things stand, then ask what they want to do next.",
    "Use get_thread_transcript if you need more detail than the above before answering.",
  ].join("\n");
}

export function truncateForVoice(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
}

const clampCount = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(30, Math.max(1, parsed));
};

export function describeAgentActivity(view: VoiceOracleThreadView): {
  readonly working: boolean;
  readonly label: string;
} {
  const sessionStatus = view.session?.status ?? "idle";
  const turnState = view.latestTurn?.state ?? null;
  if (sessionStatus === "starting" || sessionStatus === "running" || turnState === "running") {
    return { working: true, label: "Agent working" };
  }
  if (sessionStatus === "error" || turnState === "error") {
    return { working: false, label: "Agent hit an error" };
  }
  if (turnState === "completed") {
    return { working: false, label: "Agent finished" };
  }
  if (turnState === "interrupted") {
    return { working: false, label: "Agent interrupted" };
  }
  return { working: false, label: "Agent idle" };
}

/**
 * Execute one oracle tool call against the latest thread view. Returns a
 * JSON-serializable result that is fed straight back to the realtime model.
 */
export async function executeVoiceOracleTool(input: {
  readonly name: string;
  readonly args: unknown;
  readonly view: VoiceOracleThreadView;
  readonly sendToAgent: (text: string) => Promise<string | null>;
  readonly endSession: () => void;
}): Promise<unknown> {
  const args = (input.args ?? {}) as Record<string, unknown>;
  switch (input.name) {
    case "get_agent_status": {
      const activity = describeAgentActivity(input.view);
      return {
        provider: providerDisplayName(input.view.session?.providerName),
        sessionStatus: input.view.session?.status ?? "idle",
        latestTurnState: input.view.latestTurn?.state ?? null,
        working: activity.working,
        summary: activity.label,
        lastError: input.view.session?.lastError ?? null,
        messageCount: input.view.messages.length,
      };
    }
    case "get_thread_transcript": {
      const limit = clampCount(args.message_count, 10);
      return {
        threadTitle: input.view.threadTitle,
        messages: input.view.messages.slice(-limit).map((message) => ({
          role: message.role,
          ...(message.streaming ? { streaming: true } : {}),
          text: truncateForVoice(message.text, 2_000),
        })),
      };
    }
    case "send_message_to_agent": {
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (message.length === 0) {
        return { ok: false, error: "The message was empty; nothing was sent." };
      }
      const error = await input.sendToAgent(message);
      return error !== null
        ? { ok: false, error }
        : {
            ok: true,
            note: "Message sent. A system event will report back when the agent finishes its turn.",
          };
    }
    case "end_voice_session": {
      input.endSession();
      return {
        ok: true,
        note: "Hanging up after your closing line. Keep it to one short sentence.",
      };
    }
    default:
      return { error: `Unknown tool: ${input.name}` };
  }
}
