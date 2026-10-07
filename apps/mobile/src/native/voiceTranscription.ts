import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

export interface TimedTranscriptSegment {
  readonly text: string;
  readonly startSecond: number;
  readonly endSecond: number;
}

/** On-device meeting transcription exists on iOS 26 only; elsewhere, none. */
export async function transcribeRecordingOnDevice(
  _uri: string,
): Promise<ReadonlyArray<TimedTranscriptSegment> | null> {
  return null;
}
