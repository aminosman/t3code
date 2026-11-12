import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import type { McpConnectionError } from "@t3tools/contracts";

import type { McpConnectionCompletedOAuth } from "./McpConnectionService.ts";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** What the browser shows after the authorization server sends it back. */
function mcpConnectionCallbackPage(input: {
  readonly path: string;
  readonly success: boolean;
  readonly name: string;
  readonly detail?: string;
  readonly returnUrl?: string;
}): string {
  const title = input.success ? `${input.name} is connected` : "Sign-in couldn't finish";
  const description = input.success
    ? input.returnUrl
      ? "Returning to Roost. Agents in this project can use it now."
      : "Agents in this project can use it now. You can close this tab."
    : (input.detail ?? "Return to Roost and try connecting again.");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · Roost</title>
${input.success && input.returnUrl ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(input.returnUrl)}">` : ""}
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18181b;background:#fafafa;color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:100%;max-width:440px;background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:32px;box-shadow:0 12px 40px #00000008}
.brand{font-size:18px;letter-spacing:-.5px;margin-bottom:36px;color:#71717a}.brand strong{color:#18181b}
.status{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:${input.success ? "#ecfdf5" : "#fef2f2"};color:${input.success ? "#059669" : "#dc2626"};margin-bottom:20px}
h1{font-size:24px;font-weight:600;letter-spacing:-.7px;line-height:1.25;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#71717a;margin:0}
a{display:inline-flex;align-items:center;justify-content:center;margin-top:28px;padding:10px 16px;border-radius:8px;background:#2563eb;color:white;font-size:14px;font-weight:500;text-decoration:none}
@media(prefers-color-scheme:dark){:root{color:#fafafa;background:#09090b}main{background:#18181b;border-color:#27272a;box-shadow:0 12px 40px #0003}.brand,p{color:#a1a1aa}.brand strong{color:#fafafa}.status{background:${input.success ? "#064e3b" : "#450a0a"};color:${input.success ? "#34d399" : "#f87171"}}}
</style></head><body><main><div class="brand"><strong>Roost</strong></div>
<div class="status" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${input.success ? '<path d="m5 12 4 4L19 6"/>' : '<path d="m6 6 12 12M6 18 18 6"/>'}</svg></div>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>
${input.returnUrl ? `<a href="${escapeHtml(input.returnUrl)}">Return to Roost</a>` : ""}
</main><script>history.replaceState(null,"",${JSON.stringify(input.path)});</script></body></html>`;
}

/** Finishes a sign-in from the authorization server's redirect and renders the outcome. */
export const mcpConnectionCallbackResponse = (
  completion: Effect.Effect<McpConnectionCompletedOAuth, McpConnectionError>,
  path: string,
) =>
  completion.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logWarning("MCP connection sign-in could not finish", { error }).pipe(
          Effect.as(
            HttpServerResponse.text(
              mcpConnectionCallbackPage({ path, success: false, name: "", detail: error.detail }),
              { status: 400, contentType: "text/html", headers: { "cache-control": "no-store" } },
            ),
          ),
        ),
      onSuccess: (completed) =>
        Effect.succeed(
          HttpServerResponse.text(
            mcpConnectionCallbackPage({
              path,
              success: true,
              name: completed.name,
              ...(completed.returnUrl === undefined ? {} : { returnUrl: completed.returnUrl }),
            }),
            { contentType: "text/html", headers: { "cache-control": "no-store" } },
          ),
        ),
    }),
  );
