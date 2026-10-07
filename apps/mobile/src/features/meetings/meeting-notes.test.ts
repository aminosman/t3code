import { describe, expect, it } from "vite-plus/test";

import { meetingDayLabel, parseMeetingNotes } from "./meeting-notes";

describe("parseMeetingNotes", () => {
  it("reads headings, nested bullets, checkboxes and plain lines", () => {
    expect(
      parseMeetingNotes(
        "# Decisions\n- Ship **one** OTA\n  - after the list lands\n- [ ] Write the [notes](x)\n\n---\nThanks all",
      ),
    ).toEqual([
      { id: "line-0", kind: "heading", text: "Decisions" },
      { id: "line-1", kind: "bullet", text: "Ship one OTA", depth: 0 },
      { id: "line-2", kind: "bullet", text: "after the list lands", depth: 1 },
      { id: "line-3", kind: "bullet", text: "Write the notes", depth: 0 },
      { id: "line-6", kind: "text", text: "Thanks all" },
    ]);
  });
});

describe("meetingDayLabel", () => {
  it("names today and yesterday", () => {
    const now = new Date(2026, 9, 6, 15, 0);
    expect(meetingDayLabel(new Date(2026, 9, 6, 9, 0).toISOString(), now)).toBe("Today");
    expect(meetingDayLabel(new Date(2026, 9, 5, 9, 0).toISOString(), now)).toBe("Yesterday");
    expect(meetingDayLabel(null, now)).toBe("Undated");
  });
});
