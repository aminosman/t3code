import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ClaudeSettings } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  ClaudeShadowHomeEntryConflictError,
  ClaudeShadowHomePathConflictError,
  materializeClaudeShadowHome,
  resolveClaudeHomeLayout,
} from "./ClaudeHomeLayout.ts";

const decodeClaudeSettingsValue = Schema.decodeSync(ClaudeSettings);

const decodeClaudeSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly binaryPath?: string;
}): ClaudeSettings => decodeClaudeSettingsValue(input);

const makeTempDir = Effect.fn("ClaudeHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("ClaudeHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

/** shared home + an un-materialized shadow path beside it. */
const makeHomes = Effect.fn("ClaudeHomeLayout.test.makeHomes")(function* () {
  const path = yield* Path.Path;
  const sharedHome = yield* makeTempDir("t3code-claude-shared-");
  const shadowRoot = yield* makeTempDir("t3code-claude-shadow-root-");
  return { sharedHome, shadowHome: path.join(shadowRoot, "shadow") };
});

it.layer(NodeServices.layer)("ClaudeHomeLayout", (it) => {
  describe("resolveClaudeHomeLayout", () => {
    it.effect("uses the configured config dir directly when no shadow home is set", () =>
      Effect.gen(function* () {
        const homePath = yield* makeTempDir("t3code-claude-home-");

        const layout = yield* resolveClaudeHomeLayout(decodeClaudeSettings({ homePath }));

        expect(layout).toMatchObject({
          mode: "direct",
          sharedHomePath: homePath,
          effectiveHomePath: homePath,
          continuationKey: `claude:home:${homePath}`,
        });
      }),
    );

    // An empty homePath must leave CLAUDE_CONFIG_DIR unset: setting it at all,
    // even to ~/.claude, selects a different Keychain slot than a default
    // install, which would silently log the instance out.
    it.effect("leaves the effective home unset for a default install", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;

        const layout = yield* resolveClaudeHomeLayout(decodeClaudeSettings({}));

        const defaultShared = path.join(NodeOS.homedir(), ".claude");
        expect(layout).toMatchObject({
          mode: "direct",
          sharedHomePath: defaultShared,
          effectiveHomePath: undefined,
          continuationKey: `claude:home:${defaultShared}`,
        });
      }),
    );

    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const { sharedHome, shadowHome } = yield* makeHomes();

        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `claude:home:${sharedHome}`,
        });
      }),
    );

    // Two accounts sharing one store must land in the same continuation group
    // so a thread started on either can resume on the other.
    it.effect("gives two shadows of one shared home the same continuation key", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { sharedHome, shadowHome } = yield* makeHomes();

        const first = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        const second = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({
            homePath: sharedHome,
            shadowHomePath: path.join(path.dirname(shadowHome), "other"),
          }),
        );

        expect(first.continuationKey).toBe(second.continuationKey);
        expect(first.effectiveHomePath).not.toBe(second.effectiveHomePath);
      }),
    );
  });

  describe("materializeClaudeShadowHome", () => {
    it.effect("does nothing for a direct layout", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* makeTempDir("t3code-claude-home-");

        const layout = yield* resolveClaudeHomeLayout(decodeClaudeSettings({ homePath }));
        yield* materializeClaudeShadowHome(layout);

        expect(yield* fileSystem.readDirectory(homePath)).toEqual([]);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "links shared state and keeps the identity file private",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome } = yield* makeHomes();

          yield* writeTextFile(path.join(sharedHome, "settings.json"), '{"theme":"dark"}\n');
          yield* writeTextFile(path.join(sharedHome, "skills", "a", "SKILL.md"), "shared\n");
          yield* writeTextFile(path.join(sharedHome, ".claude.json"), '{"shared":true}\n');
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, ".claude.json"), '{"shadow":true}\n');

          const layout = yield* resolveClaudeHomeLayout(
            decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeClaudeShadowHome(layout);

          // shared state reaches the shadow
          for (const entry of ["projects", "plugins", "skills", "plans", "settings.json"]) {
            const link = path.join(shadowHome, entry);
            expect(yield* fileSystem.readLink(link)).toBe(path.join(sharedHome, entry));
          }
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "skills/a/SKILL.md"))).toBe(
            "shared\n",
          );

          // identity stays this account's own
          expect(yield* fileSystem.readFileString(path.join(shadowHome, ".claude.json"))).toBe(
            '{"shadow":true}\n',
          );
          expect(yield* fileSystem.readFileString(path.join(sharedHome, ".claude.json"))).toBe(
            '{"shared":true}\n',
          );
        }),
    );

    // A shadow promoted from an older layout can still carry a link here;
    // leaving it would write this account's login into the shared store.
    it.effect.skipIf(!symlinksSupported)("clears a stale identity symlink", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { sharedHome, shadowHome } = yield* makeHomes();

        yield* writeTextFile(path.join(sharedHome, ".claude.json"), '{"shared":true}\n');
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        yield* fileSystem.symlink(
          path.join(sharedHome, ".claude.json"),
          path.join(shadowHome, ".claude.json"),
        );

        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        yield* materializeClaudeShadowHome(layout);

        expect(yield* fileSystem.exists(path.join(shadowHome, ".claude.json"))).toBe(false);
        expect(yield* fileSystem.readFileString(path.join(sharedHome, ".claude.json"))).toBe(
          '{"shared":true}\n',
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)("repoints a link aimed at the wrong target", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { sharedHome, shadowHome } = yield* makeHomes();
        const stale = yield* makeTempDir("t3code-claude-stale-");

        yield* fileSystem.makeDirectory(path.join(sharedHome, "skills"), { recursive: true });
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        yield* fileSystem.symlink(stale, path.join(shadowHome, "skills"));

        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        yield* materializeClaudeShadowHome(layout);

        expect(yield* fileSystem.readLink(path.join(shadowHome, "skills"))).toBe(
          path.join(sharedHome, "skills"),
        );
      }),
    );

    // Claude Code rewrites some entries by atomic rename, which turns the link
    // into a real file. Surface it rather than deleting the user's data.
    it.effect.skipIf(!symlinksSupported)("fails when a real file squats a shared link", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { sharedHome, shadowHome } = yield* makeHomes();

        yield* writeTextFile(path.join(sharedHome, "settings.json"), '{"shared":true}\n');
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        yield* writeTextFile(path.join(shadowHome, "settings.json"), '{"local":true}\n');

        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        const error = yield* Effect.flip(materializeClaudeShadowHome(layout));

        expect(error).toBeInstanceOf(ClaudeShadowHomeEntryConflictError);
        expect(yield* fileSystem.readFileString(path.join(shadowHome, "settings.json"))).toBe(
          '{"local":true}\n',
        );
      }),
    );

    // A newer Claude Code creates a directory (`state`, Sep 2026) inside the
    // shadow before the shared home has one; the shadow's copy becomes shared.
    it.effect.skipIf(!symlinksSupported)(
      "promotes a directory the shadow made before the shared home had it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome } = yield* makeHomes();

          yield* writeTextFile(path.join(shadowHome, "state", "verdicts.json"), '{"a":1}\n');
          // the shared home learns of `state` only from its own listing, so give it none
          const layout = yield* resolveClaudeHomeLayout(
            decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeClaudeShadowHome(layout);
          // second shadow of the same shared home sees it as a shared entry now
          yield* writeTextFile(path.join(sharedHome, "state", "later.json"), "{}\n");
          yield* materializeClaudeShadowHome(layout);

          expect(yield* fileSystem.readLink(path.join(shadowHome, "state"))).toBe(
            path.join(sharedHome, "state"),
          );
          expect(
            yield* fileSystem.readFileString(path.join(sharedHome, "state/verdicts.json")),
          ).toBe('{"a":1}\n');
        }),
    );

    // Both homes hold the directory: the shadow's files move over, and a name
    // the shared home already has is set aside under the shadow's backups.
    it.effect.skipIf(!symlinksSupported)(
      "merges a squatting directory into the shared one and sets clashes aside",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome } = yield* makeHomes();

          yield* writeTextFile(path.join(sharedHome, "state", "verdicts.json"), "shared\n");
          yield* writeTextFile(path.join(shadowHome, "state", "verdicts.json"), "local\n");
          yield* writeTextFile(path.join(shadowHome, "state", "only-here.json"), "mine\n");

          const layout = yield* resolveClaudeHomeLayout(
            decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeClaudeShadowHome(layout);

          expect(yield* fileSystem.readLink(path.join(shadowHome, "state"))).toBe(
            path.join(sharedHome, "state"),
          );
          expect(
            yield* fileSystem.readFileString(path.join(sharedHome, "state/verdicts.json")),
          ).toBe("shared\n");
          expect(
            yield* fileSystem.readFileString(path.join(sharedHome, "state/only-here.json")),
          ).toBe("mine\n");
          expect(
            yield* fileSystem.readFileString(
              path.join(shadowHome, "backups/shadow-merge/state/verdicts.json"),
            ),
          ).toBe("local\n");
        }),
    );

    it.effect("fails when the shadow home is the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-claude-shared-");

        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: sharedHome }),
        );
        const error = yield* Effect.flip(materializeClaudeShadowHome(layout));

        expect(error).toBeInstanceOf(ClaudeShadowHomePathConflictError);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("is idempotent", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { sharedHome, shadowHome } = yield* makeHomes();

        yield* writeTextFile(path.join(sharedHome, "skills", "a", "SKILL.md"), "shared\n");

        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        yield* materializeClaudeShadowHome(layout);
        const first = (yield* fileSystem.readDirectory(shadowHome)).toSorted();
        yield* materializeClaudeShadowHome(layout);

        expect((yield* fileSystem.readDirectory(shadowHome)).toSorted()).toEqual(first);
        expect(yield* fileSystem.readLink(path.join(shadowHome, "skills"))).toBe(
          path.join(sharedHome, "skills"),
        );
      }),
    );
  });
});
