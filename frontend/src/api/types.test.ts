import { describe, expect, it } from "vitest";

import { formatPrice, parseProfile } from "./types";

const rawItem = {
  id: "i1",
  title: "Camera",
  image_url: "https://x/1.webp",
  accent_color: "#AABBCC",
  link: null,
  price: "1200.00",
  currency: "UAH",
  note: null,
  order_index: 0,
};

const base = {
  username: "bo",
  display_name: null,
  bio: null,
  avatar_url: null,
};

describe("parseProfile — the three-way §4.1 split, encoded in types", () => {
  it("anonymous items carry NO reservation properties at all", () => {
    const profile = parseProfile(
      { ...base, is_owner: false, items: [rawItem] },
      false, // not authenticated
    );
    expect(profile.view).toBe("anonymous");
    const item = profile.items[0];
    expect(item.view).toBe("anonymous");
    expect("is_reserved" in item).toBe(false);
    expect("reserved_by_me" in item).toBe(false);
    expect("view_count" in item).toBe(false);
  });

  it("guest items carry reservation state, never view_count", () => {
    const profile = parseProfile(
      { ...base, is_owner: false, items: [{ ...rawItem, is_reserved: true, reserved_by_me: false }] },
      true,
    );
    expect(profile.view).toBe("guest");
    if (profile.view !== "guest") throw new Error("unreachable");
    expect(profile.items[0].is_reserved).toBe(true);
    expect("view_count" in profile.items[0]).toBe(false);
  });

  it("owner items carry view_count, never reservation state", () => {
    const profile = parseProfile(
      { ...base, is_owner: true, items: [{ ...rawItem, view_count: 7 }] },
      true,
    );
    expect(profile.view).toBe("owner");
    if (profile.view !== "owner") throw new Error("unreachable");
    expect(profile.items[0].view_count).toBe(7);
    expect("is_reserved" in profile.items[0]).toBe(false);
  });

  it("normalizes price to a string whichever way the server serializes it", () => {
    const asNumber = parseProfile(
      { ...base, is_owner: false, items: [{ ...rawItem, price: 99.5 }] },
      false,
    );
    expect(asNumber.items[0].price).toBe("99.5");
  });
});

describe("formatPrice", () => {
  it("drops trailing .00 and appends the currency", () => {
    expect(formatPrice("1200.00", "UAH")).toBe("1200 UAH");
    expect(formatPrice("99.50", "EUR")).toBe("99.50 EUR");
    expect(formatPrice(null, null)).toBeNull();
  });
});
