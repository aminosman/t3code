import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native-gesture-handler", () => ({
  useTapGesture: (config: unknown) => config,
  useLongPressGesture: (config: unknown) => config,
  usePanGesture: (config: unknown) => config,
  useCompetingGestures: (...gestures: unknown[]) => gestures,
  useExclusiveGestures: (...gestures: unknown[]) => gestures,
}));

import { useTuiScreenGesture } from "./useTuiScreenGesture";

type Point = {
  x: number;
  y: number;
  canceled?: boolean;
  translationX?: number;
  translationY?: number;
};
type Gesture = {
  onActivate: (event: Point) => void;
  onUpdate: (event: Point) => void;
  onDeactivate: (event: Point) => void;
};

it("maps taps through letterboxing and keeps drag increments across frame updates", async () => {
  const send = vi.fn(async (_input: unknown) => {});
  let gestures: ReturnType<typeof useTuiScreenGesture>;
  function Probe({ width }: { width: number }) {
    const result = useTuiScreenGesture({ x: 10, y: 20, width, height: 100 }, send);
    useLayoutEffect(() => {
      gestures = result;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe width={200} />));
    const [double, [pan, hold, tap]] = gestures! as unknown as [
      Gesture,
      [Gesture, Gesture, Gesture],
    ];
    tap.onDeactivate({ x: 5, y: 25 });
    tap.onDeactivate({ x: 110, y: 70, canceled: true });
    expect(send).not.toHaveBeenCalled();
    tap.onDeactivate({ x: 110, y: 70 });
    double.onDeactivate({ x: 110, y: 70 });
    hold.onActivate({ x: 110, y: 70 });
    expect(send.mock.calls).toEqual([
      [{ type: "click", x: 0.5, y: 0.5 }],
      [{ type: "click", x: 0.5, y: 0.5, count: 2 }],
      [{ type: "click", x: 0.5, y: 0.5, button: "right" }],
    ]);
    pan.onActivate({ x: 110, y: 70 });
    pan.onUpdate({ x: 110, y: 70, translationX: 0, translationY: 13 });
    await act(async () => root.render(<Probe width={400} />));
    const [, [nextPan, , nextTap]] = gestures! as unknown as [Gesture, [Gesture, Gesture, Gesture]];
    nextPan.onUpdate({ x: 110, y: 70, translationX: 0, translationY: 25 });
    expect(send.mock.calls.slice(-2)).toEqual([
      [{ type: "scroll", x: 0.5, y: 0.5, dx: -0, dy: -1 }],
      [{ type: "scroll", x: 0.5, y: 0.5, dx: -0, dy: -1 }],
    ]);
    nextTap.onDeactivate({ x: 110, y: 70 });
    expect(send).toHaveBeenLastCalledWith({ type: "click", x: 0.25, y: 0.5 });
  } finally {
    act(() => root.unmount());
  }
});
