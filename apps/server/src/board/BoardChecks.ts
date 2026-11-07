// The facts behind a column, checked by Roost rather than taken from the
// agent: reviews and test results from what the card records, the branch's
// state from git. An agent's move into a column waits for its checks.
import {
  BOARD_REVIEWS_WANTED,
  type BoardCheck,
  type BoardCheckResult,
  type BoardSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const DEFAULT_NAMES = new Set(["main", "master", "trunk", "develop"]);

/** The checks that read only what the card records. */
export function checkRecorded(
  check: BoardCheck,
  summary: Pick<BoardSummary, "reviewedBy" | "tests" | "regression"> | undefined,
): BoardCheckResult | null {
  switch (check.kind) {
    case "reviews": {
      const reviewers = summary?.reviewedBy ?? [];
      return {
        kind: check.kind,
        ok: reviewers.length >= BOARD_REVIEWS_WANTED,
        detail:
          reviewers.length === 0
            ? `no reviews yet; ${BOARD_REVIEWS_WANTED} needed`
            : `${reviewers.length}/${BOARD_REVIEWS_WANTED} reviews: ${reviewers.join(", ")}`,
      };
    }
    case "tests": {
      const cases = summary?.tests ?? [];
      const failing = cases.filter((entry) => entry.result === "fail");
      const passing = cases.filter((entry) => entry.result === "pass");
      return {
        kind: check.kind,
        ok: cases.length > 0 && failing.length === 0 && passing.length > 0,
        detail:
          cases.length === 0
            ? "no test matrix recorded"
            : failing.length > 0
              ? `${failing.length} of ${cases.length} cases failing: ${failing
                  .slice(0, 3)
                  .map((entry) => entry.case)
                  .join("; ")}`
              : `${passing.length} of ${cases.length} cases passing`,
      };
    }
    case "regression": {
      const run = summary?.regression ?? null;
      return {
        kind: check.kind,
        ok: run?.passed === true,
        detail:
          run === null
            ? "no regression run recorded"
            : `${run.passed ? "passed" : "failed"}: ${run.command}${run.summary ? ` (${run.summary})` : ""}`,
      };
    }
    default:
      return null;
  }
}

/** The checks that read the branch in git; `git` returns stdout, or null when the command fails. */
export const checkGit = Effect.fn("BoardChecks.checkGit")(function* (
  check: BoardCheck,
  branch: string | null,
  current: string | null,
  git: (args: ReadonlyArray<string>) => Effect.Effect<string | null>,
) {
  if (branch === null) {
    return {
      kind: check.kind,
      ...(check.into ? { into: check.into } : {}),
      ok: false,
      detail: "no branch on the card",
    };
  }
  switch (check.kind) {
    case "feature-branch":
      return {
        kind: check.kind,
        ok: !DEFAULT_NAMES.has(branch),
        detail: DEFAULT_NAMES.has(branch) ? `on ${branch}, not a feature branch` : `on ${branch}`,
      };
    case "pushed": {
      const remote = `origin/${branch}`;
      if ((yield* git(["rev-parse", "--verify", "--quiet", remote])) === null) {
        return { kind: check.kind, ok: false, detail: `${branch} is not on origin` };
      }
      const unpushed =
        Number.parseInt((yield* git(["rev-list", "--count", `${remote}..${branch}`])) ?? "0", 10) ||
        0;
      // Uncommitted changes count only where the branch is checked out.
      const dirty =
        branch === current
          ? ((yield* git(["status", "--porcelain", "--untracked-files=normal"])) ?? "")
              .split("\n")
              .filter((line) => line.length > 0).length
          : 0;
      return {
        kind: check.kind,
        ok: unpushed === 0 && dirty === 0,
        detail:
          unpushed > 0
            ? `${unpushed} commit${unpushed === 1 ? "" : "s"} not pushed`
            : dirty > 0
              ? `${dirty} file${dirty === 1 ? "" : "s"} not committed`
              : `pushed to ${remote}`,
      };
    }
    case "merged": {
      const into = check.into?.trim() || "main";
      const remote =
        (yield* git(["rev-parse", "--verify", "--quiet", `origin/${into}`])) !== null
          ? `origin/${into}`
          : null;
      const local = (yield* git(["rev-parse", "--verify", "--quiet", into])) !== null ? into : null;
      // The newer of the two; a fork's own branch when they diverged, as the mini PR does.
      const target =
        local !== null && remote !== null
          ? (yield* git(["merge-base", "--is-ancestor", local, remote])) !== null
            ? remote
            : local
          : (remote ?? local);
      if (target === null) {
        return { kind: check.kind, into, ok: false, detail: `no ${into} branch here` };
      }
      const merged = (yield* git(["merge-base", "--is-ancestor", branch, target])) !== null;
      return {
        kind: check.kind,
        into,
        ok: merged,
        detail: merged ? `${branch} is in ${target}` : `${branch} is not merged into ${target}`,
      };
    }
    default:
      return { kind: check.kind, ok: false, detail: "unknown check" };
  }
});
