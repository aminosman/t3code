import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { GUTTER, GrTile, SPACE } from "../../design/granola";

/** A day label above its meetings: Granola's 13-point strong secondary. */
export function MeetingDayLabel(props: { readonly children: string }) {
  return (
    <Text
      className="font-t3-medium text-[13px] text-gr-ink-2-strong"
      style={{ paddingHorizontal: GUTTER, paddingTop: SPACE.xl, paddingBottom: SPACE.xs }}
    >
      {props.children}
    </Text>
  );
}

/** A meeting row: tile, title, then time · length · people. No dividers; 52-point pitch. */
export function MeetingRowView(props: {
  readonly title: string;
  readonly details: string;
  readonly status?: { readonly text: string; readonly tone: "live" | "attention" | "quiet" };
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="flex-row items-center gap-3 active:bg-gr-hover"
      style={{ paddingHorizontal: GUTTER, paddingVertical: SPACE.sm }}
    >
      <GrTile name={props.title} />
      <View className="flex-1">
        <Text className="text-[15px] leading-[20px] text-gr-ink" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-[12px] leading-[16px] text-gr-ink-2" numberOfLines={1}>
          {props.details}
          {props.status ? (
            <Text
              className={
                props.status.tone === "live"
                  ? "text-[12px] text-gr-danger"
                  : props.status.tone === "attention"
                    ? "text-[12px] text-gr-attention"
                    : "text-[12px] text-gr-ink-2"
              }
            >
              {` · ${props.status.text}`}
            </Text>
          ) : null}
        </Text>
      </View>
    </Pressable>
  );
}
