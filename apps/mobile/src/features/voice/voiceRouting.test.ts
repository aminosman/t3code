import { describe, expect, it } from "vite-plus/test";

import { isHeadphoneRouteChange } from "./voiceRouting";

describe("voice route changes", () => {
  it("reacts only to hardware arrivals and removals, not category or speaker overrides", () => {
    expect(isHeadphoneRouteChange(1)).toBe(true);
    expect(isHeadphoneRouteChange(2)).toBe(true);
    expect(isHeadphoneRouteChange(3)).toBe(false);
    expect(isHeadphoneRouteChange(4)).toBe(false);
    expect(isHeadphoneRouteChange(undefined)).toBe(false);
  });
});
