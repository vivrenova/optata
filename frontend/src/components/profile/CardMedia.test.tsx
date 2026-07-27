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

describe("reservation badges follow the §4.1 three-way split", () => {
  it("guest + reserved by someone → hatch label, no name ever", () => {
    render(<CardMedia item={guestReserved} fit="natural" />);
    expect(screen.getByText("Already being gifted")).toBeDefined();
  });

  it("guest + reserved by me → 'You're gifting this'", () => {
    render(<CardMedia item={guestMine} fit="natural" />);
    expect(screen.getByText("You're gifting this")).toBeDefined();
  });

  it("guest + free → no overlay at all", () => {
    render(<CardMedia item={guestFree} fit="natural" />);
    expect(screen.queryByText(/gifted|gifting/)).toBeNull();
  });

  it("ANONYMOUS → no reservation state exists, so nothing can render", () => {
    render(<CardMedia item={anonymous} fit="natural" />);
    expect(screen.queryByText(/gifted|gifting/)).toBeNull();
  });

  it("OWNER card → view counter in mono, zero reservation language", () => {
    render(
      <DeckCard item={owner} position={0} total={5} dragging={false} />,
    );
    expect(screen.getByText("7 views")).toBeDefined();
    expect(screen.queryByText(/gifted|gifting|reserved/i)).toBeNull();
  });
});
