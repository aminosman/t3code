import { describe, expect, it } from "vite-plus/test";

import { groupMeetingThreads } from "./MeetingThreads";

const entry = (threadId: string, action: "started" | "sent", request: string, at: string) => ({
  threadId,
  title: threadId,
  project: "ficra",
  action,
  request,
  at,
});

describe("groupMeetingThreads", () => {
  it("lists each thread once, in the order the meeting reached it, with every request", () => {
    const groups = groupMeetingThreads([
      entry(
        "northwind",
        "started",
        "look into Northwind's onboarding docs",
        "2026-10-07T13:11:40Z",
      ),
      entry("pilot", "sent", "tell the pilot thread the budget is 40k", "2026-10-07T13:12:10Z"),
      entry("northwind", "sent", "also check their SSO setup", "2026-10-07T13:14:00Z"),
    ]);
    expect(groups.map((group) => group.first.threadId)).toEqual(["northwind", "pilot"]);
    expect(groups[0]?.started).toBe(true);
    expect(groups[0]?.requests.map((request) => request.request)).toEqual([
      "look into Northwind's onboarding docs",
      "also check their SSO setup",
    ]);
    expect(groups[1]?.started).toBe(false);
  });
});
