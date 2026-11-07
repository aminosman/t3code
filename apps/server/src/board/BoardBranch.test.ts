// @effect-diagnostics nodeBuiltinImport:off - the fixture is a real git repository on disk,
// built with plain git before the code under test reads it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { compareBranch, parseLog, parseNumstat } from "./BoardBranch.ts";

describe("parseNumstat and parseLog", () => {
  it("reads changed lines per file, binary files as zero, and commits", () => {
    assert.deepStrictEqual(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n"), [
      { path: "src/a.ts", insertions: 3, deletions: 1 },
      { path: "logo.png", insertions: 0, deletions: 0 },
    ]);
    assert.deepStrictEqual(parseLog("abc123\x1fFix login\x1fAmin\x1f2026-11-07T10:00:00Z"), [
      { sha: "abc123", subject: "Fix login", author: "Amin", at: "2026-11-07T10:00:00Z" },
    ]);
  });
});

describe("compareBranch", () => {
  it.live("shows a branch as it would merge into main, with what is not committed yet", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "board-branch-"));
      const run = (...args: string[]) =>
        NodeChildProcess.execFileSync("git", ["-C", dir, ...args], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "T",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "T",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        });
      const write = (file: string, text: string) =>
        NodeFS.writeFileSync(NodePath.join(dir, file), text);
      run("init", "-q", "-b", "main");
      write("a.txt", "one\n");
      run("add", ".");
      run("commit", "-q", "-m", "start");
      run("checkout", "-q", "-b", "feat/login");
      write("a.txt", "one\ntwo\n");
      run("commit", "-q", "-am", "Add two");
      write("b.txt", "new\nfile\n");
      run("add", ".");
      run("commit", "-q", "-m", "Add b");
      write("a.txt", "one\ntwo\nthree\n");
      write("c.txt", "untracked\n");

      const view = yield* compareBranch({ cwd: dir, branch: null });
      assert.strictEqual(view.branch, "feat/login");
      assert.strictEqual(view.base, "main");
      assert.deepStrictEqual([view.ahead, view.behind], [2, 0]);
      assert.deepStrictEqual(
        view.commits.map((commit) => commit.subject),
        ["Add b", "Add two"],
      );
      assert.deepStrictEqual(
        view.files.map((file) => [file.path, file.insertions, file.deletions]),
        [
          ["a.txt", 1, 0],
          ["b.txt", 2, 0],
        ],
      );
      assert.deepStrictEqual(view.uncommitted, { files: 2, insertions: 1, deletions: 0 });

      // A branch that is not checked out: no uncommitted changes to show.
      run("stash", "-q", "-u");
      run("checkout", "-q", "main");
      const other = yield* compareBranch({ cwd: dir, branch: "feat/login" });
      assert.deepStrictEqual([other.ahead, other.uncommitted], [2, null]);
      // A fork: origin's main has moved on, and the local main has commits of its own.
      const upstream = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "board-upstream-"));
      NodeChildProcess.execFileSync("git", ["clone", "-q", "--bare", dir, upstream]);
      run("remote", "add", "origin", upstream);
      run("fetch", "-q", "origin");
      write("fork.txt", "ours\n");
      run("add", ".");
      run("commit", "-q", "-m", "Fork-only commit");
      const fork = yield* compareBranch({ cwd: dir, branch: "feat/login" });
      assert.strictEqual(fork.base, "main");
      NodeFS.rmSync(upstream, { recursive: true, force: true });
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
