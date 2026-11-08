// Automatic reviewers: when an agent asks to move its card into a column that
// needs reviews and none are recorded, Roost starts two read-only reviewers on
// other models as children of the card's thread. Each one's findings wake the
// agent, as a delegate_task child's would.
import type {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpDelegateTaskInput,
} from "@t3tools/contracts";

export const AUTO_REVIEWERS = 2;

export interface Reviewer {
  readonly target: NonNullable<OrchestratorMcpDelegateTaskInput["target"]>;
  /** How the card names it in reviewedBy: the model, and the account when it is not the model. */
  readonly name: string;
}

/** The model's family, from its id: "claude", "gpt", "k", "grok". Unknown ids have none. */
export function modelFamily(model: string | null | undefined): string | null {
  // "openai/gpt-6.1-sol" and "kimi/k3.1-pro" name the model after the last slash.
  const id = (model ?? "").toLowerCase().split("/").at(-1) ?? "";
  const match = /^[a-z]+/u.exec(id);
  return match === null || match[0] === "default" ? null : match[0];
}

const HIGH_EFFORT_OPTIONS = ["reasoningEffort", "effort"];

/**
 * Two reviewers on model families other than the card's own and each other's,
 * at high effort where offered; short of families, another model, then a fresh
 * agent on the card's own model.
 */
export function pickReviewers(
  capabilities: OrchestratorMcpCapabilitiesResult,
  /** Accounts with a usage window spent: a reviewer there would fail at once. */
  spent: ReadonlySet<string> = new Set(),
): ReadonlyArray<Reviewer> {
  const ownFamily = modelFamily(capabilities.inheritedModel);
  const candidates = capabilities.providers
    .filter((provider) => provider.canRunChildTask && !spent.has(provider.providerInstanceId))
    .flatMap((provider) => {
      // The first model that names a family; a "default" alias says nothing of what runs.
      const model = provider.models.find((entry) => modelFamily(entry.id) !== null);
      if (model === undefined) return [];
      const effort = (model.options ?? []).find(
        (option) =>
          HIGH_EFFORT_OPTIONS.includes(option.id) &&
          "values" in option &&
          Array.isArray(option.values) &&
          option.values.includes("high"),
      );
      const label = model.label ?? model.id;
      const name =
        provider.displayName && !label.toLowerCase().includes(provider.displayName.toLowerCase())
          ? `${label} (${provider.displayName})`
          : label;
      return [
        {
          family: modelFamily(model.id),
          reviewer: {
            name,
            target: {
              providerInstanceId: provider.providerInstanceId,
              model: model.id,
              ...(effort === undefined ? {} : { options: [{ id: effort.id, value: "high" }] }),
            },
          } satisfies Reviewer,
        },
      ];
    });

  const picked: Reviewer[] = [];
  const families = new Set<string>(ownFamily === null ? [] : [ownFamily]);
  for (const candidate of candidates) {
    if (picked.length >= AUTO_REVIEWERS) break;
    if (families.has(candidate.family!)) continue;
    families.add(candidate.family!);
    picked.push(candidate.reviewer);
  }
  for (const candidate of candidates) {
    if (picked.length >= AUTO_REVIEWERS) break;
    if (modelFamily(candidate.reviewer.target.model) === ownFamily) continue;
    if (picked.some((entry) => entry.name === candidate.reviewer.name)) continue;
    picked.push(candidate.reviewer);
  }
  while (
    picked.length < AUTO_REVIEWERS &&
    capabilities.inheritedProviderInstanceId !== null &&
    !spent.has(capabilities.inheritedProviderInstanceId)
  ) {
    picked.push({
      // Numbered, so a retry can tell the one that started from the one that did not.
      name: `${capabilities.inheritedModel ?? "same model"} (fresh agent ${picked.length + 1})`,
      target: {
        providerInstanceId: capabilities.inheritedProviderInstanceId,
        ...(capabilities.inheritedModel === null ? {} : { model: capabilities.inheritedModel }),
      },
    });
  }
  return picked;
}

/** What a reviewer is told: the code, not the author's conclusions. */
export function reviewBrief(input: {
  readonly title: string;
  readonly summary: string;
  readonly cwd: string;
  readonly branch: string;
  readonly head: string;
  readonly base: string | null;
}): string {
  const range =
    input.base === null
      ? `the commits on ${input.branch} and any uncommitted changes`
      : `\`git diff ${input.base}...${input.head}\` (${input.branch} against ${input.base}) and any uncommitted changes`;
  return [
    "Read-only code review. Do not edit files, commit, push, or start other agents. Do not call t3_card_update: the card belongs to the thread that asked for this review, and your final message is your review.",
    "",
    `Repository: ${input.cwd}`,
    `What to review: ${range}.`,
    `The work, as its card describes it: ${input.title}${input.summary ? `. ${input.summary}` : ""}`,
    "",
    "Find what is wrong: bugs, behavior that changed without being meant to, missing cases, broken wiring, tests that do not test what they claim. Run read-only commands and the project's tests if that helps you be sure.",
    "Report each finding with file:line, what breaks and how, and how sure you are. Leave out style preferences.",
    'End with one line: "Verdict: approve" when nothing you found must be fixed before this is committed, otherwise "Verdict: changes".',
  ].join("\n");
}

/** "abc1234567", or "abc1234567 plus uncommitted changes" when the state has edits on top. */
function describeState(state: string): string {
  const [head, edits] = state.split("+");
  return `${(head ?? state).slice(0, 10)}${edits === undefined ? "" : " plus uncommitted changes"}`;
}

/** What the agent is told after Roost started its reviewers. */
export function reviewsStartedNote(names: ReadonlyArray<string>, state: string): string {
  return ` Roost started ${names.length} reviewer${names.length === 1 ? "" : "s"} on ${describeState(state)}: ${names.join(", ")}. End your turn; each one's findings wake you. Fix what is right, then record reviewedBy with the names of those who approved and ask again.`;
}

/** What the agent is told when reviewers already ran on this state of the work. */
export function reviewsAlreadyNote(names: ReadonlyArray<string>, state: string): string {
  return ` Roost already started reviewers on ${describeState(state)}: ${names.join(", ")}. If their results reached you, record reviewedBy with the names of those who approved; if they asked for changes, fix them, and new reviewers start on the changed work.`;
}
