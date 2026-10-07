import { describe, expect, it } from "vite-plus/test";

import {
  clockTime,
  defaultMeetingTitle,
  newPhoneMeetingId,
  transcriptLines,
} from "./phone-meetings";

describe("transcriptLines", () => {
  it("runs segments together until a pause, and times each line", () => {
    expect(
      transcriptLines([
        { text: "Can we look", startSecond: 0.2, endSecond: 1.1 },
        { text: "at the phone first?", startSecond: 1.3, endSecond: 2.4 },
        { text: "Sure.", startSecond: 6, endSecond: 6.5 },
        { text: "Swipe left for chats.", startSecond: 3725, endSecond: 3727 },
      ]),
    ).toEqual([
      { at: "0:00", seconds: 0, text: "Can we look at the phone first?" },
      { at: "0:06", seconds: 6, text: "Sure." },
      { at: "1:02:05", seconds: 3725, text: "Swipe left for chats." },
    ]);
  });
});

describe("phone meeting names", () => {
  it("sorts by time and reads as one", () => {
    expect(newPhoneMeetingId(new Date(2026, 9, 6, 17, 42))).toMatch(
      /^2026\.10\.06-1742-[a-z0-9]{1,4}$/,
    );
    expect(clockTime(59)).toBe("0:59");
    expect(defaultMeetingTitle("call", new Date(2026, 9, 6, 9, 5))).toMatch(/^Call at /);
  });
});
