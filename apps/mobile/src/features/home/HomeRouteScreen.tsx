import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";

import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";
import { ChatsRouteScreen } from "./ChatsRouteScreen";
import { HomePager } from "./HomePager";
import { HOME_TABS, type HomeTab } from "./HomeTabs";

/* ─── Route screen ───────────────────────────────────────────────────── */

/**
 * Home: on a phone, the pager of Meetings, Home (the shelves) and Chats. In
 * split layouts the persistent sidebar is the thread list, so Home stays the
 * thread list's empty detail pane there.
 */
type HomeRouteScreenProps = StaticScreenProps<{ readonly page?: string } | undefined>;

export function HomeRouteScreen({ route }: HomeRouteScreenProps) {
  // A link may open a page of the pager: t3code://?page=chats.
  const requested = route.params?.page;
  const page = HOME_TABS.find((tab): tab is HomeTab => tab === requested);
  const { layout } = useAdaptiveWorkspaceLayout();
  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);
  return layout.usesSplitView ? <ChatsRouteScreen /> : <HomePager page={page} />;
}
