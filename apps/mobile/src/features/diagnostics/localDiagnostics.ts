import Constants from "expo-constants";
import * as Device from "expo-device";
import { Directory, File, Paths } from "expo-file-system";
import { AppState, Platform, type ErrorUtils as ErrorUtilsApi } from "react-native";

import {
  nativeVoiceDiagnostics,
  type NativeDiagnosticsSummary,
} from "../voice/nativeVoiceDiagnostics";
import type { StartupCrashRecord } from "./crash-log-model";
import { sanitizeDiagnosticValue } from "./diagnosticSanitizer";

const MAX_EVENT_FILE_BYTES = 1_500_000;
const KEPT_ROTATED_FILES = 3;

type DiagnosticFields = Record<string, unknown>;
type WriteResult<T> = Promise<T>;

let writeQueue: Promise<void> = Promise.resolve();
let installed = false;
let rotationSequence = 0;

function enqueue<T>(operation: () => WriteResult<T>): WriteResult<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function diagnosticsDirectory() {
  const directory = new Directory(Paths.document, "diagnostics");
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function eventFiles() {
  const directory = diagnosticsDirectory();
  return directory
    .list()
    .filter(
      (entry): entry is InstanceType<typeof File> =>
        entry instanceof File &&
        (entry.name === "events.jsonl" || /^events-\d+-\d+\.jsonl$/.test(entry.name)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function writableEventFile() {
  const directory = diagnosticsDirectory();
  let file = new File(directory, "events.jsonl");
  if ((file.size ?? 0) > MAX_EVENT_FILE_BYTES) {
    rotationSequence += 1;
    const rotated = new File(directory, `events-${Date.now()}-${rotationSequence}.jsonl`);
    file.moveSync(rotated, { overwrite: true });
    file = new File(directory, "events.jsonl");
    for (const stale of eventFiles()
      .filter((entry) => entry.name !== "events.jsonl")
      .slice(0, -KEPT_ROTATED_FILES)) {
      stale.delete();
    }
  }
  if (!file.exists) file.create({ intermediates: true });
  return file;
}

function eventLine(event: string, fields: DiagnosticFields) {
  return `${JSON.stringify({
    t: new Date().toISOString(),
    e: event,
    platform: Platform.OS,
    ...(sanitizeDiagnosticValue(fields) as DiagnosticFields),
  })}\n`;
}

async function appendEvent(event: string, fields: DiagnosticFields) {
  await writableEventFile().write(eventLine(event, fields), { append: true });
}

function appendEventSync(event: string, fields: DiagnosticFields) {
  writableEventFile().writeSync(eventLine(event, fields), { append: true });
}

/** Fire-and-forget by design: diagnostics must never break a voice call. */
export function recordLocalDiagnostic(event: string, fields: DiagnosticFields = {}): void {
  void enqueue(() => appendEvent(event, fields)).catch((error: unknown) => {
    console.warn("[diagnostics] could not record an event", error);
  });
}

export function recordLocalDiagnosticError(event: string, error: unknown): void {
  const nsError = error as { domain?: unknown; code?: unknown } | null;
  recordLocalDiagnostic(event, {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    domain: nsError?.domain,
    code: nsError?.code,
  });
}

function recordLocalDiagnosticErrorSync(event: string, error: unknown): void {
  const nsError = error as { domain?: unknown; code?: unknown } | null;
  appendEventSync(event, {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    domain: nsError?.domain,
    code: nsError?.code,
  });
}

export interface LocalDiagnosticsSummary {
  readonly events: number;
  readonly eventBytes: number;
  readonly native: NativeDiagnosticsSummary | null;
}

export function getLocalDiagnosticsSummary(): Promise<LocalDiagnosticsSummary> {
  return enqueue(async () => {
    let events = 0;
    let eventBytes = 0;
    for (const file of eventFiles()) {
      eventBytes += file.size ?? 0;
      const text = await file.text();
      events += text.split("\n").length - 1;
    }
    let native: NativeDiagnosticsSummary | null = null;
    try {
      native = (await nativeVoiceDiagnostics()?.getDiagnosticsSummary()) ?? null;
    } catch {
      native = null;
    }
    return { events, eventBytes, native };
  });
}

export function createLocalDiagnosticsReport(
  startupCrashes: ReadonlyArray<StartupCrashRecord>,
): Promise<Record<string, unknown>> {
  return enqueue(async () => {
    const files = eventFiles();
    const javascriptEventFiles = await Promise.all(
      files.map(async (file) => ({ name: file.name, jsonl: await file.text() })),
    );
    let native: Record<string, unknown> | null = null;
    try {
      native = (await nativeVoiceDiagnostics()?.exportDiagnostics()) ?? null;
    } catch (error) {
      native = { exportError: error instanceof Error ? error.message : String(error) };
    }
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: {
        name: Constants.expoConfig?.name ?? "T3 Code",
        version: Constants.expoConfig?.version ?? "0.0.0",
        build:
          (Platform.OS === "ios"
            ? Constants.platform?.ios?.buildNumber
            : Constants.platform?.android?.versionCode?.toString()) ?? "dev",
        runtimeVersion: Constants.expoConfig?.runtimeVersion ?? null,
      },
      device: {
        platform: Platform.OS,
        osVersion: Device.osVersion,
        modelName: Device.modelName,
        deviceType: Device.deviceType,
      },
      privacy: {
        storage: "on-device only until explicitly shared",
        microphoneAudioRecorded: false,
        agentAudioRecorded: false,
        transcriptsRecorded: false,
        bluetoothDeviceNamesRecorded: false,
        bluetoothRouteIdentifiers: "SHA-256 hashes, truncated to 8 bytes",
        note: "Audio levels are dBFS estimates from WebRTC stats, not environmental sound-pressure levels.",
      },
      startupCrashes,
      javascriptEventFiles,
      native,
    };
  });
}

export async function shareLocalDiagnostics(
  startupCrashes: ReadonlyArray<StartupCrashRecord>,
): Promise<void> {
  const report = await createLocalDiagnosticsReport(startupCrashes);
  const Sharing = await import("expo-sharing");
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing is unavailable on this device.");
  }
  const file = new File(Paths.cache, "T3-diagnostics-latest.json");
  file.create({ intermediates: true, overwrite: true });
  await file.write(JSON.stringify(report));
  await Sharing.shareAsync(file.uri, {
    mimeType: "application/json",
    dialogTitle: "Share T3 voice and app diagnostics",
    UTI: "public.json",
  });
  recordLocalDiagnostic("diagnostics.shared", { bytes: file.size });
}

export function clearLocalDiagnostics(): Promise<void> {
  return enqueue(async () => {
    const directory = diagnosticsDirectory();
    for (const file of eventFiles()) file.delete();
    directory.delete();
    try {
      await nativeVoiceDiagnostics()?.clearDiagnostics();
    } catch {
      // The JavaScript log is still cleared when native diagnostics are absent.
    }
    recordLocalDiagnostic("diagnostics.cleared");
  });
}

/** Installed once at app launch, before the first voice session. */
export function installLocalDiagnostics(): void {
  if (installed) return;
  installed = true;
  try {
    nativeVoiceDiagnostics()?.startDiagnostics();
  } catch {
    // The JavaScript event log remains available without the native client.
  }
  recordLocalDiagnostic("app.launch", {
    version: Constants.expoConfig?.version,
    build:
      (Platform.OS === "ios"
        ? Constants.platform?.ios?.buildNumber
        : Constants.platform?.android?.versionCode?.toString()) ?? "dev",
    osVersion: Device.osVersion,
    modelName: Device.modelName,
  });
  AppState.addEventListener("change", (state) => {
    recordLocalDiagnostic("app.state_changed", { state });
  });
  const errorUtils = (globalThis as typeof globalThis & { ErrorUtils?: ErrorUtilsApi }).ErrorUtils;
  if (errorUtils) {
    const previousHandler = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      try {
        if (isFatal) recordLocalDiagnosticErrorSync("app.js_fatal", error);
        else recordLocalDiagnosticError("app.js_error", error);
      } catch {
        // Preserve React Native's crash behavior even if disk writing fails.
      }
      previousHandler(error, isFatal);
    });
  }
}
