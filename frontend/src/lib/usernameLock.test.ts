import { describe, expect, it } from "vitest";

import { usernameLockUntil } from "./usernameLock";

describe("usernameLockUntil", () => {
  const now = new Date("2026-07-23T12:00:00Z");

  it("null when the username was never changed", () => {
    expect(usernameLockUntil(null, now)).toBeNull();
  });

  it("locked inside the 30-day window, with the exact unlock date", () => {
    const until = usernameLockUntil("2026-07-10T12:00:00Z", now);
    expect(until?.toISOString()).toBe("2026-08-09T12:00:00.000Z");
  });

  it("free again after 30 days", () => {
    expect(usernameLockUntil("2026-06-01T00:00:00Z", now)).toBeNull();
  });

  it("garbage input degrades to unlocked, not a crash", () => {
    expect(usernameLockUntil("not-a-date", now)).toBeNull();
  });
});
