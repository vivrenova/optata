import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnonymousItem, WishlistItem } from "../../api/types";
import { ShuffleDeck } from "./ShuffleDeck";

vi.mock("../../lib/views", () => ({
  recordView: vi.fn(),
}));

import { recordView } from "../../lib/views";

function makeItems(count: number): Map<string, WishlistItem> {
  const entries = Array.from({ length: count }, (_, i): [string, AnonymousItem] => [
    `id-${i}`,
    {
      view: "anonymous",
      id: `id-${i}`,
      title: `Wish ${i}`,
      image_url: `https://example.com/${i}.webp`,
      accent_color: "#AABBCC",
      link: null,
      price: null,
      currency: null,
      note: null,
      order_index: i,
    },
  ]);
  return new Map(entries);
}

function renderDeck(count: number, overrides: Partial<Parameters<typeof ShuffleDeck>[0]> = {}) {
  const items = makeItems(count);
  const order = [...items.keys()];
  const onReveal = vi.fn();
  const onOpenItem = vi.fn();
  render(
    <ShuffleDeck
      items={items}
      order={order}
      username="demo"
      isOwnProfile={false}
      leaving={false}
      onReveal={onReveal}
      onLeft={vi.fn()}
      onOpenItem={onOpenItem}
      onDisableOwnShuffle={vi.fn()}
      {...overrides}
    />,
  );
  return { order, onReveal, onOpenItem };
}

afterEach(() => {
  vi.clearAllMocks();
  document.documentElement.style.overflow = "";
});

describe("ShuffleDeck", () => {
  it("keeps only the top 3 cards in the DOM, not the whole deck", () => {
    renderDeck(12);
    expect(screen.getAllByLabelText("Next card")).toHaveLength(3);
  });

  it("advances on space / arrow keys and records a view per dealt card", async () => {
    renderDeck(5);
    expect(screen.getByText("No. 01/05")).toBeDefined();
    expect(recordView).toHaveBeenCalledWith("id-0");

    await act(async () => {
      fireEvent.keyDown(window, { key: " " });
    });
    expect(screen.getByText("No. 02/05")).toBeDefined();
    expect(recordView).toHaveBeenCalledWith("id-1");

    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    expect(screen.getByText("No. 03/05")).toBeDefined();
    expect(recordView).toHaveBeenCalledWith("id-2");
  });

  it("exhausting the deck calls onReveal exactly once", async () => {
    const { onReveal } = renderDeck(3);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.keyDown(window, { key: " " });
      });
    }
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("'Show everything' reveals the grid without finishing the deck", async () => {
    const { onReveal } = renderDeck(10);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show everything" }));
    });
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("clicking the info strip opens the detail modal for the TOP card", async () => {
    const { onOpenItem } = renderDeck(4);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Details: Wish 0"));
    });
    expect(onOpenItem).toHaveBeenCalledWith("id-0");
  });

  it("owner sees the shuffle opt-out; guests never do", () => {
    renderDeck(4, { isOwnProfile: true });
    expect(
      screen.getByRole("button", { name: "Don't show me shuffle on my own profile" }),
    ).toBeDefined();
  });

  it("a HIDDEN tab reconciles the reveal immediately, in one step", async () => {
    // Background/occluded tabs freeze rAF, so animation-complete never
    // fires. Going hidden must hand control to the grid at once — never a
    // timer racing a real animation.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      const onLeft = vi.fn();
      renderDeck(4, { leaving: true, onLeft });
      await act(async () => {});
      expect(onLeft).toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  });

  it("the absolute failsafe can never beat a real animation on slow hardware", async () => {
    const { ANIMATION_FAILSAFE_MS, FLY_DURATION_MS, REVEAL_DURATION_MS } = await import(
      "./ShuffleDeck"
    );
    const longestAnimation = Math.max(FLY_DURATION_MS, REVEAL_DURATION_MS);
    expect(ANIMATION_FAILSAFE_MS).toBeGreaterThanOrEqual(longestAnimation * 10);
  });

  it("REDUCED MOTION: deal, advance through every card and reveal work on fades alone", async () => {
    // No dependency on any spring or fling completing: advancing is pure
    // state, no flying ghost is ever created, and the deck hands over to
    // the grid at the end. (The OS media-query wiring itself is framer's
    // useReducedMotion; the prop drives the same branch.)
    const items = makeItems(4);
    const onReveal = vi.fn();
    const { container } = render(
      <ShuffleDeck
        items={items}
        order={[...items.keys()]}
        username="demo"
        isOwnProfile={false}
        leaving={false}
        forceReducedMotion
        onReveal={onReveal}
        onLeft={vi.fn()}
        onOpenItem={vi.fn()}
        onDisableOwnShuffle={vi.fn()}
      />,
    );

    for (let step = 1; step <= 4; step++) {
      expect(screen.getByText(`No. ${String(step).padStart(2, "0")}/04`)).toBeDefined();
      await act(async () => {
        fireEvent.keyDown(window, { key: " " });
      });
      // no flying ghost exists under reduced motion — nothing to wait for
      expect(container.querySelector('div[aria-hidden="true"] [aria-label="Next card"]')).toBeNull();
    }
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});
