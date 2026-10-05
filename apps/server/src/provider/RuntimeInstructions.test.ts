import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("tells every harness to search threads and meetings before work that may have a history", () => {
    const instructions = buildRuntimeInstructions({ harness: "Claude Code" });
    expect(instructions).toContain("<history>");
    expect(instructions).toContain("call t3_history_search with a plain description");
    expect(instructions).toContain("messageId as aroundMessageId");
    expect(instructions).toContain("t3_meeting_read with a hit's at as around");
    expect(instructions).toContain("call t3_history_feedback once");
    expect(instructions).toContain("not the present state of the code");
  });

  it("routes by ownership: owned work to delegate_task, work that stands alone to t3_thread_launch", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("<fresh_threads>");
    expect(instructions).toContain("does this thread own the work");
    expect(instructions).toMatch(/- Owned: delegate_task\./);
    expect(instructions).toMatch(/- Not owned: t3_thread_launch\./);
    expect(instructions).toContain("When it is genuinely unclear, choose owned");
    expect(instructions).toContain("pick a different provider than the one you run on");
    expect(instructions).toContain("Do not start either to split up ordinary work");
    expect(instructions).toContain("say when you start one and why");
    expect(instructions).not.toContain("t3_thread_create");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
