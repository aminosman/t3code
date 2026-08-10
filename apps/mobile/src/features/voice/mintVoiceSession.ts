import {
  mintEnvironmentVoiceRealtimeSession,
  VoiceRealtimeSessionMintError,
} from "@t3tools/client-runtime/state/voiceHttp";
import type { EnvironmentId, VoiceRealtimeSessionResponse } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { MicrophoneAccessError } from "./voicePlatform";

/**
 * Mint a short-lived OpenAI Realtime client secret from the thread's
 * environment. Mirrors the web helper: cookie/bearer connections work;
 * relay/DPoP connections degrade with a clear error (no signer is threaded
 * through this imperative path yet).
 */
export async function mintVoiceRealtimeSession(
  environmentId: EnvironmentId,
): Promise<VoiceRealtimeSessionResponse> {
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (!prepared) {
    throw new VoiceRealtimeSessionMintError({
      code: "unavailable",
      message: "This environment is not connected.",
    });
  }
  return runtime.runPromise(
    mintEnvironmentVoiceRealtimeSession({ prepared, signer: Option.none() }),
  );
}

export function describeVoiceStartError(error: unknown): {
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
    return { notConfigured: false, message: error.message };
  }
  return { notConfigured: false, message: "Could not start the voice session." };
}
