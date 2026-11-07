import { afterEach, describe, expect, it } from "vite-plus/test";

import { boardStopHook, setBoardStopCheck } from "./stopGuard.ts";

const signal = new AbortController().signal;
const stop = (active: boolean) =>
  ({
    hook_event_name: "Stop",
    stop_hook_active: active,
    session_id: "s",
    transcript_path: "",
    cwd: "",
  }) as never;

describe("boardStopHook", () => {
  afterEach(() => setBoardStopCheck(null));

  it("sends an unreported turn back once, and lets a reported or resent one end", async () => {
    expect(boardStopHook("t")).toBeUndefined();
    let reported = false;
    setBoardStopCheck(async () => (reported ? null : "update your card"));
    const hook = boardStopHook("t")!;
    expect(await hook(stop(false), undefined, { signal })).toEqual({
      decision: "block",
      reason: "update your card",
    });
    // Already sent back once this stop: let it end.
    expect(await hook(stop(true), undefined, { signal })).toEqual({});
    reported = true;
    expect(await hook(stop(false), undefined, { signal })).toEqual({});
  });
});
