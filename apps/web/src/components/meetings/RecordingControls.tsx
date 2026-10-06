import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  HistoryMeetingSummary,
  TuiInboxMeetingAction,
} from "@t3tools/contracts";
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { toastManager } from "~/components/ui/toast";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Bars } from "./MeetingsParts";

const PENDING_LABEL: Record<TuiInboxMeetingAction, string> = {
  pause: "Pausing…",
  resume: "Resuming…",
  stop: "Stopping…",
};

function ControlButton({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 items-center gap-1 rounded-full border border-(--mt-hairline) bg-(--mt-surface) px-2.5 text-xs font-medium text-(--mt-ink) hover:bg-(--mt-hover) disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * The meeting's recording, from its page: Pause and Stop while tui records
 * it, Resume and End while it is paused, Resume for a while after it ended.
 * tui does the recording; each button is a command sent to it through
 * Roost's tui inbox, and the page follows what tui then writes into the
 * meeting's folder (recording.json, transcript.live).
 */
export function RecordingControls({
  environmentId,
  meeting,
  onSent,
}: {
  environmentId: EnvironmentId;
  meeting: HistoryMeetingSummary;
  /** Read the meeting again: tui has been told, and changes the folder soon after. */
  onSent: () => void;
}) {
  const controlTui = useAtomCommand(serverEnvironment.controlTui, { reportFailure: false });
  const [pending, setPending] = useState<TuiInboxMeetingAction | null>(null);
  const state = meeting.live === true ? (meeting.recording ?? "recording") : null;

  // The pending label holds until the folder says the command took effect.
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), 15_000);
    return () => clearTimeout(timer);
  }, [pending]);
  const [sentFrom, setSentFrom] = useState(state);
  if (pending !== null && state !== sentFrom) {
    setPending(null);
  }

  const send = async (action: TuiInboxMeetingAction) => {
    setPending(action);
    setSentFrom(state);
    const result = await controlTui({
      environmentId,
      input: { type: "meeting", action, meetingId: meeting.id },
    });
    if (result._tag === "Failure") {
      setPending(null);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Tui didn't get that",
          description: error instanceof Error ? error.message : "Tui is not connected on the Mac.",
        });
      }
      return;
    }
    // tui stops or starts the recorder within a second or two.
    for (const delay of [800, 2500, 5000]) setTimeout(onSent, delay);
  };

  const busy = pending !== null;
  const label = (action: TuiInboxMeetingAction, text: string) =>
    pending === action ? PENDING_LABEL[action] : text;

  if (state === "recording") {
    return (
      <div className="mb-3 flex w-fit items-center gap-2 rounded-full border border-(--mt-hairline) bg-(--mt-raised) py-1 pr-1 pl-3 text-xs font-medium text-(--mt-accent)">
        <Bars live />
        Recording — the notes update as the meeting goes
        <ControlButton
          onClick={() => void send("pause")}
          disabled={busy}
          icon={<PauseIcon className="size-3" />}
        >
          {label("pause", "Pause")}
        </ControlButton>
        <ControlButton
          onClick={() => void send("stop")}
          disabled={busy}
          icon={<SquareIcon className="size-3" />}
        >
          {label("stop", "Stop")}
        </ControlButton>
      </div>
    );
  }
  if (state === "paused") {
    return (
      <div className="mb-3 flex w-fit items-center gap-2 rounded-full border border-(--mt-hairline) bg-(--mt-raised) py-1 pr-1 pl-3 text-xs font-medium text-(--mt-ink-2-strong)">
        <Bars live={false} />
        Paused — the meeting is still open
        <ControlButton
          onClick={() => void send("resume")}
          disabled={busy}
          icon={<PlayIcon className="size-3" />}
        >
          {label("resume", "Resume")}
        </ControlButton>
        <ControlButton
          onClick={() => void send("stop")}
          disabled={busy}
          icon={<SquareIcon className="size-3" />}
        >
          {label("stop", "End meeting")}
        </ControlButton>
      </div>
    );
  }
  if (state === "transcribing") {
    return (
      <div className="mb-3 flex w-fit items-center gap-2 rounded-full border border-(--mt-hairline) bg-(--mt-raised) px-3 py-1 text-xs font-medium text-(--mt-ink-2-strong)">
        <Bars live />
        Transcribing the whole meeting — the final notes come next
      </div>
    );
  }
  if (meeting.resumable === true) {
    return (
      <div className="mb-3 flex w-fit items-center gap-2 rounded-full border border-(--mt-hairline) bg-(--mt-raised) py-1 pr-1 pl-3 text-xs text-(--mt-ink-2)">
        Ended — carry on recording into this meeting
        <ControlButton
          onClick={() => void send("resume")}
          disabled={busy}
          icon={<PlayIcon className="size-3" />}
        >
          {label("resume", "Resume")}
        </ControlButton>
      </div>
    );
  }
  return null;
}
