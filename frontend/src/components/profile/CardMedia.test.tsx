import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AnonymousItem, GuestItem, OwnerItem } from "../../api/types";
import { CardMedia } from "./CardMedia";
import { DeckCard } from "./DeckCard";

const core = {
  id: "i1",
  title: "Camera",
  image_url: "https://example.com/x.webp",
  accent_color: "#AABBCC",
  link: null,
  price: "1200.00",
  currency: "UAH",
  note: null,
  order_index: 0,
};

const guestReserved: GuestItem = { ...core, view: "guest", is_reserved: true, reserved_by_me: false };
const guestMine: GuestItem = { ...core, view: "guest", is_reserved: true, reserved_by_me: true };
const guestFree: GuestItem = { ...core, view: "guest", is_reserved: false, reserved_by_me: false };
const anonymous: AnonymousItem = { ...core, view: "anonymous" };
const owner: OwnerItem = { ...core, view: "owner", view_count: 7 };

/** Any wording that would betray a reservation. Kept as one pattern so the
 * §4.1 checks can't drift apart from the copy. */
const RESERVATION_LANGUAGE = /spoken for|yours to give|gifted|gifting|reserved/i;

describe("reservation badges follow the §4.1 three-way split", () => {
  it("guest + reserved by someone → hatch label, no name ever", () => {
    render(<CardMedia item={guestReserved} fit="natural" />);
    expect(screen.getByText("Already spoken for")).toBeDefined();
  });

  it("guest + reserved by me → 'Yours to give'", () => {
    render(<CardMedia item={guestMine} fit="natural" />);
    expect(screen.getByText("Yours to give")).toBeDefined();
  });

  it("guest + free → no overlay at all", () => {
    render(<CardMedia item={guestFree} fit="natural" />);
    expect(screen.queryByText(RESERVATION_LANGUAGE)).toBeNull();
  });

  it("ANONYMOUS → no reservation state exists, so nothing can render", () => {
    render(<CardMedia item={anonymous} fit="natural" />);
    expect(screen.queryByText(RESERVATION_LANGUAGE)).toBeNull();
  });

  it("OWNER card → view counter in mono, zero reservation language", () => {
    render(
      <DeckCard item={owner} position={0} total={5} dragging={false} />,
    );
    expect(screen.getByText("7 views")).toBeDefined();
    expect(screen.queryByText(RESERVATION_LANGUAGE)).toBeNull();
  });
});
