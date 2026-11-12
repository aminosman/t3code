import { describe, expect, it } from "@effect/vitest";

import { isMcpLoopbackRedirectUri } from "./mcpConnections.ts";

describe("isMcpLoopbackRedirectUri", () => {
  it.each([
    ["http://localhost:3118/callback", true],
    ["http://127.0.0.1:3118/callback", true],
    ["http://[::1]:3118/callback", true],
    ["http://localhost/callback", false],
    ["https://localhost:3118/callback", false],
    ["http://example.com:3118/callback", false],
    ["http://localhost:3118/callback?x=1", false],
    ["http://user@localhost:3118/callback", false],
    ["not a url", false],
  ] as const)("%s → %s", (value, expected) => {
    expect(isMcpLoopbackRedirectUri(value)).toBe(expected);
  });
});
