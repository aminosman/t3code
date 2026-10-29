import type { DesktopMicrophoneAccess } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/**
 * OS-level microphone gate. Only macOS has one; Windows and Linux report
 * "unsupported" and leave the decision to the browser permission layer.
 */
export class ElectronMediaAccess extends Context.Service<
  ElectronMediaAccess,
  {
    /**
     * Resolve the microphone grant, prompting once if the user has not been
     * asked yet. Prompting from the main process means a denial is reported
     * as a denial, rather than surfacing later as an opaque `getUserMedia`
     * failure in the renderer.
     */
    readonly requestMicrophone: Effect.Effect<DesktopMicrophoneAccess>;
  }
>()("@t3tools/desktop/electron/ElectronMediaAccess") {}

export const make = ElectronMediaAccess.of({
  requestMicrophone: Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin") {
      return "unsupported" as const;
    }
    return yield* Effect.suspend(() => {
      const status = Electron.systemPreferences.getMediaAccessStatus("microphone");
      if (status !== "not-determined") {
        return Effect.succeed<DesktopMicrophoneAccess>(status);
      }
      return Effect.promise(() => Electron.systemPreferences.askForMediaAccess("microphone")).pipe(
        // A suppressed macOS prompt leaves status not-determined. Re-read it so
        // the renderer can still prompt with getUserMedia rather than treating it as denied.
        Effect.map((granted): DesktopMicrophoneAccess =>
          granted ? "granted" : Electron.systemPreferences.getMediaAccessStatus("microphone"),
        ),
        // A rejected TCC call means the OS refused to answer, not that the
        // user declined; report the status rather than inventing a denial.
        Effect.catchCause(() =>
          Effect.succeed<DesktopMicrophoneAccess>(
            Electron.systemPreferences.getMediaAccessStatus("microphone"),
          ),
        ),
      );
    });
  }),
});

export const layer = Layer.succeed(ElectronMediaAccess, make);
