import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

/**
 * The Chats page's own header inside the home pager — a large title, the new
 * thread button and a search field — since the pager's pages share one
 * screen and the native navigation bar stays hidden on it.
 */
export function ChatsPaneHeader(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onStartNewTask: () => void;
  readonly onOpenSettings: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="bg-screen px-4 pb-2" style={{ paddingTop: insets.top + 6 }}>
      <View className="flex-row items-end justify-between px-1">
        <Text className="font-t3-bold text-[30px] leading-[36px] tracking-[-0.5px]">Chats</Text>
        <View className="flex-row gap-2 pb-0.5">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New task"
            onPress={props.onStartNewTask}
            className="size-9 items-center justify-center rounded-full bg-subtle"
          >
            <SymbolView name="square.and.pencil" size={16} tintColorClassName="accent-icon" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open settings"
            onPress={props.onOpenSettings}
            className="size-9 items-center justify-center rounded-full bg-subtle"
          >
            <SymbolView name="ellipsis.circle" size={17} tintColorClassName="accent-icon" />
          </Pressable>
        </View>
      </View>
      <View className="mt-2 flex-row items-center gap-2 rounded-xl bg-subtle px-3">
        <SymbolView name="magnifyingglass" size={14} tintColorClassName="accent-icon-muted" />
        <TextInput
          accessibilityLabel="Search threads"
          className="flex-1 py-2 font-sans text-base text-foreground"
          placeholder="Search"
          placeholderTextColorClassName="accent-placeholder"
          cursorColorClassName="accent-focus"
          value={props.searchQuery}
          onChangeText={props.onSearchQueryChange}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>
    </View>
  );
}
