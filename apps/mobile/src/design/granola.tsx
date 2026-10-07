import type { ReactNode } from "react";
import { Platform, Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScopedVariables } from "uniwind";

import { SymbolView, type AppSymbolName } from "../components/AppSymbol";
import { AppText as Text } from "../components/AppText";
import { cn } from "../lib/cn";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/*
 * The phone's design system, taken from Granola (see README.md beside this
 * file). Every page of the home pager and the meeting pages is built from
 * these parts and numbers, and nothing else: one page margin, one spacing
 * grid, three radii, two typefaces.
 */

/* ─── Scales ──────────────────────────────────────────────────────────── */

/** The page margin: headers, section labels, the first card of a row, inputs. */
export const GUTTER = 20;

/** The 4-point grid. */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const RADIUS = {
  /** Tiles, small controls. */
  control: 8,
  /** Cards and every input surface (the composer, the ask box, search). */
  card: 12,
  /** Large panels: the recording bar, sheets. */
  panel: 16,
} as const;

/** Titles are serif; everything else is the app's sans. */
export const SERIF = Platform.select({ ios: "ui-serif", default: "serif" });

/** Granola's floating shadow (its "mt-float"), for things that sit over the page. */
export const FLOAT_SHADOW: ViewStyle = {
  shadowColor: "#000000",
  shadowOpacity: 0.07,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
  elevation: 3,
};

/** Granola's pastel tiles, picked from a name so a thread or meeting keeps its colour. */
const TILE_COLORS = ["#FBEFB8", "#E4E4DE", "#F8DDF0", "#D9ECF7", "#E2F0C9", "#F6E1CF"];
export function tileColor(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return TILE_COLORS[Math.abs(hash) % TILE_COLORS.length]!;
}

/* ─── Page ────────────────────────────────────────────────────────────── */

/**
 * A page: its header stays put and only the body scrolls. The body is the
 * page's own scroll view or list, filling the rest.
 */
export function GrPage(props: { readonly header: ReactNode; readonly children: ReactNode }) {
  return (
    <View className="flex-1 bg-gr-surface">
      {props.header}
      <View className="flex-1">{props.children}</View>
    </View>
  );
}

/**
 * A page header: an optional eyebrow, the serif title, actions on the right,
 * and an optional row below (a search field).
 */
export function GrHeader(props: {
  readonly eyebrow?: ReactNode;
  readonly title: string;
  readonly actions?: ReactNode;
  readonly below?: ReactNode;
  readonly note?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="bg-gr-surface"
      style={{
        paddingTop: insets.top + SPACE.sm,
        paddingHorizontal: GUTTER,
        paddingBottom: SPACE.md,
      }}
    >
      <View className="flex-row items-end gap-3">
        <View className="flex-1">
          {props.eyebrow ? (
            <Text className="text-[13px] leading-[18px] text-gr-ink-2">{props.eyebrow}</Text>
          ) : null}
          <Text
            className="text-[30px] leading-[36px] text-gr-ink"
            style={{ fontFamily: SERIF, letterSpacing: -0.3 }}
            numberOfLines={1}
          >
            {props.title}
          </Text>
        </View>
        {props.actions ? <View className="flex-row gap-2 pb-0.5">{props.actions}</View> : null}
      </View>
      {props.note ? <View style={{ marginTop: SPACE.xs }}>{props.note}</View> : null}
      {props.below ? <View style={{ marginTop: SPACE.md }}>{props.below}</View> : null}
    </View>
  );
}

/** A round 40-point button on a raised white face, as Granola's top bar. */
export function GrIconButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      hitSlop={6}
      className="size-10 items-center justify-center rounded-full border border-gr-hairline bg-gr-raised active:bg-gr-sunken"
      style={FLOAT_SHADOW}
    >
      <SymbolView name={props.icon} size={17} tintColorClassName="accent-gr-ink" />
    </Pressable>
  );
}

/* ─── Sections, cards, chips, buttons ─────────────────────────────────── */

/** "Coming up": sentence case, secondary, with a count and an action. */
export function GrSectionLabel(props: {
  readonly title: string;
  readonly count?: number;
  readonly leading?: ReactNode;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <View
      className="flex-row items-center gap-1.5"
      style={{ paddingHorizontal: GUTTER, paddingTop: SPACE.xl, paddingBottom: SPACE.sm }}
    >
      {props.leading}
      <Text className="font-t3-medium text-[14px] leading-[18px] text-gr-ink-2">{props.title}</Text>
      {props.count !== undefined ? (
        <Text className="text-[14px] leading-[18px] text-gr-ink-3">{props.count}</Text>
      ) : null}
      <View className="flex-1" />
      {props.action ? (
        <Pressable onPress={props.action.onPress} hitSlop={10} accessibilityRole="button">
          <Text className="text-[13px] text-gr-ink-3">{props.action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A white card with a warm hairline and the card radius. */
export function GrCard(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
}) {
  const className = cn("border border-gr-hairline bg-gr-raised", props.className);
  const style = [{ borderRadius: RADIUS.card }, props.style];
  return props.onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className={cn(className, "active:bg-gr-sunken")}
      style={style}
    >
      {props.children}
    </Pressable>
  ) : (
    <View className={className} style={style}>
      {props.children}
    </View>
  );
}

/** An outline capsule, 32 points tall: dates, people, kinds. */
export function GrChip(props: { readonly icon?: AppSymbolName; readonly children: string }) {
  return (
    <View className="h-8 flex-row items-center gap-1.5 rounded-full border border-gr-hairline px-3">
      {props.icon ? (
        <SymbolView name={props.icon} size={13} tintColorClassName="accent-gr-ink-2" />
      ) : null}
      <Text className="text-[13px] text-gr-ink-2-strong">{props.children}</Text>
    </View>
  );
}

/** A capsule button: primary is ink on ink (Granola's black "Start now"), secondary is outline. */
export function GrButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly kind?: "primary" | "secondary";
  readonly leading?: ReactNode;
  readonly disabled?: boolean;
  readonly grow?: boolean;
}) {
  const primary = props.kind !== "secondary";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      disabled={props.disabled}
      className={cn(
        "h-10 flex-row items-center justify-center gap-2 rounded-full px-4",
        primary ? "bg-gr-button" : "border border-gr-hairline bg-gr-raised",
        props.grow ? "flex-1" : null,
      )}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.leading}
      <Text
        className={cn("font-t3-medium text-[14px]", primary ? "text-gr-button-ink" : "text-gr-ink")}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A segmented control: the selected segment white on a sunken track. */
export function GrSegments<K extends string>(props: {
  readonly value: K;
  readonly options: ReadonlyArray<{ readonly key: K; readonly label: string }>;
  readonly onChange: (key: K) => void;
}) {
  return (
    <View className="flex-row self-start rounded-full bg-gr-sunken p-[3px]">
      {props.options.map((option) => {
        const selected = option.key === props.value;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(option.key)}
            className={cn(
              "h-8 justify-center rounded-full px-3.5",
              selected ? "bg-gr-raised" : null,
            )}
          >
            <Text
              className={cn(
                "text-[13px]",
                selected ? "font-t3-medium text-gr-ink" : "text-gr-ink-2",
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The surface every input sits on — the home composer, the ask box: a raised
 * card with the card radius, floating over the page.
 */
export function GrInputSurface(props: { readonly children: ReactNode }) {
  return (
    <View
      className="overflow-hidden border border-gr-hairline bg-gr-raised"
      style={[{ borderRadius: RADIUS.card, marginHorizontal: GUTTER }, FLOAT_SHADOW]}
    >
      {props.children}
    </View>
  );
}

/** A pastel tile with a serif initial: 28 points, the control radius. */
export function GrTile(props: {
  readonly name: string;
  readonly colorKey?: string;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  return (
    <View
      className="items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size >= 28 ? RADIUS.control : 6,
        backgroundColor: tileColor(props.colorKey ?? props.name),
      }}
    >
      <Text
        className="text-gr-tile-ink"
        style={{ fontFamily: SERIF, fontSize: Math.round(size * 0.55) }}
      >
        {props.name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * Draws screens built from the app's own parts (the thread list) on
 * Granola's page colour, by pointing the app's surface tokens at it inside
 * this subtree — so the Chats page matches the pages beside it without
 * forking the list.
 */
export function GrSurfaceScope(props: { readonly children: ReactNode }) {
  const { themeAppearance } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  return (
    <ScopedVariables
      variables={{
        "--color-screen": dark ? "#292929" : "#f7f7f2",
        "--color-header": dark ? "#292929" : "#f7f7f2",
        "--color-row-hover": dark ? "rgb(255 255 255 / 6%)" : "rgb(98 90 34 / 7%)",
      }}
    >
      {props.children}
    </ScopedVariables>
  );
}
