import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ usesSplitView: false, shown: "" }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: harness.usesSplitView } }),
}));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => "pad" }));
vi.mock("./HomePager", () => ({
  HomePager: () => {
    harness.shown = "pager";
    return null;
  },
}));
vi.mock("./ChatsRouteScreen", () => ({
  ChatsRouteScreen: () => {
    harness.shown = "chats";
    return null;
  },
}));
import { HomeRouteScreen } from "./HomeRouteScreen";

it("gives any compact window the pager, an iPad's included, and a split view the thread list", async () => {
  const root = createRoot(document.createElement("div"));
  try {
    harness.usesSplitView = false;
    await act(async () => root.render(<HomeRouteScreen />));
    expect(harness.shown).toBe("pager");
    harness.usesSplitView = true;
    await act(async () => root.render(<HomeRouteScreen key="split" />));
    expect(harness.shown).toBe("chats");
  } finally {
    act(() => root.unmount());
  }
});
