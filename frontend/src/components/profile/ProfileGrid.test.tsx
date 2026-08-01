import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnonymousItem } from "../../api/types";
import { ProfileGrid, balanceColumns } from "./ProfileGrid";

function items(count: number): AnonymousItem[] {
  return Array.from({ length: count }, (_, i) => ({
    view: "anonymous" as const,
    id: `i${i}`,
    title: `Item ${i}`,
    image_url: `https://example.com/${i}.webp`,
    accent_color: "#AABBCC",
    link: null,
    price: null,
    currency: null,
    note: null,
    order_index: i,
  }));
}

describe("balanceColumns", () => {
  const heightsOf = (map: Record<string, number>) => new Map(Object.entries(map));

  it("deals round-robin while every height is still unknown", () => {
    const columns = balanceColumns(items(6), 2, new Map());
    expect(columns.map((c) => c.map((i) => i.id))).toEqual([
      ["i0", "i2", "i4"],
      ["i1", "i3", "i5"],
    ]);
  });

  it("sends each card to the shortest column", () => {
    // i0 is enormous, so everything after it belongs in the other column
    const heights = heightsOf({ i0: 1000, i1: 100, i2: 100, i3: 100, i4: 100, i5: 100 });
    const columns = balanceColumns(items(6), 2, heights);
    expect(columns.map((c) => c.map((i) => i.id))).toEqual([
      ["i0"],
      ["i1", "i2", "i3", "i4", "i5"],
    ]);
  });

  it("beats round-robin on the case round-robin cannot handle", () => {
    // alternating tall/short is exactly what defeats index % columns:
    // every tall card lands in the same column
    const alternating = items(40);
    const heights = new Map(alternating.map((item, i) => [item.id, i % 2 ? 190 : 350]));
    const [left, right] = balanceColumns(alternating, 2, heights);
    const total = (column: typeof left) =>
      column.reduce((sum, item) => sum + (heights.get(item.id) ?? 0), 0);
    expect(Math.abs(total(left) - total(right))).toBeLessThanOrEqual(190);
  });

  it("keeps reading order and never drops or duplicates a card", () => {
    const source = items(9);
    const heights = new Map(source.map((item, i) => [item.id, 100 + i * 37]));
    const columns = balanceColumns(source, 3, heights);
    expect(columns.flat().length).toBe(9);
    expect(new Set(columns.flat().map((i) => i.id)).size).toBe(9);
    for (const column of columns) {
      const indexes = column.map((item) => source.indexOf(item));
      expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    }
  });
});

/**
 * The browser preview cannot deliver ResizeObserver callbacks (the pane is
 * hidden, so the page never runs the rendering steps that flush them), and
 * jsdom has no layout at all. So the observer is driven by hand here: this
 * is the only place the measured-height path is actually exercised.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(public callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element) {
    this.targets.add(element);
  }
  unobserve(element: Element) {
    this.targets.delete(element);
  }
  disconnect() {
    this.targets.clear();
  }
  static watching(element: Element | null): FakeResizeObserver | undefined {
    return FakeResizeObserver.instances.find((o) => element && o.targets.has(element));
  }
}

describe("ProfileGrid layout", () => {
  const original = globalThis.ResizeObserver;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = original;
  });

  const board = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".flex.items-start");
  const layout = (container: HTMLElement) =>
    [...(board(container)?.children ?? [])].map((column) =>
      [...column.children].map((card) => (card as HTMLElement).dataset.itemId),
    );

  const setBoardWidth = (container: HTMLElement, width: number) => {
    const element = board(container)!;
    const observer = FakeResizeObserver.watching(element)!;
    act(() => {
      observer.callback(
        [{ target: element, contentRect: { width } } as unknown as ResizeObserverEntry],
        observer as unknown as ResizeObserver,
      );
    });
  };

  const setHeights = (container: HTMLElement, heights: Record<string, number>) => {
    const cards = [...container.querySelectorAll<HTMLElement>("[data-item-id]")];
    const observer = FakeResizeObserver.watching(cards[0])!;
    act(() => {
      observer.callback(
        cards
          .filter((card) => card.dataset.itemId! in heights)
          .map(
            (card) =>
              ({
                target: card,
                borderBoxSize: [{ blockSize: heights[card.dataset.itemId!] }],
              }) as unknown as ResizeObserverEntry,
          ),
        observer as unknown as ResizeObserver,
      );
    });
  };

  const renderGrid = (count: number) =>
    render(
      <ProfileGrid
        items={items(count)}
        canReorder={false}
        stagger={false}
        onOpenItem={() => {}}
        onReorder={() => {}}
      />,
    );

  it("re-deals cards once real heights arrive", () => {
    const { container } = renderGrid(6);
    setBoardWidth(container, 358); // a 390px phone

    expect(layout(container)).toEqual([
      ["i0", "i2", "i4"],
      ["i1", "i3", "i5"],
    ]);

    setHeights(container, { i0: 1000, i1: 100, i2: 100, i3: 100, i4: 100, i5: 100 });

    expect(layout(container)).toEqual([["i0"], ["i1", "i2", "i3", "i4", "i5"]]);
  });

  it("picks the column count from the board's own width", () => {
    const { container } = renderGrid(8);

    setBoardWidth(container, 358); // 390px viewport
    expect(layout(container)).toHaveLength(2);

    setBoardWidth(container, 608); // 640px viewport — the sm breakpoint
    expect(layout(container)).toHaveLength(3);

    setBoardWidth(container, 992); // 1024px viewport — the lg breakpoint
    expect(layout(container)).toHaveLength(4);

    setBoardWidth(container, 358);
    expect(layout(container)).toHaveLength(2);
  });

  it("gives every column an identical width class, whatever the count", () => {
    const { container } = renderGrid(5);
    setBoardWidth(container, 608);
    const classes = [...board(container)!.children].map((c) => c.className);
    expect(new Set(classes).size).toBe(1);
    expect(classes[0]).toContain("flex-1");
    expect(classes[0]).toContain("basis-0");
  });

  it("renders every card exactly once", () => {
    const { container } = renderGrid(9);
    setBoardWidth(container, 358);
    setHeights(container, Object.fromEntries(items(9).map((i, n) => [i.id, 100 + n * 40])));
    const ids = layout(container).flat();
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
  });
});
