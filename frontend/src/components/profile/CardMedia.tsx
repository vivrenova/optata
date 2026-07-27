import { useState } from "react";

import type { WishlistItem } from "../../api/types";
import { cn } from "../../lib/cn";
import { muteAccent } from "../../lib/color";
import { Stamp } from "../ui/Stamp";

/**
 * The photo inside a tag — and the photo is the HERO. It fills the frame
 * (cover in the deck, natural ratio in the grid); the muted accent appears
 * only as the 2px frame, and as the body fill while the photo is loading
 * or when it failed — a card is never empty and never a broken-image icon.
 *
 * Reservation state renders ONLY for the guest view — the union type makes
 * reading it on any other payload a compile error.
 */
export function CardMedia({
  item,
  fit,
  className,
}: {
  item: WishlistItem;
  /** "cover" = fixed deck frame, photo fills it; "natural" = grid keeps the photo's ratio */
  fit: "cover" | "natural";
  className?: string;
}) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const reserved = item.view === "guest" && item.is_reserved;
  const muted = muteAccent(item.accent_color);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[10px] border-2",
        fit === "cover" ? "h-full w-full" : "w-full",
        fit === "natural" && state !== "ready" ? "aspect-[3/4]" : "",
        className,
      )}
      style={{ borderColor: muted, backgroundColor: muted }}
    >
      {state !== "failed" && (
        <img
          src={item.image_url}
          alt={item.title}
          draggable={false}
          // A cached image can be complete BEFORE React attaches onLoad —
          // the event then never fires and the photo would stay at
          // opacity 0 forever. The ref check covers that path.
          ref={(el) => {
            if (el && el.complete && el.naturalWidth > 0) {
              setState((current) => (current === "loading" ? "ready" : current));
            }
          }}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
          className={cn(
            "transition-opacity duration-150 motion-reduce:transition-none",
            fit === "cover"
              ? "absolute inset-0 h-full w-full object-cover"
              : "block h-auto w-full",
            state === "ready" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {reserved && (
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, rgba(19,19,17,0.25) 0 2px, transparent 2px 9px)",
          }}
        />
      )}
      {reserved && (
        <div className="absolute inset-x-0 bottom-2 flex justify-center px-2">
          <span className="rounded-[6px] border-2 border-ink bg-paper px-2 py-1">
            <Stamp className="text-[10px]">
              {item.reserved_by_me ? "Yours to give" : "Already spoken for"}
            </Stamp>
          </span>
        </div>
      )}
    </div>
  );
}
