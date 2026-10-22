import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// ── tui screen ───────────────────────────────────────────────────────
//
// The Mac's screen on the phone, through this server. tui holds one
// `tuiScreen.connect` stream; while a phone is watching it captures the
// display and posts JPEG frames with `tuiScreen.frame`, and the phone
// follows them on `tuiScreen.subscribe`. The phone's taps, scrolls and
// typing come back on `tuiScreen.control` and reach tui on its stream,
// which puts them on the Mac as real input. The case it exists for: an
// agent opens a sign-in page the user must click through themselves.
//
// Coordinates are fractions of the frame (0…1 across and down), so neither
// side needs the other's pixel size.
//
// An agent thread that is blocked on something only the user can do at the
// Mac (a sign-in, a code, a captcha) asks for them with the
// `t3_screen_hand_over` MCP tool: the ask is pushed to the phone, listed on
// its screen view, and sent to tui with a hint of which window it is about,
// so tui shows the display that holds it. The phone's Done or Not now
// (`tuiScreen.resolve`) is sent back into the thread, which carries on.

export const TUI_SCREEN_MAX_FRAME_BASE64 = 4 * 1024 * 1024;

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** tui registering its stream. */
export const TuiScreenHost = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  version: Schema.optional(Schema.String),
});
export type TuiScreenHost = typeof TuiScreenHost.Type;

/** One picture of the display. */
export const TuiScreenFrame = Schema.Struct({
  seq: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  jpegBase64: Schema.String.check(Schema.isNonEmpty()).check(
    Schema.isMaxLength(TUI_SCREEN_MAX_FRAME_BASE64),
  ),
  /** The display's own size in points, for the phone's label. */
  displayWidth: Schema.optional(Schema.Number),
  displayHeight: Schema.optional(Schema.Number),
  /** Which display this is, of how many, left to right; and its name. */
  displayIndex: Schema.optional(Schema.Number),
  displayCount: Schema.optional(Schema.Number),
  displayName: Schema.optional(Schema.String),
});
export type TuiScreenFrame = typeof TuiScreenFrame.Type;

export const TuiScreenKey = Schema.Literals([
  "enter",
  "tab",
  "escape",
  "backspace",
  "space",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);
export type TuiScreenKey = typeof TuiScreenKey.Type;

export const TuiScreenModifier = Schema.Literals(["cmd", "shift", "opt", "ctrl"]);
export type TuiScreenModifier = typeof TuiScreenModifier.Type;

/** What the phone does on the screen. */
export const TuiScreenInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("click"),
    x: Fraction,
    y: Fraction,
    button: Schema.optional(Schema.Literals(["left", "right"])),
    /** 2 for a double click. */
    count: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("drag"),
    fromX: Fraction,
    fromY: Fraction,
    toX: Fraction,
    toY: Fraction,
  }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    x: Fraction,
    y: Fraction,
    /** Lines; positive scrolls the content up (wheel down). */
    dx: Schema.Number,
    dy: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4000)),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    key: TuiScreenKey,
    modifiers: Schema.optional(Schema.Array(TuiScreenModifier)),
  }),
  /** A shortcut such as ["cmd", "l"]: modifiers then one letter or key name. */
  Schema.Struct({
    type: Schema.Literal("shortcut"),
    keys: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(40)),
  }),
  /** Show another display: its index, left to right, as the frame numbers them. */
  Schema.Struct({ type: Schema.Literal("display"), index: Schema.Number }),
]);
export type TuiScreenInput = typeof TuiScreenInput.Type;

/** Which window an ask is about, so tui shows the display that holds it. */
export const TuiScreenTarget = Schema.Struct({
  /** The app's name or bundle id, e.g. "Google Chrome". */
  app: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** Words in the window's title, e.g. "Sign in". */
  windowTitle: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type TuiScreenTarget = typeof TuiScreenTarget.Type;

/** An agent waiting on the user at the screen. */
export const TuiScreenRequest = Schema.Struct({
  id: Schema.String,
  /** What the user is asked to do, in the agent's words. */
  reason: Schema.String,
  threadId: Schema.optional(Schema.String),
  threadTitle: Schema.optional(Schema.String),
  target: Schema.optional(TuiScreenTarget),
  createdAt: Schema.Number,
});
export type TuiScreenRequest = typeof TuiScreenRequest.Type;

/** The phone answering an ask. */
export const TuiScreenResolve = Schema.Struct({
  id: Schema.String,
  outcome: Schema.Literals(["done", "declined"]),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
});
export type TuiScreenResolve = typeof TuiScreenResolve.Type;

/** What tui receives on its stream. */
export const TuiScreenHostEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: Schema.String }),
  /** How many phones are watching; capture runs while it is above zero. */
  Schema.Struct({ type: Schema.Literal("viewers"), count: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("input"), input: TuiScreenInput }),
  /** Another tui took the stream; this one should not reconnect on its own. */
  Schema.Struct({ type: Schema.Literal("superseded") }),
  /** The asks waiting now, newest last; sent on connect and on every change. */
  Schema.Struct({ type: Schema.Literal("requests"), requests: Schema.Array(TuiScreenRequest) }),
]);
export type TuiScreenHostEvent = typeof TuiScreenHostEvent.Type;

/** tui telling the phone why there is no picture. */
export const TuiScreenStatus = Schema.Struct({
  /** `capturing` while frames flow; the others say what is in the way. */
  state: Schema.Literals(["idle", "capturing", "no-permission", "failed"]),
  text: Schema.optional(Schema.String),
});
export type TuiScreenStatus = typeof TuiScreenStatus.Type;

/** What the phone receives on its stream. */
export const TuiScreenEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("host"),
    connected: Schema.Boolean,
    status: Schema.optional(TuiScreenStatus),
  }),
  Schema.Struct({ type: Schema.Literal("status"), status: TuiScreenStatus }),
  Schema.Struct({ type: Schema.Literal("frame"), frame: TuiScreenFrame }),
  /** The asks waiting now, newest last; sent on subscribe and on every change. */
  Schema.Struct({ type: Schema.Literal("requests"), requests: Schema.Array(TuiScreenRequest) }),
]);
export type TuiScreenEvent = typeof TuiScreenEvent.Type;

export class TuiScreenError extends Schema.TaggedError<TuiScreenError>()("TuiScreenError", {
  message: Schema.String,
}) {}
