/**
 * View batching. Deck deals and detail-modal opens collect item ids; the
 * batch is POSTed debounced. People swipe five cards and close the tab, so
 * a timer alone would drop most real views — visibilitychange → hidden
 * flushes immediately with fetch keepalive (it can carry the bearer
 * header, which sendBeacon cannot — an owner's beacon would otherwise be
 * counted as an anonymous view of their own items).
 */

import { api, API_URL, getAccessToken } from "../api/client";

const DEBOUNCE_MS = 1500;

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function recordView(itemId: string): void {
  pending.add(itemId);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => void flushViews(), DEBOUNCE_MS);
}

export async function flushViews(options: { keepalive?: boolean } = {}): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return;
  const item_ids = [...pending];
  pending.clear();
  const body = JSON.stringify({ item_ids });

  if (options.keepalive) {
    // The page may be dying: no awaiting a token refresh here. If the
    // token just expired, this batch is lost — it's a view counter.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getAccessToken();
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    try {
      void fetch(`${API_URL}/items/views`, {
        method: "POST",
        body,
        headers,
        credentials: "include",
        keepalive: true,
      });
    } catch {
      // lost — acceptable for a toy counter
    }
    return;
  }

  try {
    await api("/items/views", { method: "POST", body });
  } catch {
    // view loss is acceptable; never bother the user about it
  }
}

/** Bind once per profile visit; returns the unbind function. */
export function bindViewFlushOnHide(): () => void {
  const onHide = () => {
    if (document.visibilityState === "hidden") void flushViews({ keepalive: true });
  };
  const onPageHide = () => void flushViews({ keepalive: true });
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);
  return () => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onPageHide);
  };
}
