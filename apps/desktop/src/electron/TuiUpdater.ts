// @effect-diagnostics nodeBuiltinImport:off -- Tui is a native app binary run once per step; its answer is one stdout line.
// Roost ships through Tui's feed, so Settings → Updates asks Tui, never T3's feed (Amin, Oct 30 2026).
// Each step runs `Tui.app/Contents/MacOS/tui --roost-update <step>` (HeadlessUpdate.swift in tui).
// Only a Tui with TuiHeadlessUpdate is run: an older one started with arguments is a second Tui.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Electron from "electron";

import * as ElectronUpdater from "./ElectronUpdater.ts";

const TUI_HEADLESS_FLAG = "--roost-update";
const CHECK_TIMEOUT_MS = 60_000;
// The download is the whole zip, ~180 MB, verified before it counts.
const STAGE_TIMEOUT_MS = 20 * 60_000;

/** What `tui --roost-update` prints. Key names are pinned by Tui's UpdateTests. */
export interface TuiUpdateReport {
  readonly installed?: string;
  readonly offered?: string;
  readonly newer: boolean;
  readonly staged?: string;
  readonly landed?: string;
  readonly error?: string;
}

function tuiBundleCandidates(home: string): ReadonlyArray<string> {
  return [NodePath.join(home, "Applications", "Tui.app"), "/Applications/Tui.app"];
}

/** The Tui app binary that answers headless, or null when no such Tui is installed. */
export function findTuiExecutable(
  home: string,
  readText: (path: string) => string = (path) => NodeFS.readFileSync(path, "utf8"),
  exists: (path: string) => boolean = NodeFS.existsSync,
): string | null {
  for (const bundle of tuiBundleCandidates(home)) {
    let plist: string;
    try {
      plist = readText(NodePath.join(bundle, "Contents", "Info.plist"));
    } catch {
      continue;
    }
    const isTui = /<key>CFBundleIdentifier<\/key>\s*<string>co\.ficra\.tui<\/string>/.test(plist);
    const answersHeadless = /<key>TuiHeadlessUpdate<\/key>\s*<true\s*\/>/.test(plist);
    const executable = NodePath.join(bundle, "Contents", "MacOS", "tui");
    if (isTui && answersHeadless && exists(executable)) return executable;
  }
  return null;
}

/** The last JSON line Tui printed. Tui's own log lines go to stderr. */
export function parseTuiUpdateReport(stdout: string): TuiUpdateReport | null {
  const lines = stdout.split("\n").map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Partial<TuiUpdateReport>;
      if (typeof parsed !== "object" || parsed === null) return null;
      return { ...parsed, newer: parsed.newer === true };
    } catch {
      return null;
    }
  }
  return null;
}

function runStep(executable: string, step: string, timeoutMs: number): Promise<TuiUpdateReport> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      executable,
      [TUI_HEADLESS_FLAG, step],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const report = parseTuiUpdateReport(String(stdout));
        if (report?.error) {
          reject(new Error(`Tui could not ${step} the Roost update: ${report.error}`));
          return;
        }
        if (report) {
          resolve(report);
          return;
        }
        reject(
          new Error(
            `Tui gave no answer to ${step}${error ? ` (${error.message.split("\n")[0]})` : ""}.`,
          ),
        );
      },
    );
  });
}

export function make(executable: string): ElectronUpdater.ElectronUpdater["Service"] {
  const events = new NodeEvents.EventEmitter();
  // An "error" event with no listener throws; DesktopUpdates listens once configured.
  events.on("error", () => {});
  const channel = "tui";

  return ElectronUpdater.ElectronUpdater.of({
    managedByTui: true,
    setFeedURL: Effect.fn("TuiUpdater.setFeedURL")(() => Effect.void),
    setAutoDownload: Effect.fn("TuiUpdater.setAutoDownload")(() => Effect.void),
    setAutoInstallOnAppQuit: Effect.fn("TuiUpdater.setAutoInstallOnAppQuit")(() => Effect.void),
    setChannel: Effect.fn("TuiUpdater.setChannel")(() => Effect.void),
    setAllowPrerelease: Effect.fn("TuiUpdater.setAllowPrerelease")(() => Effect.void),
    // Tui never offers an older Roost.
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: Effect.fn("TuiUpdater.setAllowDowngrade")(() => Effect.void),
    setFullChangelog: Effect.fn("TuiUpdater.setFullChangelog")(() => Effect.void),
    setDisableDifferentialDownload: Effect.fn("TuiUpdater.setDisableDifferentialDownload")(
      () => Effect.void,
    ),
    checkForUpdates: Effect.tryPromise({
      try: async () => {
        events.emit("checking-for-update");
        const report = await runStep(executable, "check", CHECK_TIMEOUT_MS);
        if (report.newer && report.offered) {
          events.emit("update-available", { version: report.offered });
        } else {
          events.emit("update-not-available", { version: report.installed });
        }
      },
      catch: (cause) => new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }),
    downloadUpdate: Effect.tryPromise({
      try: async () => {
        const report = await runStep(executable, "stage", STAGE_TIMEOUT_MS);
        if (!report.staged) {
          throw new Error("Tui found nothing newer to download.");
        }
        events.emit("download-progress", { percent: 100 });
        events.emit("update-downloaded", { version: report.staged });
      },
      catch: (cause) => new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }),
    // Tui swaps the bundle only once this Roost has exited, then opens the new one in front.
    quitAndInstall: Effect.fn("TuiUpdater.quitAndInstall")(({ isSilent, isForceRunAfter }) =>
      Effect.try({
        try: () => {
          const lander = NodeChildProcess.spawn(
            executable,
            [TUI_HEADLESS_FLAG, "land-after", String(process.pid)],
            {
              detached: true,
              stdio: "ignore",
            },
          );
          lander.unref();
          Electron.app.quit();
        },
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      }),
    ),
    on: Effect.fn("TuiUpdater.on")((eventName, listener) => {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    }),
  });
}

/**
 * Tui when this is a packaged Roost on a Mac with a Tui that answers headless; electron-updater
 * otherwise, which DesktopUpdates leaves off for a Roost (see `managedByTui` there).
 */
export const layer = Layer.effect(
  ElectronUpdater.ElectronUpdater,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const executable =
      platform === "darwin" &&
      Electron.app.isPackaged &&
      environment.T3CODE_DESKTOP_MOCK_UPDATES === undefined
        ? findTuiExecutable(home)
        : null;
    return executable ? make(executable) : ElectronUpdater.make;
  }),
);
