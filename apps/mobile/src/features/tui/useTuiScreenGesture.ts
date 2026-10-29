import type { TuiScreenInput } from "@t3tools/contracts";
import { useCallback, useRef } from "react";
import {
  useTapGesture,
  useLongPressGesture,
  usePanGesture,
  useCompetingGestures,
  useExclusiveGestures,
} from "react-native-gesture-handler";

const POINTS_PER_LINE = 12;
type Picture = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export function useTuiScreenGesture(
  picture: Picture | null,
  act: (input: TuiScreenInput) => Promise<void>,
) {
  const fraction = useCallback(
    (x: number, y: number) => {
      const p = picture;
      if (!p) return null;
      const fx = (x - p.x) / p.width;
      const fy = (y - p.y) / p.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
      return { x: fx, y: fy };
    },
    [picture],
  );

  const scrollState = useRef({
    scrolled: { x: 0, y: 0 },
    origin: null as { x: number; y: number } | null,
  });
  const tap = useTapGesture({
    numberOfTaps: 1,
    maxDuration: 300,
    runOnJS: true,
    onDeactivate: (event) => {
      if (event.canceled) return;
      const at = fraction(event.x, event.y);
      if (at) void act({ type: "click", ...at });
    },
  });
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    runOnJS: true,
    onDeactivate: (event) => {
      if (event.canceled) return;
      const at = fraction(event.x, event.y);
      if (at) void act({ type: "click", ...at, count: 2 });
    },
  });
  const hold = useLongPressGesture({
    minDuration: 450,
    runOnJS: true,
    onActivate: (event) => {
      const at = fraction(event.x, event.y);
      if (at) void act({ type: "click", ...at, button: "right" });
    },
  });
  const pan = usePanGesture({
    minDistance: 10,
    runOnJS: true,
    onActivate: (event) => {
      scrollState.current = { scrolled: { x: 0, y: 0 }, origin: fraction(event.x, event.y) };
    },
    onUpdate: (event) => {
      const { origin, scrolled } = scrollState.current;
      if (!origin) return;
      // Finger movement pulls the page; send only whole lines since the last update.
      const dx = Math.trunc(-event.translationX / POINTS_PER_LINE) - scrolled.x;
      const dy = Math.trunc(-event.translationY / POINTS_PER_LINE) - scrolled.y;
      if (dx === 0 && dy === 0) return;
      scrollState.current.scrolled = { x: scrolled.x + dx, y: scrolled.y + dy };
      void act({ type: "scroll", ...origin, dx, dy });
    },
  });
  const competing = useCompetingGestures(pan, hold, tap);
  const gesture = useExclusiveGestures(doubleTap, competing);

  return gesture;
}
