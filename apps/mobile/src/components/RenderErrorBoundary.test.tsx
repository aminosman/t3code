import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const reported = vi.hoisted(() => ({
  observe: [] as unknown[],
  local: [] as Array<readonly [string, unknown]>,
}));
vi.mock("expo-observe", () => ({
  Observe: { reportError: (error: unknown) => reported.observe.push(error) },
}));
vi.mock("../features/diagnostics/localDiagnostics", () => ({
  recordLocalDiagnostic: (event: string, fields: unknown) => reported.local.push([event, fields]),
  recordLocalDiagnosticError: (event: string, error: unknown) =>
    reported.local.push([event, error]),
}));
vi.mock("react-native", () => ({ ScrollView: () => null, View: () => null }));
vi.mock("./ui/AppText", () => ({ AppText: () => null }));
vi.mock("./ui/Button", () => ({ Button: () => null }));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic() {} }));
import { RenderErrorBoundary } from "./RenderErrorBoundary";

const failure = new Error("row exploded");
function Exploding(): never {
  throw failure;
}

it("reports a caught render error to Observe and to the on-device diagnostics log", async () => {
  reported.observe.length = 0;
  reported.local.length = 0;
  using _console = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <RenderErrorBoundary renderFallback={() => null}>
          <Exploding />
        </RenderErrorBoundary>,
      ),
    );
    expect(reported.observe).toEqual([failure]);
    expect(reported.local[0]).toEqual(["app.render_error", failure]);
    expect(reported.local[1]?.[0]).toBe("app.render_component_stack");
    expect(reported.local[1]?.[1]).toEqual({
      componentStack: expect.stringContaining("Exploding"),
    });
  } finally {
    act(() => root.unmount());
  }
});
