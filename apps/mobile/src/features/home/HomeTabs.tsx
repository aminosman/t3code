import { Pressable, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { FLOAT_SHADOW } from "../../design/granola";

export type HomeTab = "meetings" | "home" | "chats";

export const HOME_TABS: ReadonlyArray<HomeTab> = ["meetings", "home", "chats"];

const TABS: ReadonlyArray<{ tab: HomeTab; icon: AppSymbolName; label: string }> = [
  { tab: "meetings", icon: "waveform", label: "Meetings" },
  { tab: "home", icon: "sparkles", label: "Home" },
  { tab: "chats", icon: "text.bubble", label: "Chats" },
];

const TAB_WIDTH = 42;

const TABS_HEIGHT = 34;

/**
 * Where the capsule sits: low, just over the home indicator, the way iOS
 * places its own tab bars, rather than a full safe-area inset above it.
 */
export function tabsBottom(safeAreaBottom: number): number {
  return Math.max(8, safeAreaBottom - 14);
}

/** Room a page leaves at its foot for the capsule and a small gap above it. */
export function tabsFootprint(safeAreaBottom: number): number {
  return tabsBottom(safeAreaBottom) + TABS_HEIGHT + 8;
}

/**
 * Three icons in one small floating capsule, 34 points tall, over all three
 * pages: Meetings, Home and Chats. The dark highlight follows the pager as
 * the finger moves (`position` runs 0 → 2). A dot marks a tab with something
 * waiting — a meeting being recorded, a thread that needs the user.
 */
export function HomeTabs(props: {
  readonly position: SharedValue<number>;
  readonly active: HomeTab;
  readonly badges: Partial<Record<HomeTab, "attention" | "live">>;
  readonly onSelect: (tab: HomeTab) => void;
}) {
  const highlight = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.min(2, Math.max(0, props.position.value)) * TAB_WIDTH }],
  }));
  return (
    <View
      className="rounded-full border border-gr-hairline bg-gr-raised p-[3px]"
      style={FLOAT_SHADOW}
    >
      <View className="flex-row">
        <Animated.View
          pointerEvents="none"
          className="absolute top-0 left-0 h-7 rounded-full bg-gr-button"
          style={[{ width: TAB_WIDTH }, highlight]}
        />
        {TABS.map(({ tab, icon, label }) => {
          const active = tab === props.active;
          const badge = props.badges[tab];
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
              hitSlop={{ top: 8, bottom: 8 }}
              onPress={() => props.onSelect(tab)}
              className="h-7 items-center justify-center rounded-full"
              style={{ width: TAB_WIDTH }}
            >
              <SymbolView
                name={icon}
                size={16}
                tintColorClassName={active ? "accent-gr-button-ink" : "accent-gr-ink-2"}
              />
              {badge ? (
                <View
                  className={
                    badge === "live"
                      ? "absolute top-1 right-2 size-1.5 rounded-full bg-gr-danger"
                      : "absolute top-1 right-2 size-1.5 rounded-full bg-gr-attention"
                  }
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
