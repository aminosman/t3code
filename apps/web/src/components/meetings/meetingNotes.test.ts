import { describe, expect, it } from "vite-plus/test";

import {
  meetingCitations,
  meetingStart,
  parseMeetingNotes,
  peopleLine,
  decodeMeetingRef,
  linkMeetingCitations,
} from "./meetingNotes";

const NOTES = `# Pricing for small law firms

The team settled on a price and who to call next.

## Key points
- Charge $500 a month for firms under 20 lawyers.
- Audit logs are required for e-signatures.

## Action items
- Amin texts Erin to book the 11:30 call.

tags: Legal Tech, Pricing
<sub>written by Claude Code on your account — verify before relying on it</sub>
`;

describe("parseMeetingNotes", () => {
  it("reads the title, summary, sections, tags and who wrote it", () => {
    const doc = parseMeetingNotes(NOTES, null);
    expect(doc.title).toBe("Pricing for small law firms");
    expect(doc.summary?.text).toBe("The team settled on a price and who to call next.");
    expect(doc.sections.map((section) => [section.heading, section.kind])).toEqual([
      ["Key points", "points"],
      ["Action items", "action"],
    ]);
    expect(doc.tags).toEqual(["Legal Tech", "Pricing"]);
    expect(doc.provenance).toMatch(/^written by Claude Code/);
  });

  it("marks the lines that carry what the user typed as theirs", () => {
    const doc = parseMeetingNotes(
      NOTES,
      "500/month for firms < 20 lawyers\nsomething else entirely",
    );
    expect(doc.sections[0]!.items.map((item) => item.mine)).toEqual([true, false]);
    expect(doc.sections[1]!.items[0]!.mine).toBe(false);
  });
});

describe("meeting helpers", () => {
  it("finds cited meetings once each, in order", () => {
    expect(
      meetingCitations("a [[2026.09.30-1335]] b [[2026.09.16-1002]] c [[2026.09.30-1335]]"),
    ).toEqual(["2026.09.30-1335", "2026.09.16-1002"]);
  });

  it("reads a meeting's start from its folder name", () => {
    expect(meetingStart("2026.09.30-1335")?.getHours()).toBe(13);
    expect(meetingStart("notes")).toBeNull();
  });

  it("names people and counts unnamed voices", () => {
    expect(peopleLine(["Mike", "Speaker a8cb", "Speaker 8dd4"])).toBe("Mike +2");
    expect(peopleLine(["Speaker a8cb"])).toBe("1 voice");
    expect(peopleLine(["Mo", "Omar", "Amin", "Bill"])).toBe("Mo, Omar & 2 others");
  });
});

describe("linkMeetingCitations", () => {
  it("turns [[meeting]] into a context link whose id survives the trip", () => {
    const linked = linkMeetingCitations("Mo emails Aaron [[2026.09.30-1335]].");
    expect(linked).toBe(
      "Mo emails Aaron [2026.09.30-1335](t3-context://v1/meeting/2026_002e09_002e30-1335).",
    );
    expect(decodeMeetingRef("2026_002e09_002e30-1335")).toBe("2026.09.30-1335");
  });

  it("leaves out the meeting the chat is on", () => {
    expect(
      linkMeetingCitations(
        "Email Aaron. [[2026.09.30-1335]] See [[2026.09.21-1330]].",
        "2026.09.30-1335",
      ),
    ).toBe("Email Aaron. See [2026.09.21-1330](t3-context://v1/meeting/2026_002e09_002e21-1330).");
  });
});
