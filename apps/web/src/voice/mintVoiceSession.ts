import type { EnvironmentId, VoiceRealtimeSessionResponse } from "@t3tools/contracts";
import {
  mintEnvironmentVoiceRealtimeSession,
  VoiceRealtimeSessionMintError,
} from "@t3tools/client-runtime/state/voiceHttp";
import * as Option from "effect/Option";
import { runtime } from "~/lib/runtime";
import { readPreparedConnection } from "~/state/session";
import { MicrophoneAccessError } from "./microphoneAccess";

/**
 * Mint a short-lived OpenAI Realtime client secret from the thread's
 * environment. Throws `VoiceRealtimeSessionMintError` with a user-facing
 * message when the environment is unreachable or has no API key configured.
 */
export async function mintVoiceRealtimeSession(
  environmentId: EnvironmentId,
): Promise<VoiceRealtimeSessionResponse> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) {
    throw new VoiceRealtimeSessionMintError({
      code: "unavailable",
      message: "This environment is not connected.",
    });
  }
  // No DPoP signer is available outside the connection runtime, so voice
  // sessions require a cookie or bearer connection (same constraint as the
  // HTTP thread-snapshot fast path, which also degrades over relay).
  return runtime.runPromise(
    mintEnvironmentVoiceRealtimeSession({ prepared, signer: Option.none() }),
  );
}

export function describeVoiceMintError(error: unknown): {
  readonly notConfigured: boolean;
  readonly message: string;
} {
  if (error instanceof MicrophoneAccessError) {
    return { notConfigured: false, message: error.message };
  }
  if (error instanceof VoiceRealtimeSessionMintError) {
    return { notConfigured: error.code === "not-configured", message: error.message };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { notConfigured: error.message.includes("not-configured"), message: error.message };
  }
  return { notConfigured: false, message: "Could not start the voice session." };
}
