import { assert, it } from "@effect/vitest";

import { modelFamily, pickReviewers, reviewBrief } from "./autoReview.ts";

const provider = (
  providerInstanceId: string,
  models: ReadonlyArray<{ id: string; label?: string; options?: unknown }>,
  displayName: string | null = null,
  canRunChildTask = true,
) => ({
  providerInstanceId,
  driverKind: providerInstanceId,
  displayName,
  models,
  canRunChildTask,
  canRunCrossProviderChildTask: canRunChildTask,
  constraints: [],
});

const caps = (model: string, providers: ReadonlyArray<ReturnType<typeof provider>>) =>
  ({
    parentThreadId: "t",
    inheritedProviderInstanceId: "claudeAgent",
    inheritedModel: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    providers,
  }) as never;

it("reads a model's family from its id", () => {
  assert.strictEqual(modelFamily("claude-opus-5-5"), "claude");
  assert.strictEqual(modelFamily("gpt-6.1-sol"), "gpt");
  assert.strictEqual(modelFamily("k3.1-pro"), "k");
  assert.strictEqual(modelFamily("default"), null);
  assert.strictEqual(modelFamily("openai/gpt-6.1-sol"), "gpt");
  assert.strictEqual(modelFamily("kimi/k3.1-pro"), "k");
  assert.strictEqual(modelFamily("openrouter/google/gemini-2.5-pro"), "gemini");
});

it("picks two families other than the card's own, at high effort where offered", () => {
  const picked = pickReviewers(
    caps("claude-opus-5-5", [
      provider("claudeAgent", [{ id: "claude-opus-5-5" }], "Sunday"),
      provider(
        "codex",
        [{ id: "gpt-6.1-sol", options: [{ id: "reasoningEffort", values: ["medium", "high"] }] }],
        "Codex",
      ),
      provider("grok", [{ id: "grok-build" }], "Grok", false),
      provider("kimi", [{ id: "k3.1-pro", label: "Kimi K3.1 Pro" }], "Kimi"),
      provider("pi", [{ id: "default" }]),
    ]),
  );
  assert.deepStrictEqual(picked.map((entry) => [entry.name, entry.target]) as unknown, [
    [
      "gpt-6.1-sol (Codex)",
      {
        providerInstanceId: "codex",
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    ],
    ["Kimi K3.1 Pro", { providerInstanceId: "kimi", model: "k3.1-pro" }],
  ]);
});

it("skips accounts whose usage is spent, and a provider's model alias", () => {
  const picked = pickReviewers(
    caps("claude-opus-5-5", [
      provider("codex", [{ id: "gpt-6.1-sol" }], "Codex"),
      provider(
        "pi",
        [{ id: "default" }, { id: "kimi/k3.1-pro", label: "Kimi K3.1 Pro (1M)" }],
        "Pi",
      ),
      provider("claudeAgent", [{ id: "claude-opus-5-5" }]),
    ]),
    new Set(["codex"]),
  );
  assert.deepStrictEqual(
    picked.map((entry) => entry.name),
    ["Kimi K3.1 Pro (1M) (Pi)", "claude-opus-5-5 (fresh agent 2)"],
  );
});

it("falls back to a fresh agent on the card's own model when no other family is set up", () => {
  const picked = pickReviewers(
    caps("claude-opus-5-5", [provider("claudeAgent", [{ id: "claude-opus-5-5" }])]),
  );
  assert.deepStrictEqual(
    picked.map((entry) => entry.name),
    ["claude-opus-5-5 (fresh agent 1)", "claude-opus-5-5 (fresh agent 2)"],
  );
});

it("briefs a reviewer with the code and the range, not the author's conclusions", () => {
  const brief = reviewBrief({
    title: "Login loop",
    summary: "Fixing the redirect",
    cwd: "/repo",
    branch: "feat/login",
    head: "abc123",
    base: "main",
  });
  assert.include(brief, "Read-only code review");
  assert.include(brief, "Do not call t3_card_update");
  assert.include(brief, "git diff main...abc123");
  assert.include(brief, "Verdict: approve");
});
