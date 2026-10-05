import { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  registerTuiNotificationCategory,
  setTuiNotificationAnswerHandler,
} from "./tuiNotificationActions";

/**
 * Mounted once at the root: registers the Allow / Decline buttons for tui's
 * cards and sends what is tapped on them to the environment that asked.
 */
export function useTuiNotificationAnswers(): void {
  const control = useAtomCommand(serverEnvironment.controlTui, {
    label: "answer tui from a notification",
    reportFailure: false,
  });
  useEffect(() => {
    void registerTuiNotificationCategory();
    setTuiNotificationAnswerHandler(async (answer) => {
      const result = await control({
        environmentId: EnvironmentId.make(answer.environmentId),
        input: { type: "verdict", promptId: answer.promptId, verdict: answer.verdict },
      });
      if (result._tag === "Success") return true;
      // Answered elsewhere already, or tui gave up on it: nothing to retry.
      return /already been answered/.test(String(squashAtomCommandFailure(result)));
    });
    return () => setTuiNotificationAnswerHandler(null);
  }, [control]);
}
