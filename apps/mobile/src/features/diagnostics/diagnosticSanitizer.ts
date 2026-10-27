const MAX_STRING_LENGTH = 4_000;
const SECRET_KEY = /(?:secret|token|authorization|api[-_]?key|password|cookie|credential|sdp)/i;

function sanitizeText(text: string): string {
  return text
    .replace(/\b(?:sk|ek)_[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, MAX_STRING_LENGTH);
}

/** Strip secrets and bound arbitrary values before they can reach disk. */
export function sanitizeDiagnosticValue(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeText(value);
  if (value instanceof Error) {
    return sanitizeDiagnosticValue(
      { name: value.name, message: value.message, stack: value.stack },
      "",
      depth,
    );
  }
  if (depth >= 5) return "[depth limit]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeDiagnosticValue(entry, "", depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      if (
        childValue !== undefined &&
        typeof childValue !== "function" &&
        typeof childValue !== "symbol"
      ) {
        result[childKey] = sanitizeDiagnosticValue(childValue, childKey, depth + 1);
      }
    }
    return result;
  }
  return sanitizeText(String(value));
}
