// @effect-diagnostics nodeBuiltinImport:off -- the suite runs a fake Tui, a real shell script, as the updater would.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: { isPackaged: true, quit: vi.fn() } }));

import * as TuiUpdater from "./TuiUpdater.ts";

const plist = (extra: string) => `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>co.ficra.tui</string>
  ${extra}
</dict></plist>`;

function fakeTui(lines: Record<string, string>): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tui-updater-"));
  const script = NodePath.join(dir, "tui");
  const cases = Object.entries(lines)
    .map(([step, json]) => `  ${step}) echo 'log line' >&2; printf '%s\\n' '${json}' ;;`)
    .join("\n");
  NodeFS.writeFileSync(script, `#!/bin/sh\ncase "$2" in\n${cases}\n  *) exit 1 ;;\nesac\n`, {
    mode: 0o755,
  });
  return script;
}

describe("TuiUpdater", () => {
  it("runs only a Tui that says it answers headless", () => {
    const home = "/Users/someone";
    const userApp = NodePath.join(home, "Applications/Tui.app/Contents/Info.plist");
    const exists = () => true;
    assert.strictEqual(
      TuiUpdater.findTuiExecutable(home, () => plist(""), exists),
      null,
      "an older Tui launched with arguments is a second Tui",
    );
    assert.strictEqual(
      TuiUpdater.findTuiExecutable(
        home,
        (path) => (path === userApp ? plist("<key>TuiHeadlessUpdate</key><true/>") : ""),
        exists,
      ),
      NodePath.join(home, "Applications/Tui.app/Contents/MacOS/tui"),
    );
    assert.strictEqual(
      TuiUpdater.findTuiExecutable(
        home,
        () => {
          throw new Error("ENOENT");
        },
        exists,
      ),
      null,
    );
  });

  it("reads the last JSON line and ignores the rest", () => {
    assert.deepStrictEqual(
      TuiUpdater.parseTuiUpdateReport(
        'noise\n{"installed":"0.0.59","newer":true,"offered":"0.0.60"}\n',
      ),
      { installed: "0.0.59", newer: true, offered: "0.0.60" },
    );
    assert.strictEqual(TuiUpdater.parseTuiUpdateReport("no json here"), null);
  });

  it.effect("turns Tui's check and stage into electron-updater's events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const updater = TuiUpdater.make(
          fakeTui({
            check: '{"installed":"0.0.59","newer":true,"offered":"0.0.60"}',
            stage: '{"installed":"0.0.59","newer":true,"offered":"0.0.60","staged":"0.0.60"}',
          }),
        );
        const seen: Array<[string, unknown]> = [];
        for (const name of ["update-available", "update-not-available", "update-downloaded"]) {
          yield* updater.on(name, (info: unknown) => {
            seen.push([name, info]);
          });
        }
        yield* updater.checkForUpdates;
        yield* updater.downloadUpdate;
        assert.deepStrictEqual(seen, [
          ["update-available", { version: "0.0.60" }],
          ["update-downloaded", { version: "0.0.60" }],
        ]);
        assert.strictEqual(updater.managedByTui, true);
      }),
    ),
  );

  it.effect("fails the check with Tui's own words", () =>
    Effect.gen(function* () {
      const updater = TuiUpdater.make(
        fakeTui({ check: '{"newer":false,"error":"could not reach the update feed"}' }),
      );
      const error = yield* Effect.flip(updater.checkForUpdates);
      assert.strictEqual(error._tag, "ElectronUpdaterCheckForUpdatesError");
      assert.match(String((error.cause as Error).message), /reach the update feed/);
    }),
  );
});
