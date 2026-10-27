import { describe, expect, it } from "vite-plus/test";

import { sanitizeDiagnosticValue } from "./diagnosticSanitizer";

describe("local diagnostics sanitization", () => {
  it("redacts credentials recursively and preserves useful error details", () => {
    const sanitized = sanitizeDiagnosticValue({
      clientSecret: "secret-value",
      nested: { authorization: "Bearer token", packetLoss: 4 },
      error: new Error("connection failed"),
      embedded: "OpenAI rejected ek_1234567890abcdef and Bearer abcdef123456",
    }) as Record<string, unknown>;

    expect(sanitized.clientSecret).toBe("[redacted]");
    expect(sanitized.nested).toEqual({ authorization: "[redacted]", packetLoss: 4 });
    expect(sanitized.error).toMatchObject({ message: "connection failed" });
    expect(sanitized.embedded).toBe("OpenAI rejected [redacted] and Bearer [redacted]");
    expect(JSON.stringify(sanitized)).not.toContain("secret-value");
    expect(JSON.stringify(sanitized)).not.toContain("Bearer token");
  });

  it("bounds cyclic and oversized values instead of failing the voice call", () => {
    const cyclic: Record<string, unknown> = { message: "x".repeat(5_000) };
    cyclic.self = cyclic;
    const sanitized = sanitizeDiagnosticValue(cyclic) as Record<string, unknown>;
    expect(sanitized.message).toHaveLength(4_000);
    expect(JSON.stringify(sanitized)).toContain("depth limit");
  });
});
