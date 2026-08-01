import { useCallback, useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { motion, useReducedMotion } from "framer-motion";

import { formatPrice } from "../../api/types";
import type { WishlistItem } from "../../api/types";
import { cn } from "../../lib/cn";
import { muteAccent } from "../../lib/color";
import { Stamp } from "../ui/Stamp";
import { Tag } from "../ui/Tag";
import { CardMedia } from "./CardMedia";

/**
 * Column count comes from the BOARD's own width, not the window's.
 *
 * The thresholds are the old Tailwind breakpoints minus the page's 32px of
 * padding, so the counts change at the same viewport widths as before
 * (sm 640 → 3, lg 1024 → 4). Measuring the container rather than the
 * window is deliberate: a ResizeObserver fires whenever the box actually
 * changes size, including cases a `resize` listener never sees, so there
 * is no state to go stale.
 */
const COLUMN_STEPS = [
  { minWidth: 992, columns: 4 },
  { minWidth: 608, columns: 3 },
] as const;
const MOBILE_COLUMNS = 2;

function columnsFor(width: number): number {
  return COLUMN_STEPS.find((step) => width >= step.minWidth)?.columns ?? MOBILE_COLUMNS;
}

/** Used for a card whose height isn't measured yet. Only the FIRST paint
 * uses these, and CardMedia reserves aspect-[3/4] until its photo loads,
 * so the guess is close and the correction is one quiet reflow. */
const ASSUMED_CARD_HEIGHT = 280;

/**
 * Deal cards into the SHORTEST column, in order.
 *
 * This is the whole reason the board no longer uses CSS multi-column.
 * Multicol balances by breaking one content stream, and every card carries
 * `break-inside-avoid`, so it can only ever cut between whole cards — with
 * photos of different ratios that lands badly (measured at 390px: 4 cards
 * in one column, 5 in the other, and a 176px hole at the bottom of the
 * short one). Greedy shortest-column placement is the standard fix and is
 * stable here for one specific reason: every column is exactly the same
 * width, so a card's height does NOT depend on which column it lands in.
 * Re-balancing therefore converges instead of oscillating.
 */
export function balanceColumns<T extends { id: string }>(
  items: readonly T[],
  columnCount: number,
  heights: ReadonlyMap<string, number>,
): T[][] {
  const columns: T[][] = Array.from({ length: columnCount }, () => []);
  const totals = new Array<number>(columnCount).fill(0);

  for (const item of items) {
    let target = 0;
    for (let i = 1; i < columnCount; i += 1) {
      // strict <: ties go to the leftmost column, so reading order is kept
      if (totals[i] < totals[target]) target = i;
    }
    columns[target].push(item);
    totals[target] += heights.get(item.id) ?? ASSUMED_CARD_HEIGHT;
  }

  return columns;
}

/**
 * Masonry board of tags — equal-width flex columns, cards dealt into the
 * shortest one. Cards keep their photo's ratio.
 *
 * Owners drag to reorder: optimistic, PUT on drop, revert on failure.
 * Mid-drag cards do NOT transform-preview (masonry geometry lies to
 * sortable strategies); the DragOverlay clone plus a drop highlight is
 * the honest feedback.
 */
export function ProfileGrid({
  items,
  canReorder,
  stagger,
  onOpenItem,
  onReorder,
}: {
  items: readonly WishlistItem[];
  canReorder: boolean;
  stagger: boolean;
  onOpenItem: (id: string) => void;
  onReorder: (ids: string[]) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
  );

  // Estimated for the first paint only — one frame later the observer
  // below replaces it with the measured width. Without the estimate a
  // desktop board would flash two columns before settling.
  const [boardWidth, setBoardWidth] = useState(() =>
    typeof window === "undefined" ? 0 : Math.min(window.innerWidth - 32, 992),
  );
  const columnCount = columnsFor(boardWidth);

  const measureBoard = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    setBoardWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBoardWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());

  // One observer for the whole board. Cards register through `measure`
  // below; a card's own height is all we need, since equal column widths
  // make that height independent of where it is placed.
  const [observer] = useState<ResizeObserver | null>(() => {
    if (typeof ResizeObserver === "undefined") return null;
    return new ResizeObserver((entries) => {
      setHeights((current) => {
        let next: Map<string, number> | null = null;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.itemId;
          if (!id) continue;
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (Math.abs((current.get(id) ?? -1) - height) < 0.5) continue;
          next ??= new Map(current);
          next.set(id, height);
        }
        return next ?? current;
      });
    });
  });

  useEffect(() => () => observer?.disconnect(), [observer]);

  const measure = useCallback(
    (element: HTMLElement | null, id: string) => {
      if (!observer || !element) return;
      element.dataset.itemId = id;
      observer.observe(element);
      return () => observer.unobserve(element);
    },
    [observer],
  );

  const ids = items.map((item) => item.id);
  const order = new Map(ids.map((id, index) => [id, index]));
  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;
  const columns = balanceColumns(items, columnCount, heights);

  const board = (
    // flex-1 + basis-0 is what actually guarantees equal columns: every
    // track gets an identical share of the free space regardless of its
    // content. min-w-0 stops a stubborn child from widening its own track.
    <div ref={measureBoard} className="flex items-start gap-4">
      {columns.map((column, columnIndex) => (
        <div key={columnIndex} className="flex min-w-0 flex-1 basis-0 flex-col gap-4">
          {column.map((item) => (
            <GridCard
              key={item.id}
              item={item}
              index={order.get(item.id) ?? 0}
              stagger={stagger}
              sortable={canReorder}
              dimmed={activeId === item.id}
              measure={measure}
              onOpen={() => onOpenItem(item.id)}
            />
          ))}
        </div>
      ))}
    </div>
  );

  if (!canReorder) return board;

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={ids}>{board}</SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeItem && (
          <div className="rotate-2">
            <GridCardBody item={activeItem} lifted />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function GridCard({
  item,
  index,
  stagger,
  sortable,
  dimmed,
  measure,
  onOpen,
}: {
  item: WishlistItem;
  index: number;
  stagger: boolean;
  sortable: boolean;
  dimmed: boolean;
  measure: (element: HTMLElement | null, id: string) => (() => void) | undefined;
  onOpen: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, isOver } = useSortable({
    id: item.id,
    disabled: !sortable,
  });

  // deck → grid choreography: first 10 cards stagger in, the rest fade
  const entrance = !stagger
    ? {}
    : reducedMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.12 } }
      : index < 10
        ? {
            initial: { opacity: 0, y: 14 },
            animate: { opacity: 1, y: 0 },
            transition: { delay: index * 0.03, duration: 0.25, ease: "easeOut" as const },
          }
        : {
            initial: { opacity: 0 },
            animate: { opacity: 1 },
            transition: { delay: 0.3, duration: 0.2 },
          };

  // dnd-kit needs the node, the ResizeObserver needs the node, and React 19
  // wants a cleanup rather than a second call with null.
  const ref = (element: HTMLDivElement | null) => {
    setNodeRef(element);
    const unobserve = measure(element, item.id);
    return () => {
      setNodeRef(null);
      unobserve?.();
    };
  };

  return (
    <motion.div
      {...entrance}
      ref={ref}
      className={cn(dimmed && "opacity-40", isOver && !dimmed && "translate-y-1")}
      // No content-visibility: it collapses off-screen cards to zero
      // height, which would now feed the balancer a lie as well as
      // starving the tag's size measurement. ≤40 cards — there is nothing
      // to virtualize.
      {...(sortable ? { ...attributes, ...listeners } : {})}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={`Details: ${item.title}`}>
        <GridCardBody item={item} />
      </button>
    </motion.div>
  );
}

function GridCardBody({ item, lifted = false }: { item: WishlistItem; lifted?: boolean }) {
  const price = formatPrice(item.price, item.currency);
  return (
    <Tag grommetFill={muteAccent(item.accent_color)} lift={lifted} className="w-full">
      <div className="px-2.5 pb-3">
        <CardMedia item={item} fit="natural" />
        <h3 className="mt-2.5 line-clamp-2 px-1 font-display text-base font-semibold leading-snug">
          {item.title}
        </h3>
        <div className="mt-1 flex items-center justify-between gap-2 px-1">
          <Stamp className="text-[11px]">{price ?? " "}</Stamp>
          {item.view === "owner" && (
            <Stamp className="text-[11px] opacity-70">{item.view_count} views</Stamp>
          )}
        </div>
      </div>
    </Tag>
  );
}
