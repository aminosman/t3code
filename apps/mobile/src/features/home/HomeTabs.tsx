import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";

export type HomeTab = "meetings" | "home" | "chats";

const TABS: ReadonlyArray<{ tab: HomeTab; icon: AppSymbolName; label: string }> = [
  { tab: "meetings", icon: "waveform", label: "Meetings" },
  { tab: "home", icon: "sparkles", label: "Home" },
  { tab: "chats", icon: "text.bubble", label: "Chats" },
];

/**
 * Three icons in one small floating capsule, about 34 points tall: Meetings,
 * Home and Chats. A dot marks a tab with something waiting — a meeting being
 * recorded, a thread that needs the user.
 */
export function HomeTabs(props: {
  readonly active: HomeTab;
  readonly badges: Partial<Record<HomeTab, "attention" | "live">>;
  readonly onSelect: (tab: HomeTab) => void;
}) {
  return (
    <GlassSurface
      className="flex-row overflow-hidden rounded-full border border-border p-[3px]"
      fallbackClassName="bg-card"
    >
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
            className={
              active
                ? "h-7 w-[42px] items-center justify-center rounded-full bg-foreground"
                : "h-7 w-[42px] items-center justify-center rounded-full"
            }
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
    </GlassSurface>
  );
}
