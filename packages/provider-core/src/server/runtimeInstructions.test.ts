import { assert, describe, it } from "@effect/vitest";

import {
  buildRuntimeInstructions,
  buildRuntimeInstructionSections,
} from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "one link_pull_request per PR");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(instructions, "Never wait with sleep");
    assert.include(instructions, "call unwatch_pull_request");
  });

  it("tells every harness to search threads and meetings before work that may have a history", () => {
    const instructions = buildRuntimeInstructions({ harness: "Claude Code" });

    assert.include(instructions, "<history>");
    assert.include(instructions, "call t3_history_search with a plain description");
    assert.include(instructions, "messageId as aroundMessageId");
    assert.include(instructions, "t3_meeting_read with a hit's at as around");
    assert.include(instructions, "call t3_history_feedback once");
    assert.include(instructions, "not the present state of the code");
  });

  it("routes by ownership: owned work to delegate_task, work that stands alone to t3_thread_launch", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "<fresh_threads>");
    assert.include(instructions, "does this thread own the work");
    assert.match(instructions, /- Owned: delegate_task\./);
    assert.match(instructions, /- Not owned: t3_thread_launch\./);
    assert.include(instructions, "When it is genuinely unclear, choose owned");
    assert.include(instructions, "pick a different provider than the one you run on");
    assert.include(instructions, "Do not start either to split up ordinary work");
    assert.include(instructions, "say when you start one and why");
    assert.notInclude(instructions, "t3_thread_create");
  });

  it("splits into the same blocks as the joined text, fresh_threads in two", () => {
    const runtime = { harness: "Codex", model: "gpt-6.1-sol", reasoningEffort: "high" };
    const sections = buildRuntimeInstructionSections(runtime);
    const freshThreads = sections.filter((section) => section.startsWith("<fresh_threads>"));

    assert.lengthOf(freshThreads, 2);
    for (const section of freshThreads) assert.isTrue(section.endsWith("</fresh_threads>"));
    const unwrap = (section: string) =>
      section.replace(/^<fresh_threads>\n/, "").replace(/\n<\/fresh_threads>$/, "");
    assert.equal(
      buildRuntimeInstructions(runtime),
      [
        ...sections.slice(0, -2),
        `<fresh_threads>\n${freshThreads.map(unwrap).join("\n")}\n</fresh_threads>`,
      ].join("\n\n"),
    );
  });

  it("keeps known model and effort metadata on one line", () => {
    assert.include(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
      "through the Codex harness, as custom model with high reasoning effort.",
    );
  });

  it("names the model by display name and slug when they differ", () => {
    assert.include(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
      "through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).",
    );
    assert.include(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
      "through the Codex harness, as my-model.",
    );
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });

    assert.include(instructions, "through the Cursor harness.");
    assert.notInclude(instructions, "reasoning effort");
  });
});
