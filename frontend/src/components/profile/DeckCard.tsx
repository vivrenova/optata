import { formatPrice } from "../../api/types";
import type { WishlistItem } from "../../api/types";
import { muteAccent } from "../../lib/color";
import { Stamp } from "../ui/Stamp";
import { Tag } from "../ui/Tag";
import { CardMedia } from "./CardMedia";

/**
 * One dealt tag. Fixed 3:4 portrait; the photo is the hero — object-fit
 * cover, filling the frame. The MUTED accent is trim only: the grommet
 * strip and the 2px inner frame (plus the body fill while loading/failed).
 *
 * Interaction split: the PHOTO advances the deck (click/tap), the INFO
 * STRIP (the tag's written body) opens details. Swipe always advances.
 */
export function DeckCard({
  item,
  position,
  total,
  dragging,
  onAdvance,
  onOpen,
}: {
  item: WishlistItem;
  position: number;
  total: number;
  dragging: boolean;
  onAdvance?: () => void;
  onOpen?: () => void;
}) {
  return (
    <Tag grommetFill={muteAccent(item.accent_color)} flat={dragging} className="h-full w-full select-none">
      {/* Stamped serial in the grommet zone. Insets clear the silhouette's
          top corners — 24px left for the 22px cut, 22px right for the 18px
          top-right radius — so the text never rides under a clipped edge. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[38px] items-center justify-between pl-6 pr-[22px]">
        <Stamp className="text-[11px] opacity-70">Optata</Stamp>
        <Stamp className="text-[11px]">
          No. {String(position + 1).padStart(2, "0")}/{String(total).padStart(2, "0")}
        </Stamp>
      </div>

      <div className="flex h-full flex-col px-3 pb-3">
        <button
          type="button"
          tabIndex={-1}
          aria-label="Next card"
          onClick={onAdvance}
          className="min-h-0 flex-1 cursor-pointer"
        >
          <CardMedia item={item} fit="cover" />
        </button>

        <button
          type="button"
          tabIndex={-1}
          onClick={onOpen}
          aria-label={`Details: ${item.title}`}
          className="mt-3 rounded-[10px] px-1 pb-1 text-left"
        >
          <h3 className="line-clamp-2 font-display text-2xl font-semibold leading-tight">
            {item.title}
          </h3>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <Stamp className="text-sm">{formatPrice(item.price, item.currency) ?? " "}</Stamp>
            {item.view === "owner" ? (
              <Stamp className="text-[11px] opacity-70">{item.view_count} views</Stamp>
            ) : (
              <Stamp className="text-[11px] opacity-70">Details →</Stamp>
            )}
          </div>
        </button>
      </div>
    </Tag>
  );
}
