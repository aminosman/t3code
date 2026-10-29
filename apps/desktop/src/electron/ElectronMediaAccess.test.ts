import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Electron from "electron";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { make } from "./ElectronMediaAccess.ts";

vi.mock("electron", () => ({
  systemPreferences: {
    getMediaAccessStatus: vi.fn(),
    askForMediaAccess: vi.fn(),
  },
}));

type MediaStatus = ReturnType<typeof Electron.systemPreferences.getMediaAccessStatus>;

it.effect.each<{
  platform: NodeJS.Platform;
  initial: MediaStatus;
  after?: MediaStatus;
  prompt?: boolean | "reject";
  expected: MediaStatus | "unsupported";
}>([
  { platform: "linux", initial: "not-determined", expected: "unsupported" },
  { platform: "win32", initial: "not-determined", expected: "unsupported" },
  { platform: "darwin", initial: "granted", expected: "granted" },
  { platform: "darwin", initial: "denied", expected: "denied" },
  { platform: "darwin", initial: "restricted", expected: "restricted" },
  { platform: "darwin", initial: "unknown", expected: "unknown" },
  { platform: "darwin", initial: "not-determined", prompt: true, expected: "granted" },
  {
    platform: "darwin",
    initial: "not-determined",
    after: "denied",
    prompt: false,
    expected: "denied",
  },
  {
    platform: "darwin",
    initial: "not-determined",
    after: "not-determined",
    prompt: false,
    expected: "not-determined",
  },
  {
    platform: "darwin",
    initial: "not-determined",
    after: "not-determined",
    prompt: "reject",
    expected: "not-determined",
  },
])("resolves microphone access for $platform/$initial/$prompt as $expected", (testCase) =>
  Effect.gen(function* () {
    const readStatus = vi.mocked(Electron.systemPreferences.getMediaAccessStatus);
    readStatus.mockReset().mockReturnValue(testCase.after ?? testCase.initial);
    readStatus.mockReturnValueOnce(testCase.initial);
    const ask = vi.mocked(Electron.systemPreferences.askForMediaAccess);
    ask.mockReset();
    if (testCase.prompt === "reject") {
      ask.mockRejectedValue(new Error("TCC unavailable"));
    } else {
      ask.mockResolvedValue(testCase.prompt ?? false);
    }

    const status = yield* make.requestMicrophone.pipe(
      Effect.provideService(HostProcess.Platform, testCase.platform),
    );

    expect(status).toBe(testCase.expected);
    expect(ask).toHaveBeenCalledTimes(testCase.prompt === undefined ? 0 : 1);
  }),
);
