import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useWorkspaceState } from "../../state/workspace";
import { useMeetingsEnvironment } from "./use-meetings-environment";
import {
  phoneMeetingAudioUri,
  updatePhoneMeeting,
  usePhoneMeetings,
  type PhoneMeeting,
} from "./phone-meetings";

/**
 * Puts meetings recorded on the phone onto the Mac, by itself, whenever the
 * Mac that records meetings is reachable: the audio first, streamed to a URL
 * Roost signs, then the transcript and the user's notes. Roost writes them into
 * ~/Meetings, and tui transcribes the audio again, writes the notes and files
 * the meeting, as for one it recorded. A meeting stays on the phone until the
 * Mac has it, so nothing recorded offline is lost.
 */

/** Ids being sent now, so a status can say "Sending" and no two runs overlap. */
let sending = new Set<string>();
const listeners = new Set<() => void>();
const setSending = (next: Set<string>) => {
  sending = next;
  for (const listener of listeners) listener();
};

export function usePhoneMeetingSending(id: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sending.has(id),
  );
}

/** Ready to send: transcribed (or found untranscribable) and not on the Mac yet. */
export function needsSync(meeting: PhoneMeeting): boolean {
  return meeting.syncedAt === null && meeting.transcription !== "pending";
}

async function uploadAudio(environmentId: EnvironmentId, meeting: PhoneMeeting): Promise<void> {
  const { File, UploadType } = await import("expo-file-system");
  const file = new File(await phoneMeetingAudioUri(meeting.id));
  if (!file.exists) throw new Error("The recording's audio is missing on the phone.");
  const signed = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.phoneMeetingUploadUrl,
    { environmentId, input: { meetingId: meeting.id, sizeBytes: file.size } },
    { reportFailure: false, reportDefect: false },
  );
  if (signed._tag === "Failure") throw new Error("Roost on the Mac did not take the recording.");
  const relativeUrl = signed.value.relativeUrl;
  if (relativeUrl === null) return; // already on the Mac
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  const baseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const uploadUrl = baseUrl === null ? null : resolveAssetUrl(baseUrl, relativeUrl);
  if (uploadUrl === null) throw new Error("Not connected to the Mac.");
  const result = await file.upload(uploadUrl, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "Content-Type": "audio/mp4" },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`The audio upload failed (${result.status}).`);
  }
}

export async function syncPhoneMeeting(
  environmentId: EnvironmentId,
  meeting: PhoneMeeting,
): Promise<boolean> {
  if (sending.has(meeting.id)) return false;
  setSending(new Set([...sending, meeting.id]));
  try {
    await uploadAudio(environmentId, meeting);
    const imported = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.phoneMeetingImport,
      {
        environmentId,
        input: {
          meetingId: meeting.id,
          title: meeting.title,
          kind: meeting.kind,
          startedAt: meeting.startedAt,
          durationSeconds: meeting.durationSeconds,
          myNotes: meeting.myNotes,
          transcript: meeting.transcript.map((line) => ({
            seconds: line.seconds,
            text: line.text,
          })),
        },
      },
      { reportFailure: false, reportDefect: false },
    );
    if (imported._tag === "Failure") throw new Error("Roost on the Mac did not take the meeting.");
    await updatePhoneMeeting(meeting.id, (current) => ({
      ...current,
      syncedAt: new Date().toISOString(),
      syncProblem: null,
    }));
    return true;
  } catch (cause) {
    await updatePhoneMeeting(meeting.id, (current) => ({
      ...current,
      syncProblem: cause instanceof Error ? cause.message : "Could not send it to the Mac.",
    }));
    return false;
  } finally {
    const next = new Set(sending);
    next.delete(meeting.id);
    setSending(next);
  }
}

const RETRY_MS = 60_000;

/**
 * Mounted once on the home pager: sends every waiting meeting when the Mac
 * connects, when a recording finishes transcribing, and once a minute while
 * any is still waiting.
 */
export function usePhoneMeetingSync(): void {
  const environmentId = useMeetingsEnvironment();
  const { environments } = useWorkspaceState();
  const connected =
    environmentId !== null &&
    environments.some(
      (environment) =>
        environment.environmentId === environmentId && environment.connectionState === "connected",
    );
  const meetings = usePhoneMeetings();
  const waiting = useMemo(() => meetings.filter(needsSync), [meetings]);

  useEffect(() => {
    if (!connected || environmentId === null || waiting.length === 0) return;
    let cancelled = false;
    const run = async () => {
      for (const meeting of waiting) {
        if (cancelled) return;
        await syncPhoneMeeting(environmentId, meeting);
      }
    };
    void run();
    const timer = setInterval(() => void run(), RETRY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected, environmentId, waiting]);
}
