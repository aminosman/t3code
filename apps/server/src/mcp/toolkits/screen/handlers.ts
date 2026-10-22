import { CommandId, MessageId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as TuiInbox from "../../../tuiInbox/TuiInbox.ts";
import * as TuiScreen from "../../../tuiScreen/TuiScreen.ts";
import { readMutationCaller } from "../../threadAccess.ts";
import { ScreenToolkit } from "./tools.ts";

/** What the thread is told when the phone answers its ask. */
export function answerText(reason: string, outcome: "done" | "declined", note?: string): string {
  const said = note?.trim() ? ` They said: "${note.trim()}"` : "";
  return outcome === "done"
    ? `Done at the screen: ${reason}${said} Carry on from where you stopped.`
    : `Not now at the screen: ${reason}${said} Don't wait on it; carry on without it or say what is left.`;
}

export const ScreenToolkitHandlersLive = ScreenToolkit.toLayer({
  t3_screen_hand_over: (input) =>
    Effect.gen(function* () {
      const { threads, caller } = yield* readMutationCaller();
      const screen = yield* TuiScreen.TuiScreen;
      const inbox = yield* TuiInbox.TuiInbox;
      const crypto = yield* Crypto.Crypto;
      if (!(yield* screen.hostConnected)) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "tui is not running on this Mac, so the user cannot see the screen from their phone. Ask them in chat instead.",
        });
      }
      const target = {
        ...(input.app?.trim() ? { app: input.app.trim() } : {}),
        ...(input.windowTitle?.trim() ? { windowTitle: input.windowTitle.trim() } : {}),
      };
      const threadTitle = caller.title.trim() || undefined;
      const { request } = yield* screen.ask(
        {
          reason: input.reason,
          threadId: caller.id,
          ...(threadTitle ? { threadTitle } : {}),
          ...(Object.keys(target).length > 0 ? { target } : {}),
        },
        (resolution) =>
          Effect.gen(function* () {
            const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
            yield* threads.sendToThread({
              projectId: caller.projectId,
              commandId: CommandId.make(`tui-screen:${id}`),
              threadId: ThreadId.make(caller.id),
              messageId: MessageId.make(`message:tui-screen:${id}`),
              text: answerText(input.reason, resolution.outcome, resolution.note),
              attachments: [],
              mode: "auto",
              createdBy: "user",
              creationSource: "mobile",
            });
          }).pipe(Effect.asVoid, Effect.orDie),
      );
      yield* inbox.notify({
        title: `${threadTitle ?? "An agent"} needs you at the screen`,
        body: input.reason,
        collapseId: `tui-screen-${request.id}`,
        deepLink: "/tui-screen",
        data: { kind: "tui-screen", requestId: request.id, threadId: caller.id },
      });
      return {
        requestId: request.id,
        message:
          "The user's phone has been asked and shows the screen. End your turn now and say what you are waiting for; a message arrives in this thread when they are done.",
      };
    }),
});
