// @effect-diagnostics nodeBuiltinImport:off - the fixture is a real git repository on disk,
// built with plain git before the checks read it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import { gitIn } from "./BoardBranch.ts";
import { checkGit, checkRecorded } from "./BoardChecks.ts";

describe("checkRecorded", () => {
  it("reads reviews, the test matrix and the regression run from the card", () => {
    const summary = {
      reviewedBy: ["GPT-6.1-Sol"],
      tests: [
        { case: "signed in", result: "pass" as const },
        { case: "signed out", result: "fail" as const },
      ],
      regression: { passed: true, command: "vp test", summary: "1904 passed", at: "" },
    };
    assert.deepStrictEqual(
      [
        checkRecorded({ kind: "reviews" }, summary)?.ok,
        checkRecorded({ kind: "tests" }, summary)?.ok,
        checkRecorded({ kind: "regression" }, summary)?.ok,
        checkRecorded({ kind: "tests" }, undefined)?.detail,
        checkRecorded({ kind: "pushed" }, summary),
      ],
      [false, false, true, "no test matrix recorded", null],
    );
    assert.isTrue(
      checkRecorded({ kind: "reviews" }, { ...summary, reviewedBy: ["A", "B"] })?.ok ?? false,
    );
  });
});

describe("checkGit", () => {
  it.live("knows a feature branch, whether it is pushed, and where it is merged", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "board-checks-"));
      const origin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "board-origin-"));
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
      NodeChildProcess.execFileSync("git", ["init", "-q", "--bare", origin]);
      run("init", "-q", "-b", "main");
      run("remote", "add", "origin", origin);
      write("a.txt", "one\n");
      run("add", ".");
      run("commit", "-q", "-m", "start");
      run("push", "-q", "origin", "main");
      run("branch", "-q", "staging");
      run("push", "-q", "origin", "staging");
      run("checkout", "-q", "-b", "feat/x");
      write("a.txt", "two\n");
      run("commit", "-q", "-am", "change");

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = gitIn(spawner, dir);
      const check = (kind: "feature-branch" | "pushed" | "merged", branch: string, into?: string) =>
        checkGit({ kind, ...(into ? { into } : {}) }, branch, "feat/x", git);

      assert.isTrue((yield* check("feature-branch", "feat/x")).ok);
      assert.isFalse((yield* check("feature-branch", "main")).ok);
      assert.strictEqual((yield* check("pushed", "feat/x")).detail, "feat/x is not on origin");
      run("push", "-q", "origin", "feat/x");
      assert.isTrue((yield* check("pushed", "feat/x")).ok);
      write("b.txt", "dirty\n");
      assert.strictEqual((yield* check("pushed", "feat/x")).detail, "1 file not committed");
      NodeFS.rmSync(NodePath.join(dir, "b.txt"));
      assert.isFalse((yield* check("merged", "feat/x", "staging")).ok);
      run("checkout", "-q", "staging");
      run("merge", "-q", "--ff-only", "feat/x");
      run("push", "-q", "origin", "staging");
      assert.isTrue((yield* check("merged", "feat/x", "staging")).ok);
      assert.isFalse((yield* check("merged", "feat/x", "main")).ok);
      NodeFS.rmSync(dir, { recursive: true, force: true });
      NodeFS.rmSync(origin, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
