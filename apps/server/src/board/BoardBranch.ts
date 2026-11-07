// A card's mini pull request: the work's branch against the default branch,
// as it would merge. Read-only git, run on demand when a card back opens.
import type { BoardBranchView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const COMMITS_SHOWN = 30;
const FILES_SHOWN = 200;

/** `git diff --numstat` lines as files with their changed lines; binary files count as 0. */
export function parseNumstat(text: string): Array<{
  path: string;
  insertions: number;
  deletions: number;
}> {
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 3 && parts[2]!.length > 0)
    .map(([added, removed, ...path]) => ({
      path: path.join("\t"),
      insertions: Number.parseInt(added!, 10) || 0,
      deletions: Number.parseInt(removed!, 10) || 0,
    }));
}

/** `git log --format=%h%x1f%s%x1f%an%x1f%aI` lines as commits. */
export function parseLog(text: string): Array<{
  sha: string;
  subject: string;
  author: string;
  at: string;
}> {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", subject = "", author = "", at = ""] = line.split("\x1f");
      return { sha, subject, author, at };
    });
}

export const compareBranch = Effect.fn("BoardBranch.compare")(function* (input: {
  readonly cwd: string;
  readonly branch: string | null;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  /** stdout of a git command, or null when it fails. */
  const git = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("git", ["-C", input.cwd, ...args], {
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
            forceKillAfter: "1 second",
          }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (acc, chunk) => acc + chunk,
              ),
            ),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? stdout.trim() : null;
      }),
    ).pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => null),
    );

  const empty: BoardBranchView = {
    branch: input.branch,
    base: null,
    ahead: 0,
    behind: 0,
    insertions: 0,
    deletions: 0,
    files: [],
    commits: [],
    uncommitted: null,
  };
  if ((yield* git(["rev-parse", "--is-inside-work-tree"])) !== "true") return empty;
  const current = yield* git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = input.branch ?? (current === "HEAD" ? null : current);
  if (head === null || (yield* git(["rev-parse", "--verify", "--quiet", head])) === null) {
    return empty;
  }

  // The default branch's name: origin's HEAD, else main or master.
  const originHead = yield* git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  let name = originHead?.replace(/^origin\//, "") ?? null;
  if (name === null) {
    for (const candidate of ["main", "master"]) {
      const known =
        (yield* git(["rev-parse", "--verify", "--quiet", candidate])) ??
        (yield* git(["rev-parse", "--verify", "--quiet", `origin/${candidate}`]));
      if (known !== null) {
        name = candidate;
        break;
      }
    }
  }
  const local =
    name !== null && (yield* git(["rev-parse", "--verify", "--quiet", name])) !== null
      ? name
      : null;
  const remote =
    name !== null && (yield* git(["rev-parse", "--verify", "--quiet", `origin/${name}`])) !== null
      ? `origin/${name}`
      : null;
  const isAncestor = (older: string, newer: string) =>
    git(["merge-base", "--is-ancestor", older, newer]).pipe(Effect.map((out) => out !== null));
  // The newer of the local branch and origin's copy; a fork's own main when they diverged.
  let base: string | null = local ?? remote;
  if (local !== null && remote !== null && (yield* isAncestor(local, remote))) base = remote;
  if (base === null) return { ...empty, branch: head };

  const mergeBase = yield* git(["merge-base", base, head]);
  const [ahead, behind, log, numstat] = yield* Effect.all(
    [
      git(["rev-list", "--count", `${base}..${head}`]),
      git(["rev-list", "--count", `${head}..${base}`]),
      git([
        "log",
        "--no-merges",
        `--max-count=${COMMITS_SHOWN}`,
        "--format=%h%x1f%s%x1f%an%x1f%aI",
        `${base}..${head}`,
      ]),
      mergeBase === null
        ? Effect.succeed(null)
        : git(["diff", "--numstat", "--no-renames", mergeBase, head]),
    ],
    { concurrency: "unbounded" },
  );
  const files = parseNumstat(numstat ?? "");

  // Changes not yet committed, when the branch is the one checked out here.
  let uncommitted: BoardBranchView["uncommitted"] = null;
  if (head === current) {
    const [tracked, untracked] = yield* Effect.all(
      [
        git(["diff", "--numstat", "--no-renames", "HEAD"]),
        git(["ls-files", "--others", "--exclude-standard"]),
      ],
      { concurrency: "unbounded" },
    );
    const changed = parseNumstat(tracked ?? "");
    const added = (untracked ?? "").split("\n").filter((line) => line.length > 0);
    uncommitted = {
      files: changed.length + added.length,
      insertions: changed.reduce((sum, file) => sum + file.insertions, 0),
      deletions: changed.reduce((sum, file) => sum + file.deletions, 0),
    };
  }

  return {
    branch: head,
    base,
    ahead: Number.parseInt(ahead ?? "0", 10) || 0,
    behind: Number.parseInt(behind ?? "0", 10) || 0,
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files: files.slice(0, FILES_SHOWN),
    commits: parseLog(log ?? ""),
    uncommitted,
  } satisfies BoardBranchView;
});
