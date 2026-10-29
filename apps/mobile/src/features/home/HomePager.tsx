import { useEffect, useEffectEvent, useState } from "react";
import { Keyboard, Platform, useWindowDimensions, View } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { MeetingsScreen } from "../meetings/MeetingsScreen";
import { usePhoneMeetingSync } from "../meetings/phone-meeting-sync";
import { ChatsRouteScreen } from "./ChatsRouteScreen";
import { HOME_TABS, HomeTabs, tabsBottom, type HomeTab } from "./HomeTabs";
import { ShelvesHomeScreen, useHomeData } from "./ShelvesHomeScreen";

const HOME_INDEX = HOME_TABS.indexOf("home");

/**
 * The phone's home: three pages side by side — Meetings, Home, Chats — that
 * the finger drags between, under one floating capsule whose highlight
 * follows the drag. It opens on Home. A row of cards on Home scrolls on its
 * own; the pages move when the swipe starts anywhere else.
 */
export function HomePager(props: { readonly page?: HomeTab }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const data = useHomeData();
  // Phone recordings go to the Mac by themselves whenever it is reachable.
  usePhoneMeetingSync();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const [initialPage] = useState(() => (props.page ? HOME_TABS.indexOf(props.page) : HOME_INDEX));
  const position = useSharedValue(initialPage);
  const [page, setPage] = useState(initialPage);
  const [previousRequest, setPreviousRequest] = useState(props.page);
  if (previousRequest !== props.page) {
    setPreviousRequest(props.page);
    if (props.page) setPage(HOME_TABS.indexOf(props.page));
  }
  const [composing, setComposing] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const resizePage = useEffectEvent((nextWidth: number) => {
    scrollRef.current?.scrollTo({ x: page * nextWidth, animated: false });
  });
  const scrollToRequestedPage = useEffectEvent((requested: HomeTab | undefined) => {
    if (requested)
      scrollRef.current?.scrollTo({ x: HOME_TABS.indexOf(requested) * width, animated: true });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to the native keyboard so the dock avoids it.
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardUp(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardUp(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Keep the current page in view when the width changes (rotation, split).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the native scroll view on its page when the window resizes.
  useEffect(() => {
    resizePage(width);
  }, [width]);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      position.set(event.contentOffset.x / Math.max(1, event.layoutMeasurement.width));
    },
    onMomentumEnd: (event) => {
      const index = Math.round(event.contentOffset.x / Math.max(1, event.layoutMeasurement.width));
      runOnJS(setPage)(index);
    },
  });

  const show = (tab: HomeTab) => {
    const index = HOME_TABS.indexOf(tab);
    Keyboard.dismiss();
    setPage(index);
    scrollRef.current?.scrollTo({ x: index * width, animated: true });
  };

  // A link that names a page (t3code://?page=chats) moves there.
  const requestedPage = props.page;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Move the native scroll view when navigation requests a page.
  useEffect(() => {
    scrollToRequestedPage(requestedPage);
  }, [requestedPage]);

  return (
    <View className="flex-1 bg-gr-surface">
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <Animated.ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        bounces={false}
        directionalLockEnabled
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentOffset={{ x: initialPage * width, y: 0 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
      >
        <View style={{ width }}>
          <MeetingsScreen embedded />
        </View>
        <View style={{ width }}>
          <ShelvesHomeScreen data={data} onShowPage={show} onComposingChange={setComposing} />
        </View>
        <View style={{ width }}>
          <ChatsRouteScreen embedded />
        </View>
      </Animated.ScrollView>

      {composing || keyboardUp ? null : (
        <View
          pointerEvents="box-none"
          className="absolute right-0 left-0 items-center"
          style={{ bottom: tabsBottom(insets.bottom) }}
        >
          <HomeTabs
            position={position}
            active={HOME_TABS[page] ?? "home"}
            badges={{
              ...(data.liveMeeting ? { meetings: "live" as const } : {}),
              ...(data.needsYou ? { chats: "attention" as const } : {}),
            }}
            onSelect={show}
          />
        </View>
      )}
    </View>
  );
}
