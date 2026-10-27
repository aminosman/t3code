import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  formatStartupCrashReport,
  parseStartupCrashRecords,
  type StartupCrashRecord,
} from "./crash-log-model";
import {
  getLocalDiagnosticsSummary,
  shareLocalDiagnostics,
  type LocalDiagnosticsSummary,
} from "./localDiagnostics";

// expo-updates keeps its persistent log this long. Reading any further back
// returns nothing, so this is the whole available window.
const LOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type CrashLogState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly records: ReadonlyArray<StartupCrashRecord> };

function appIdentity() {
  return {
    version: Constants.expoConfig?.version ?? "0.0.0",
    build:
      (Platform.OS === "ios"
        ? Constants.platform?.ios?.buildNumber
        : Constants.platform?.android?.versionCode?.toString()) ?? "dev",
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Startup crashes that TestFlight and the stores strip from their reports.
 * expo-updates' ErrorRecovery writes the JS error and component stack to its
 * own log before aborting the process, so the next launch can show it here.
 */
export function SettingsDiagnosticsRouteScreen() {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<CrashLogState>(() =>
    Updates.isEnabled ? { status: "loading" } : { status: "unavailable" },
  );
  const [copied, setCopied] = useState(false);
  const [summary, setSummary] = useState<LocalDiagnosticsSummary | null>(null);
  const [sharing, setSharing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getLocalDiagnosticsSummary().then((next) => {
      if (!cancelled) setSummary(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!Updates.isEnabled) return;
    let cancelled = false;
    Updates.readLogEntriesAsync(LOG_WINDOW_MS)
      .then((entries) => {
        if (cancelled) return;
        setState({ status: "ready", records: parseStartupCrashRecords(entries) });
      })
      .catch((error: unknown) => {
        console.warn("[diagnostics] could not read the expo-updates log", error);
        if (!cancelled) setState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const records = state.status === "ready" ? state.records : [];
  const copyReport = async () => {
    const ok = await tryCopyTextWithHaptic(formatStartupCrashReport(records, appIdentity()), {
      target: "crash report",
    });
    if (ok) setCopied(true);
  };

  const shareReport = async () => {
    setSharing(true);
    setActionError(null);
    try {
      await shareLocalDiagnostics(records);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not share diagnostics.");
    } finally {
      setSharing(false);
    }
  };

  return (
    <SettingsScreen title="Diagnostics">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
      >
        <SettingsSection title="Voice & app diagnostics">
          <View className="gap-1.5 px-4 py-3">
            <Text className="text-sm text-foreground-muted">
              {summary
                ? `${summary.events + (summary.native?.nativeEvents ?? 0)} events · ${formatBytes(summary.eventBytes + (summary.native?.nativeBytes ?? 0))}`
                : "Reading the on-device event log…"}
            </Text>
            {summary?.native ? (
              <Text className="text-sm text-foreground-muted">
                {`${summary.native.crashes} crashes · ${summary.native.hangs} hangs reported by iOS`}
              </Text>
            ) : Platform.OS === "ios" ? (
              <Text className="text-sm text-foreground-muted">
                Native audio-route and MetricKit details require the matching native build.
              </Text>
            ) : null}
          </View>
          <SettingsActionRow
            icon="tray.and.arrow.up"
            label={sharing ? "Preparing diagnostics…" : "Share voice & app diagnostics"}
            loading={sharing}
            disabled={sharing}
            onPress={() => void shareReport()}
          />
        </SettingsSection>

        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Includes actual headphone/speaker routes, mic and output levels in dBFS, packet loss and
          jitter, speech/VAD events, interruptions, disconnects, and app errors. iOS also includes
          MetricKit crash and hang reports. Nothing is uploaded automatically. Microphone audio,
          agent audio, transcripts, and API secrets are not recorded.
        </Text>
        {actionError ? (
          <Text className="px-2 text-sm leading-normal text-danger-foreground">{actionError}</Text>
        ) : null}

        <SettingsSection title="Startup crashes">
          {state.status === "loading" ? (
            <View className="items-center gap-3 px-6 py-8">
              <ActivityIndicator />
              <Text className="text-center text-sm text-foreground-muted">Reading crash log…</Text>
            </View>
          ) : state.status === "unavailable" ? (
            <EmptyState
              icon="exclamationmark.triangle"
              title="Crash log unavailable"
              detail="Startup crash records are only kept in store and TestFlight builds."
            />
          ) : records.length === 0 ? (
            <EmptyState
              icon="checkmark.circle"
              title="No startup crashes"
              detail="Nothing has taken the app down during launch in the last 7 days."
            />
          ) : (
            records.map((record, index) => (
              <CrashRow key={record.timestamp} record={record} first={index === 0} />
            ))
          )}
        </SettingsSection>

        <View className="gap-3">
          <SettingsSection title="Actions">
            <SettingsActionRow
              icon={copied ? "checkmark" : "doc.on.doc"}
              label={copied ? "Copied" : "Copy crash report"}
              disabled={state.status !== "ready"}
              onPress={() => void copyReport()}
            />
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Paste the report into a GitHub issue. It contains the app version, the JavaScript error
            message, and the component stack. Error messages can quote values from the app, so read
            it over before sharing.
          </Text>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function EmptyState(props: {
  readonly icon: "exclamationmark.triangle" | "checkmark.circle";
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <View className="items-center gap-2 px-6 py-8">
      <SymbolView
        name={props.icon}
        size={28}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="text-center text-base text-foreground">{props.title}</Text>
      <Text className="text-center text-sm text-foreground-muted">{props.detail}</Text>
    </View>
  );
}

function CrashRow(props: { readonly record: StartupCrashRecord; readonly first: boolean }) {
  const { record } = props;
  return (
    <View className={props.first ? "gap-1.5 p-4" : "gap-1.5 border-t border-border-subtle p-4"}>
      <Text className="text-xs text-foreground-muted">
        {new Date(record.timestamp).toLocaleString()}
      </Text>
      <Text selectable className="text-base leading-snug text-danger-foreground">
        {record.description}
      </Text>
      {record.frames.length > 0 ? (
        <Text selectable className="font-mono text-xs leading-snug text-foreground-muted">
          {record.frames.slice(0, 4).join("\n")}
        </Text>
      ) : null}
    </View>
  );
}
