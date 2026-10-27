export interface VoiceStatsReport {
  readonly id?: string;
  readonly type: string;
  readonly kind?: string;
  readonly audioLevel?: number;
  readonly audioLevelDbfs?: number;
  readonly [key: string]: string | number | boolean | undefined;
}

const NUMERIC_FIELDS = new Set([
  "audioLevel",
  "totalAudioEnergy",
  "totalSamplesDuration",
  "packetsReceived",
  "packetsSent",
  "packetsLost",
  "packetsDiscarded",
  "bytesReceived",
  "bytesSent",
  "jitter",
  "roundTripTime",
  "totalRoundTripTime",
  "currentRoundTripTime",
  "availableOutgoingBitrate",
  "availableIncomingBitrate",
  "concealedSamples",
  "concealmentEvents",
  "echoReturnLoss",
  "echoReturnLossEnhancement",
]);

export function audioLevelToDbfs(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return -120;
  return Math.max(-120, Math.round(20 * Math.log10(Math.min(1, level)) * 100) / 100);
}

function reportsFromUnknown(stats: unknown): Array<Record<string, unknown>> {
  const reports: Array<Record<string, unknown>> = [];
  const append = (value: unknown) => {
    if (value !== null && typeof value === "object") {
      reports.push(value as Record<string, unknown>);
    }
  };
  if (stats instanceof Map) {
    for (const value of stats.values()) append(value);
    return reports;
  }
  if (stats !== null && typeof stats === "object") {
    const forEach = (stats as { forEach?: unknown }).forEach;
    if (typeof forEach === "function") {
      (forEach as (callback: (value: unknown) => void) => void).call(stats, append);
      return reports;
    }
    for (const value of Object.values(stats)) append(value);
  }
  return reports;
}

/**
 * Compact, content-free WebRTC telemetry. Candidate IPs, SDP, track labels,
 * and arbitrary implementation-specific fields never enter the report.
 */
export function summarizeVoiceConnectionStats(stats: unknown): Array<VoiceStatsReport> {
  const summaries: Array<VoiceStatsReport> = [];
  for (const report of reportsFromUnknown(stats)) {
    const type = typeof report.type === "string" ? report.type : "unknown";
    const kind =
      typeof report.kind === "string"
        ? report.kind
        : typeof report.mediaType === "string"
          ? report.mediaType
          : undefined;
    const isAudioRtp = (type === "inbound-rtp" || type === "outbound-rtp") && kind === "audio";
    const isAudioSource =
      (type === "media-source" || type === "track") && (kind === undefined || kind === "audio");
    const isSelectedCandidatePair =
      type === "candidate-pair" && report.nominated === true && report.state === "succeeded";
    if (!isAudioRtp && !isAudioSource && !isSelectedCandidatePair) continue;

    const summary: {
      id?: string;
      type: string;
      kind?: string;
      audioLevel?: number;
      audioLevelDbfs?: number;
      [key: string]: string | number | boolean | undefined;
    } = { type };
    if (typeof report.id === "string") summary.id = report.id;
    if (kind !== undefined) summary.kind = kind;
    if (isSelectedCandidatePair) summary.nominated = true;
    for (const [key, value] of Object.entries(report)) {
      if (NUMERIC_FIELDS.has(key) && typeof value === "number" && Number.isFinite(value)) {
        summary[key] = value;
      }
    }
    if (typeof summary.audioLevel === "number") {
      summary.audioLevelDbfs = audioLevelToDbfs(summary.audioLevel);
    }
    summaries.push(summary);
    if (summaries.length >= 20) break;
  }
  return summaries;
}
