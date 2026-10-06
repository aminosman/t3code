import { Pressable, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";

export type HomeTab = "meetings" | "home" | "chats";

export const HOME_TABS: ReadonlyArray<HomeTab> = ["meetings", "home", "chats"];

const TABS: ReadonlyArray<{ tab: HomeTab; icon: AppSymbolName; label: string }> = [
  { tab: "meetings", icon: "waveform", label: "Meetings" },
  { tab: "home", icon: "sparkles", label: "Home" },
  { tab: "chats", icon: "text.bubble", label: "Chats" },
];

const TAB_WIDTH = 42;

/** Room the floating capsule takes at the foot of every page. */
export const TABS_CLEARANCE = 46;

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
    <GlassSurface
      className="overflow-hidden rounded-full border border-border p-[3px]"
      fallbackClassName="bg-card"
    >
      <View className="flex-row">
        <Animated.View
          pointerEvents="none"
          className="absolute top-0 left-0 h-7 rounded-full bg-foreground"
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
                tintColorClassName={active ? "accent-screen" : "accent-icon-muted"}
              />
              {badge ? (
                <View
                  className={
                    badge === "live"
                      ? "absolute top-1 right-2 size-1.5 rounded-full bg-danger-foreground"
                      : "absolute top-1 right-2 size-1.5 rounded-full bg-warning-foreground"
                  }
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </GlassSurface>
  );
}
