import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as Option from "effect/Option";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RealtimeVoiceSession } from "@t3tools/client-runtime/voice/realtimeSession";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";

type SessionOptions = Parameters<typeof RealtimeVoiceSession.connect>[0];
const harness = vi.hoisted(() => ({
  shell: undefined as ReturnType<typeof makeThreadShellFixture> | undefined,
  options: undefined as SessionOptions | undefined,
  connect: vi.fn(),
  close: vi.fn(),
  setMuted: vi.fn(),
  injectContext: vi.fn(),
  goBack: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "voice-session-1" }));
vi.mock("../../lib/commandMetadata", () => ({ makeQueuedMessageMetadata: () => ({}) }));
vi.mock("react-native", () => ({ View: ({ children }: { children: ReactNode }) => children }));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children: ReactNode }) => children },
  cancelAnimation() {},
  Easing: { inOut: (x: unknown) => x, quad: 0 },
  useSharedValue: () => ({ value: 1, set() {} }),
  useAnimatedStyle: () => ({}),
  withRepeat: () => 1,
  withTiming: () => 1,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => harness }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: ({
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
    disabled: boolean;
  }) => <button aria-label={accessibilityLabel} onClick={onPress} disabled={disabled} />,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { startTurn: {} },
  useEnvironmentThread: () => ({ data: Option.none() }),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: harness.shell }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../diagnostics/localDiagnostics", () => ({
  recordLocalDiagnostic() {},
  recordLocalDiagnosticError() {},
}));
vi.mock("./mintVoiceSession", () => ({
  mintVoiceRealtimeSession: async () => ({ clientSecret: "secret", model: "model" }),
  describeVoiceStartError: () => ({ message: "failed" }),
}));
vi.mock("./nativeVoiceDiagnostics", () => ({ currentVoiceAudioSession: () => null }));
vi.mock("./voicePlatform", () => ({
  isVoiceSpeakerphoneOn: () => true,
  reactNativeVoicePlatform: {},
  setVoiceSpeakerphone() {},
  stopVoiceAudioSession() {},
  subscribeVoiceSpeakerphone: () => () => {},
}));
vi.mock("@t3tools/client-runtime/voice/realtimeSession", () => ({
  RealtimeVoiceSession: {
    connect: async (options: SessionOptions) => {
      harness.connect();
      harness.options = options;
      options.onStatusChange("listening");
      return {
        close: harness.close,
        setMuted: harness.setMuted,
        injectContext: harness.injectContext,
      };
    },
  },
}));

import { VoiceOracleScreen } from "./VoiceOracleScreen";

it("updates the visible thread and live voice tools without reconnecting", async () => {
  harness.connect.mockClear();
  harness.close.mockClear();
  harness.setMuted.mockClear();
  harness.shell = makeThreadShellFixture({
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make("thread-1"),
    title: "Before",
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const screen = () => (
    <VoiceOracleScreen route={{ params: { environmentId: "env-1", threadId: "thread-1" } }} />
  );
  try {
    await act(async () => root.render(screen()));
    expect(container.textContent).toContain("Before");
    harness.shell = { ...harness.shell, title: "After" };
    await act(async () => root.render(screen()));
    expect(container.textContent).toContain("After");
    expect(harness.connect).toHaveBeenCalledTimes(1);
    const transcript = await harness.options!.onToolCall(
      "get_thread_transcript",
      {},
      {} as RealtimeVoiceSession,
    );
    expect(transcript).toMatchObject({ threadTitle: "After" });
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Mute microphone"]')!.click(),
    );
    expect(harness.setMuted).toHaveBeenLastCalledWith(true);
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Unmute microphone"]')!.click(),
    );
    expect(harness.setMuted).toHaveBeenLastCalledWith(false);
  } finally {
    act(() => root.unmount());
  }
  expect(harness.close).toHaveBeenCalledTimes(1);
});
