import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export type ThreadSortPreference = "updated_at" | "created_at" | "manual";

export const THREAD_SORT_PREFERENCE_LABELS: Record<ThreadSortPreference, string> = {
  updated_at: "Recent activity",
  created_at: "Newest first",
  manual: "My order",
};

/**
 * How Chats orders threads, saved on the device. Defaults to the latest user
 * message first — the desktop sidebar's default and how a messages app reads.
 */
export function useThreadSortOrder(): readonly [
  ThreadSortPreference,
  (order: ThreadSortPreference) => void,
] {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const order = AsyncResult.isSuccess(preferences)
    ? (preferences.value.threadSortOrder ?? "updated_at")
    : "updated_at";
  return [order, (next) => save({ threadSortOrder: next })] as const;
}

/** The same choice in the grouped list's terms, which has no hand order. */
export function groupedThreadSortOrder(order: ThreadSortPreference): "updated_at" | "created_at" {
  return order === "created_at" ? "created_at" : "updated_at";
}
