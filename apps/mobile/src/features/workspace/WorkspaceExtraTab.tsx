import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ShelvesHomeScreen } from "../home/ShelvesHomeScreen";
import { MeetingsScreen } from "../meetings/MeetingsScreen";
import { UsageRouteScreen } from "../usage/UsageRouteScreen";

/** The one-page tabs: Home and Meetings under their own page header, Usage under the workspace's. */
export function WorkspaceExtraTab(props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
}) {
  if (props.tab === "usage") {
    return (
      <>
        <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
        <UsageRouteScreen workspace />
      </>
    );
  }
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      {props.tab === "home" ? <ShelvesHomeScreen /> : <MeetingsScreen embedded />}
    </>
  );
}
