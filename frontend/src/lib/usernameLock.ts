const LOCK_DAYS = 30;

/** The 30-day username lock: returns when it unlocks, or null if free. */
export function usernameLockUntil(changedAt: string | null, now: Date = new Date()): Date | null {
  if (!changedAt) return null;
  const changed = new Date(changedAt);
  if (Number.isNaN(changed.getTime())) return null;
  const until = new Date(changed.getTime() + LOCK_DAYS * 24 * 60 * 60 * 1000);
  return until.getTime() > now.getTime() ? until : null;
}
