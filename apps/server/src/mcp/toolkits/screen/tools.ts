import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TuiInbox from "../../../tuiInbox/TuiInbox.ts";
import * as TuiScreen from "../../../tuiScreen/TuiScreen.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ScreenHandOverTool = Tool.make("t3_screen_hand_over", {
  description:
    "Ask the user to do something at this Mac's screen that only they can do: sign in, enter a password or a one-time code, approve a prompt, solve a captcha. Their phone is pushed, shows the Mac's screen live and lets them click and type on it; name the app and window so the right display is shown. Call this instead of guessing credentials or giving up, then end your turn and say what you are waiting for. When they finish, a message saying so arrives in this thread and you carry on. Fails when tui is not running on the Mac; then ask in chat.",
  parameters: Schema.Struct({
    reason: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(500)).annotate({
      description:
        "What the user should do, for their phone, e.g. 'Sign in to the AWS console in Chrome so I can read the bucket policy.'",
    }),
    app: Schema.optional(
      Schema.String.check(Schema.isMaxLength(200)).annotate({
        description: "The app holding the window, e.g. 'Google Chrome' or 'Safari', if known.",
      }),
    ),
    windowTitle: Schema.optional(
      Schema.String.check(Schema.isMaxLength(200)).annotate({
        description: "Words in that window's title, e.g. 'Amazon Web Services Sign-In', if known.",
      }),
    ),
  }),
  success: Schema.Struct({ requestId: Schema.String, message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    TuiScreen.TuiScreen,
    TuiInbox.TuiInbox,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Hand the screen to the user")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const ScreenToolkit = Toolkit.make(ScreenHandOverTool);
