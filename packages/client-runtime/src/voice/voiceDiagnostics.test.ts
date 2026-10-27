import { describe, expect, it } from "vite-plus/test";

import { audioLevelToDbfs, summarizeVoiceConnectionStats } from "./voiceDiagnostics.js";

describe("voice connection diagnostics", () => {
  it("reports audio levels, loss, jitter, and selected-route health without network identifiers", () => {
    const stats = new Map([
      [
        "inbound",
        {
          id: "inbound",
          type: "inbound-rtp",
          kind: "audio",
          audioLevel: 0.5,
          packetsReceived: 100,
          packetsLost: 3,
          jitter: 0.025,
        },
      ],
      [
        "pair",
        {
          id: "pair",
          type: "candidate-pair",
          nominated: true,
          state: "succeeded",
          currentRoundTripTime: 0.08,
          bytesSent: 1_000,
          ip: "192.0.2.1",
        },
      ],
      ["video", { type: "inbound-rtp", kind: "video", packetsLost: 99 }],
      ["candidate", { type: "local-candidate", ip: "192.0.2.1", port: 5000 }],
    ]);

    expect(summarizeVoiceConnectionStats(stats)).toEqual([
      {
        id: "inbound",
        type: "inbound-rtp",
        kind: "audio",
        audioLevel: 0.5,
        audioLevelDbfs: -6.02,
        packetsReceived: 100,
        packetsLost: 3,
        jitter: 0.025,
      },
      {
        id: "pair",
        type: "candidate-pair",
        kind: undefined,
        nominated: true,
        currentRoundTripTime: 0.08,
        bytesSent: 1_000,
      },
    ]);
    expect(JSON.stringify(summarizeVoiceConnectionStats(stats))).not.toContain("192.0.2.1");
  });

  it("supports browser RTCStatsReport-shaped forEach collections", () => {
    const stats = {
      forEach(callback: (value: unknown) => void) {
        callback({ type: "media-source", kind: "audio", audioLevel: 0, totalAudioEnergy: 0 });
      },
    };
    expect(summarizeVoiceConnectionStats(stats)).toEqual([
      {
        type: "media-source",
        kind: "audio",
        audioLevel: 0,
        audioLevelDbfs: -120,
        totalAudioEnergy: 0,
      },
    ]);
  });

  it("uses dBFS, not an unbounded decibel value", () => {
    expect(audioLevelToDbfs(1)).toBe(0);
    expect(audioLevelToDbfs(0.1)).toBe(-20);
    expect(audioLevelToDbfs(-1)).toBe(-120);
    expect(audioLevelToDbfs(Number.NaN)).toBe(-120);
  });
});
