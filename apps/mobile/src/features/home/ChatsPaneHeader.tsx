import { useAtomSet } from "@effect/atom-react";
import { Menu } from "../../components/ui/Menu";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import {
  useThreadSortOrder,
  THREAD_SORT_PREFERENCE_LABELS,
  type ThreadSortPreference,
} from "../threads/use-thread-sort-order";
import { TextInput, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";

import { FLOAT_SHADOW, GrHeader, GrIconButton, RADIUS, SPACE } from "../../design/granola";
export type ChatsLayout = "recent" | "projects";

/**
 * How Chats is laid out and ordered: one list by recency (with owned threads
 * nested), or grouped by project as the desktop sidebar; and the sort, saved
 * on the device. "My order" (Move up/down) only exists in the flat list.
 */
function ChatsViewMenu(props: {
  readonly layout: ChatsLayout;
  readonly onLayoutChange: (layout: ChatsLayout) => void;
  readonly sortOrder: ThreadSortPreference;
  readonly onSortOrderChange: (order: ThreadSortPreference) => void;
}) {
  const sorts: ReadonlyArray<ThreadSortPreference> =
    props.layout === "recent"
      ? ["updated_at", "created_at", "manual"]
      : ["updated_at", "created_at"];
  const shownSort =
    props.layout === "projects" && props.sortOrder === "manual" ? "updated_at" : props.sortOrder;
  return (
    <Menu
      accessibilityLabel="Sort and layout"
      title="Chats"
      actions={[
        {
          id: "layout",
          title: "Layout",
          displayInline: true,
          subactions: [
            {
              id: "layout:recent",
              title: "Recent",
              state: props.layout === "recent" ? "on" : "off",
            },
            {
              id: "layout:projects",
              title: "By project",
              state: props.layout === "projects" ? "on" : "off",
            },
          ],
        },
        {
          id: "sort",
          title: "Sort",
          displayInline: true,
          subactions: sorts.map((order) => ({
            id: `sort:${order}`,
            title: THREAD_SORT_PREFERENCE_LABELS[order],
            state: shownSort === order ? "on" : "off",
          })),
        },
      ]}
      onPressAction={({ nativeEvent }) => {
        const [kind, value] = nativeEvent.event.split(":");
        if (kind === "layout" && (value === "recent" || value === "projects"))
          props.onLayoutChange(value);
        if (
          kind === "sort" &&
          (value === "updated_at" || value === "created_at" || value === "manual")
        )
          props.onSortOrderChange(value);
      }}
    >
      <View
        className="size-10 items-center justify-center rounded-full border border-gr-hairline bg-gr-raised"
        style={FLOAT_SHADOW}
      >
        <SymbolView
          name="line.3.horizontal.decrease"
          size={17}
          tintColorClassName="accent-gr-ink"
        />
      </View>
    </Menu>
  );
}

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
  const flat = useThreadListV2Enabled();
  const save = useAtomSet(updateMobilePreferencesAtom);
  const [sortOrder, setSortOrder] = useThreadSortOrder();
  return (
    <GrHeader
      title="Chats"
      actions={
        <>
          <ChatsViewMenu
            layout={flat ? "recent" : "projects"}
            onLayoutChange={(layout) => save({ legacyThreadListEnabled: layout === "projects" })}
            sortOrder={sortOrder}
            onSortOrderChange={setSortOrder}
          />

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
