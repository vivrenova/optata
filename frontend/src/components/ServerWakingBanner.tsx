import { useEffect, useState } from "react";

import { subscribeSlowRequests } from "../api/client";

/**
 * Render's free tier cold-starts in ~50 seconds. Any request past 3s flips
 * this on — an honest banner instead of a spinner that looks broken.
 */
export function ServerWakingBanner() {
  const [slow, setSlow] = useState(false);

  useEffect(() => subscribeSlowRequests(setSlow), []);

  if (!slow) return null;

  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <div className="flex items-center gap-2.5 rounded-tag border-2 border-ink bg-paper px-4 py-2.5 text-sm shadow-tag">
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 rounded-full border-2 border-ink border-r-transparent motion-safe:animate-spin"
        />
        Waking the server up… free hosting can take up to a minute.
      </div>
    </div>
  );
}
