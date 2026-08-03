/**
 * Microphone acquisition, with the OS gate handled before the browser gate.
 *
 * On desktop macOS the TCC grant is resolved in the Electron main process
 * first, so a denial is reported as a denial instead of surfacing later as an
 * opaque `getUserMedia` failure with no way to tell "blocked by macOS" apart
 * from "blocked by the page".
 */

export class MicrophoneAccessError extends Error {
  readonly blockedBy: "os" | "browser" | "unavailable";

  constructor(input: { readonly blockedBy: "os" | "browser" | "unavailable"; message: string }) {
    super(input.message);
    this.name = "MicrophoneAccessError";
    this.blockedBy = input.blockedBy;
  }
}

const OS_DENIED_MESSAGE =
  "macOS is blocking microphone access for T3 Code. Enable it in System Settings → Privacy & Security → Microphone, then try again.";
const BROWSER_DENIED_MESSAGE =
  "Microphone access was denied. Allow the microphone for this app, then try again.";
const NO_DEVICE_MESSAGE = "No microphone was found. Connect one and try again.";

export async function acquireMicrophoneStream(): Promise<MediaStream> {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (bridge?.requestMicrophoneAccess) {
    // A bridge that predates this channel just resolves undefined; treat any
    // non-blocking answer as "let the browser layer decide".
    const status = await bridge.requestMicrophoneAccess().catch(() => "unknown" as const);
    if (status === "denied" || status === "restricted") {
      throw new MicrophoneAccessError({ blockedBy: "os", message: OS_DENIED_MESSAGE });
    }
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneAccessError({
      blockedBy: "unavailable",
      message: "This client cannot capture audio.",
    });
  }

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicrophoneAccessError({ blockedBy: "browser", message: BROWSER_DENIED_MESSAGE });
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new MicrophoneAccessError({ blockedBy: "unavailable", message: NO_DEVICE_MESSAGE });
    }
    throw new MicrophoneAccessError({
      blockedBy: "unavailable",
      message: "Could not open the microphone.",
    });
  }
}
