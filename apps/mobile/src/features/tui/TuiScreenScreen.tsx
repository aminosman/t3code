import {
  EnvironmentId,
  type TuiScreenInput,
  type TuiScreenKey,
  type TuiScreenRequest,
} from "@t3tools/contracts";
import { EMPTY_TUI_SCREEN } from "@t3tools/client-runtime/tui-screen";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useTuiScreenGesture } from "./useTuiScreenGesture";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";

type TuiScreenScreenProps = StaticScreenProps<{ readonly environmentId?: string } | undefined>;

/** The environment last looked at, so the screen reopens on it. */
let lastEnvironmentId: string | null = null;

const KEYS: ReadonlyArray<{ readonly key: TuiScreenKey; readonly label: string }> = [
  { key: "enter", label: "↩" },
  { key: "tab", label: "⇥" },
  { key: "escape", label: "esc" },
  { key: "backspace", label: "⌫" },
  { key: "up", label: "↑" },
  { key: "down", label: "↓" },
  { key: "left", label: "←" },
  { key: "right", label: "→" },
];

const SHORTCUTS: ReadonlyArray<{ readonly keys: string; readonly label: string }> = [
  { keys: "cmd l", label: "⌘L" },
  { keys: "cmd a", label: "⌘A" },
  { keys: "cmd v", label: "⌘V" },
  { keys: "cmd w", label: "⌘W" },
  { keys: "cmd tab", label: "⌘⇥" },
];

export function TuiScreenScreen({ route }: TuiScreenScreenProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { environments: workspaceEnvironments } = useWorkspaceState();
  const environments = useMemo(() => {
    const state = new Map(
      workspaceEnvironments.map((environment) => [
        environment.environmentId,
        environment.connectionState,
      ]),
    );
    return Object.values(savedConnectionsById)
      .map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connected: state.get(connection.environmentId) === "connected",
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [savedConnectionsById, workspaceEnvironments]);

  const requested = route.params?.environmentId;
  const [picked, setChosen] = useState<string | null>(null);
  const chosen = requested ?? picked ?? lastEnvironmentId;
  const missingRequested =
    requested !== undefined &&
    !environments.some((candidate) => candidate.environmentId === requested);
  const environment = missingRequested
    ? null
    : (environments.find((candidate) => candidate.environmentId === chosen) ??
      environments.find((candidate) => candidate.connected) ??
      environments[0] ??
      null);
  const environmentId = environment ? EnvironmentId.make(environment.environmentId) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Remember the selected Mac across screen mounts in the environment selection registry.
  useEffect(() => {
    if (environmentId) lastEnvironmentId = environmentId;
  }, [environmentId]);

  const screen =
    useEnvironmentQuery(
      environmentId ? serverEnvironment.tuiScreen({ environmentId, input: {} }) : null,
    ).data ?? EMPTY_TUI_SCREEN;
  const control = useAtomCommand(serverEnvironment.controlTuiScreen, {
    label: "tui screen input",
    reportFailure: false,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const act = useCallback(
    async (input: TuiScreenInput) => {
      if (!environmentId) return;
      const result = await control({ environmentId, input });
      setProblem(result._tag === "Failure" ? "That did not reach the Mac." : null);
    },
    [control, environmentId],
  );

  const resolve = useAtomCommand(serverEnvironment.resolveTuiScreen, {
    label: "tui screen answer",
    reportFailure: false,
  });
  const answer = useCallback(
    async (request: TuiScreenRequest, outcome: "done" | "declined") => {
      if (!environmentId) return;
      const result = await resolve({ environmentId, input: { id: request.id, outcome } });
      setProblem(result._tag === "Failure" ? "That answer did not reach the agent." : null);
    },
    [resolve, environmentId],
  );

  const frame = screen.frame;
  const displayCount = frame?.displayCount ?? 1;
  const displayIndex = frame?.displayIndex ?? 0;
  const [box, setBox] = useState({ width: 0, height: 0 });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox({ width, height });
  };
  // The picture fits the box, keeping the display's shape; taps map
  // through this rectangle to fractions of the frame.
  const picture = useMemo(() => {
    if (!frame || box.width === 0 || box.height === 0) return null;
    const scale = Math.min(box.width / frame.width, box.height / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;
    return { width, height, x: (box.width - width) / 2, y: (box.height - height) / 2 };
  }, [frame, box]);

  const gesture = useTuiScreenGesture(picture, act);

  const [draft, setDraft] = useState("");
  const sendText = async () => {
    const text = draft;
    if (!text) return;
    setDraft("");
    await act({ type: "text", text });
  };

  const [shift, setShift] = useState(false);
  const pressKey = (key: TuiScreenKey) => {
    void act({ type: "key", key, ...(shift ? { modifiers: ["shift" as const] } : {}) });
    setShift(false);
  };

  const status = screen.status;
  const notice = missingRequested
    ? "The Mac that sent this isn't among your environments on this phone."
    : environment === null
      ? "Add the Mac that runs tui under Settings › Environments."
      : !screen.hostConnected
        ? `tui isn't connected on ${environment.label}.`
        : status.state === "no-permission"
          ? (status.text ?? "tui needs Screen Recording on the Mac. It has opened the setting.")
          : status.state === "failed"
            ? (status.text ?? "tui could not capture the screen.")
            : frame === null
              ? `Waiting for the first picture from ${environment.label}…`
              : null;

  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: environment ? `${environment.label} screen` : "Screen",
          headerShown: true,
        }}
      />
      <KeyboardAvoidingView
        className="flex-1 bg-black"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}
      >
        {environments.length > 1 ? (
          <ScrollView
            horizontal
            className="max-h-12 flex-none px-3 pt-2"
            contentContainerClassName="gap-2"
            showsHorizontalScrollIndicator={false}
          >
            {environments.map((candidate) => (
              <Pressable
                key={candidate.environmentId}
                onPress={() => {
                  setChosen(candidate.environmentId);
                  if (requested) navigation.setParams({ environmentId: undefined } as never);
                }}
                className={`rounded-full border px-3 py-1.5 ${
                  candidate.environmentId === environment?.environmentId
                    ? "border-primary bg-primary"
                    : "border-border bg-card"
                }`}
              >
                <Text
                  className={`font-sans text-sm ${
                    candidate.environmentId === environment?.environmentId
                      ? "text-primary-foreground"
                      : "text-foreground"
                  }`}
                >
                  {candidate.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {screen.requests.map((request) => (
          <View
            key={request.id}
            className="mx-3 mt-2 gap-2 rounded-2xl border border-primary/40 bg-card px-3.5 py-3"
          >
            <Text className="font-sans text-sm font-semibold text-foreground">
              {`${request.threadTitle ?? "An agent"} needs you`}
            </Text>
            <Text className="font-sans text-sm leading-5 text-foreground/80">{request.reason}</Text>
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => void answer(request, "done")}
                className="rounded-full bg-primary px-4 py-1.5"
              >
                <Text className="font-sans text-sm text-primary-foreground">Done</Text>
              </Pressable>
              <Pressable
                onPress={() => void answer(request, "declined")}
                className="rounded-full border border-border px-4 py-1.5"
              >
                <Text className="font-sans text-sm text-foreground">Not now</Text>
              </Pressable>
            </View>
          </View>
        ))}

        <GestureDetector gesture={gesture}>
          <View className="flex-1" onLayout={onLayout} collapsable={false}>
            {frame && picture ? (
              <Image
                source={{ uri: `data:image/jpeg;base64,${frame.jpegBase64}` }}
                cachePolicy="none"
                transition={0}
                contentFit="fill"
                style={{
                  position: "absolute",
                  left: picture.x,
                  top: picture.y,
                  width: picture.width,
                  height: picture.height,
                }}
              />
            ) : null}
            {notice ? (
              <View className="flex-1 items-center justify-center px-8">
                <Text className="text-center font-sans text-sm leading-5 text-white/70">
                  {notice}
                </Text>
              </View>
            ) : null}
          </View>
        </GestureDetector>

        {problem ? (
          <Text className="px-4 py-1 font-sans text-xs text-danger">{problem}</Text>
        ) : null}

        <ScrollView
          horizontal
          className="max-h-11 flex-none border-t border-white/10"
          contentContainerClassName="items-center gap-1.5 px-2"
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
        >
          {displayCount > 1 ? (
            <KeyButton
              label={`Display ${displayIndex + 1}/${displayCount}`}
              onPress={() =>
                void act({ type: "display", index: (displayIndex + 1) % displayCount })
              }
            />
          ) : null}
          <KeyButton label="⇧" active={shift} onPress={() => setShift((on) => !on)} />
          {KEYS.map((item) => (
            <KeyButton key={item.key} label={item.label} onPress={() => pressKey(item.key)} />
          ))}
          {SHORTCUTS.map((item) => (
            <KeyButton
              key={item.keys}
              label={item.label}
              onPress={() => void act({ type: "shortcut", keys: item.keys })}
            />
          ))}
        </ScrollView>

        <View
          className="flex-row items-end gap-2 border-t border-white/10 px-3 pt-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <AppTextInput
            className="max-h-24 min-h-10 flex-1 py-2"
            placeholder="Type on the Mac"
            value={draft}
            onChangeText={setDraft}
            autoCapitalize="none"
            autoCorrect={false}
            editable={environmentId !== null}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={() => void sendText()}
          />
          <Pressable
            accessibilityLabel="Type this on the Mac"
            disabled={draft.length === 0 || environmentId === null}
            onPress={() => void sendText()}
            className={`h-10 w-10 items-center justify-center rounded-full ${
              draft.length > 0 ? "bg-primary" : "bg-white/10"
            }`}
          >
            <SymbolView name="arrow.up" size={18} tintColorClassName="accent-primary-foreground" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

function KeyButton(props: {
  readonly label: string;
  readonly active?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      className={`h-8 min-w-10 items-center justify-center rounded-lg px-2.5 ${
        props.active ? "bg-primary" : "bg-white/10"
      }`}
    >
      <Text
        className={`font-sans text-sm ${props.active ? "text-primary-foreground" : "text-white"}`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
