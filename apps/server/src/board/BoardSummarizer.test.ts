import { describe, expect, it } from "vite-plus/test";

import { shouldAutoMove, summaryPrompt } from "./BoardSummarizer.ts";

describe("shouldAutoMove", () => {
  const base = {
    suggested: "review" as const,
    confidence: 0.8,
    current: "fix" as const,
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
    expect(shouldAutoMove({ ...base, suggested: "archived" })).toBe(false);
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
