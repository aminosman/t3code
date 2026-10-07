import { TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { GrHeader, GrIconButton, RADIUS, SPACE } from "../../design/granola";

/**
 * The Chats page's header inside the home pager — the serif title, new task
 * and settings, and a search field — fixed above the list, which scrolls.
 */
export function ChatsPaneHeader(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onStartNewTask: () => void;
  readonly onOpenSettings: () => void;
}) {
  return (
    <GrHeader
      title="Chats"
      actions={
        <>
          <GrIconButton icon="square.and.pencil" label="New task" onPress={props.onStartNewTask} />
          <GrIconButton icon="ellipsis" label="Open settings" onPress={props.onOpenSettings} />
        </>
      }
      below={
        <View
          className="flex-row items-center border border-gr-hairline bg-gr-raised"
          style={{ borderRadius: RADIUS.card, paddingHorizontal: SPACE.md, gap: SPACE.sm }}
        >
          <SymbolView name="magnifyingglass" size={14} tintColorClassName="accent-gr-ink-3" />
          <TextInput
            accessibilityLabel="Search threads"
            className="flex-1 font-sans text-[16px] text-gr-ink"
            style={{ paddingVertical: SPACE.sm + 2 }}
            placeholder="Search"
            placeholderTextColorClassName="accent-gr-ink-3"
            cursorColorClassName="accent-gr-accent"
            value={props.searchQuery}
            onChangeText={props.onSearchQueryChange}
            returnKeyType="search"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
      }
    />
  );
}
