import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  width: 320,
  scrollTo: vi.fn(),
  active: "",
  select: undefined as ((tab: "home" | "chats" | "meetings") => void) | undefined,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => children,
  Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} },
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: harness.width }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { ScrollView: ({ children }: { children: ReactNode }) => children },
  runOnJS: (fn: unknown) => fn,
  useAnimatedRef: () => ({ current: { scrollTo: harness.scrollTo } }),
  useSharedValue: () => ({ set() {} }),
  useAnimatedScrollHandler: (handlers: unknown) => handlers,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../meetings/MeetingsScreen", () => ({ MeetingsScreen: () => null }));
vi.mock("../meetings/phone-meeting-sync", () => ({ usePhoneMeetingSync() {} }));
vi.mock("./ChatsRouteScreen", () => ({ ChatsRouteScreen: () => null }));
vi.mock("./ShelvesHomeScreen", () => ({ useHomeData: () => ({}), ShelvesHomeScreen: () => null }));
vi.mock("./HomeTabs", () => ({
  HOME_TABS: ["meetings", "home", "chats"],
  tabsBottom: () => 0,
  HomeTabs: ({ active, onSelect }: { active: string; onSelect: typeof harness.select }) => {
    useLayoutEffect(() => {
      harness.active = active;
      harness.select = onSelect;
    });
    return null;
  },
}));
import { HomePager } from "./HomePager";

it("opens the linked page, allows tab changes, and retains the page through rotation", async () => {
  harness.width = 320;
  harness.scrollTo.mockClear();
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<HomePager page="chats" />));
    expect(harness.active).toBe("chats");
    expect(harness.scrollTo).toHaveBeenLastCalledWith({ x: 640, animated: true });
    act(() => harness.select!("meetings"));
    expect(harness.active).toBe("meetings");
    expect(harness.scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: true });
    harness.width = 640;
    await act(async () => root.render(<HomePager page="chats" />));
    expect(harness.active).toBe("meetings");
    expect(harness.scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: false });
    await act(async () => root.render(<HomePager page="home" />));
    expect(harness.active).toBe("home");
    expect(harness.scrollTo).toHaveBeenLastCalledWith({ x: 640, animated: true });
  } finally {
    act(() => root.unmount());
  }
});
