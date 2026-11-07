import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_BOARD_COLUMNS } from "@t3tools/contracts";

import { handBackMessage } from "./BoardFlow.ts";

import {
  agentReportedTurn,
  shouldAutoMove,
  summaryPrompt,
  summarySystemPrompt,
} from "./BoardSummarizer.ts";

describe("shouldAutoMove", () => {
  const base = {
    suggested: "review",
    suggestedPutsAway: false,
    confidence: 0.8,
    current: "fix",
    placedByUserAt: null,
    turnStartedAt: "2026-11-07T10:00:00.000Z",
    archived: false,
  };

  it("moves a confident, different column", () => {
    expect(shouldAutoMove(base)).toBe(true);
  });

  it("stays put when unsure, unchanged, archived, or told to archive", () => {
    expect(shouldAutoMove({ ...base, confidence: 0.4 })).toBe(false);
    expect(shouldAutoMove({ ...base, suggested: "fix" })).toBe(false);
    expect(shouldAutoMove({ ...base, archived: true })).toBe(false);
    expect(shouldAutoMove({ ...base, suggested: "archived", suggestedPutsAway: true })).toBe(false);
  });

  it("respects a card the user placed during the turn, not one placed before it", () => {
    expect(shouldAutoMove({ ...base, placedByUserAt: "2026-11-07T10:05:00.000Z" })).toBe(false);
    expect(shouldAutoMove({ ...base, placedByUserAt: "2026-11-07T09:00:00.000Z" })).toBe(true);
  });
});

describe("summaryPrompt", () => {
  it("keeps the newest messages when the thread is long", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index} ${"x".repeat(1_400)}`,
    }));
    const prompt = summaryPrompt({
      title: "Fix login",
      stage: null,
      previous: null,
      turn: "completed",
      waitingOnUser: true,
      messages,
    });
    expect(prompt).toContain("Last turn: completed, waiting on the user");
    expect(prompt).toContain("message 39");
    expect(prompt).not.toContain("message 0 ");
    expect(prompt.length).toBeLessThan(26_000);
  });
});

describe("summarySystemPrompt", () => {
  it("tells Claude the user's own columns and what each is for", () => {
    const prompt = summarySystemPrompt([
      ...DEFAULT_BOARD_COLUMNS.slice(0, 2),
      {
        id: "qa",
        title: "QA on staging",
        description: "Deployed to staging, waiting for QA.",
        archives: false,
      },
    ]);
    expect(prompt).toContain('- qa ("QA on staging"): Deployed to staging, waiting for QA.');
    expect(prompt).toContain('- fix ("Fix")');
    expect(prompt).not.toContain("deployed");
  });
});

describe("agentReportedTurn", () => {
  it("leaves a turn the thread's agent reported on, and summarizes the rest", () => {
    const turn = "2026-11-07T10:00:00.000Z";
    expect(
      agentReportedTurn({ source: "agent", summarizedAt: "2026-11-07T10:05:00.000Z" }, turn),
    ).toBe(true);
    expect(
      agentReportedTurn({ source: "agent", summarizedAt: "2026-11-07T09:00:00.000Z" }, turn),
    ).toBe(false);
    expect(
      agentReportedTurn({ source: "auto", summarizedAt: "2026-11-07T10:05:00.000Z" }, turn),
    ).toBe(false);
    expect(agentReportedTurn(undefined, turn)).toBe(false);
  });
});

describe("handBackMessage", () => {
  it("passes on the user's comments since the agent last wrote", () => {
    const message = handBackMessage([
      { id: 1, threadId: "t", author: "user", body: "old note", createdAt: "" },
      { id: 2, threadId: "t", author: "agent", body: "Please sign in.", createdAt: "" },
      { id: 3, threadId: "t", author: "user", body: "Signed in.", createdAt: "" },
    ] as never);
    expect(message).toContain("- Signed in.");
    expect(message).not.toContain("old note");
  });
});
