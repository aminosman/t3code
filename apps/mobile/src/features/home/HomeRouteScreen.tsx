import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { HomePager } from "./HomePager";
import { ChatsRouteScreen } from "./ChatsRouteScreen";

/** A compact window, an iPad's included, gets the pager; a split view lists threads in its sidebar. */
export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  return layout.usesSplitView ? <ChatsRouteScreen /> : <HomePager />;
}
