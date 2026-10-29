import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useDeviceType } from "../../native/native-layout-metrics";
import { HomePager } from "./HomePager";
import { ChatsRouteScreen } from "./ChatsRouteScreen";

export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const deviceType = useDeviceType();
  return deviceType === "phone" && !layout.usesSplitView ? <HomePager /> : <ChatsRouteScreen />;
}
