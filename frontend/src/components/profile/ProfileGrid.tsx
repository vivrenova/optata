import { useState } from "react";
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
 * Masonry board of tags (CSS columns — cards keep their photo ratio).
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

  const ids = items.map((item) => item.id);
  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;

  const board = (
    <div className="columns-2 gap-4 sm:columns-3 lg:columns-4">
      {items.map((item, index) => (
        <GridCard
          key={item.id}
          item={item}
          index={index}
          stagger={stagger}
          sortable={canReorder}
          dimmed={activeId === item.id}
          onOpen={() => onOpenItem(item.id)}
        />
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
  onOpen,
}: {
  item: WishlistItem;
  index: number;
  stagger: boolean;
  sortable: boolean;
  dimmed: boolean;
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

  return (
    <motion.div
      {...entrance}
      ref={setNodeRef}
      className={cn(
        "mb-4 break-inside-avoid",
        dimmed && "opacity-40",
        isOver && !dimmed && "translate-y-1",
      )}
      // No content-visibility: inside a CSS multi-column container it
      // collapses off-screen cards to zero height, piling them into the
      // last column and starving the tag's size measurement. ≤40 cards —
      // there is nothing to virtualize.
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
