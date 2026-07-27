import { useId } from "react";
import type { ComponentPropsWithRef } from "react";

import { cn } from "../../lib/cn";

/**
 * The signature surface — a price tag, not a card.
 *
 * Rendered ENTIRELY declaratively, with zero measured dimensions: the SVG
 * has no viewBox and sizes to the container via CSS width/height 100%, so
 * one SVG unit = one rendered pixel. Fixed features (corner radius, angled
 * cut, grommet band, hole) are authored in fixed units and stay crisp at
 * every scale; the variable edges use percentage geometry (`width="100%"`,
 * `cx="50%"`), which SVG resolves against the rendered box. Nothing here
 * waits on JavaScript, so the tag is fully correct on the first paint —
 * grommet band, hole, stroke and silhouette all present before any photo,
 * layout or measurement arrives.
 *
 * The three things that make it read as a tag:
 *  1. an angled top-left corner — the silhouette break;
 *  2. a real see-through punched hole in the grommet band;
 *  3. the offset ink shadow is the same silhouette (a drop-shadow filter,
 *     so it follows the cut and the hole automatically).
 */

const CUT = 22;
const RADIUS = 18;
const GROMMET_H = 38;
const HOLE_CY = GROMMET_H / 2; // dead-centre of the grommet band
const HOLE_R = 5; // delicate grommet, not a hammered hole
const HOLE_RING_W = 1.25;
const STROKE_W = 2;
const STROKE_OUTER = STROKE_W / 2; // 1px — how far the outline sits outside the box

// The chamfer stroke is drawn long (so it always reaches into both joins —
// no hairline notch) and then CLIPPED to the corner. The clip stops it at
// exactly x = -1 and y = -1, which is the outer edge of the 2px outline
// stroke on the left and top edges, so the diagonal terminates flush with
// the silhouette instead of spurring past it.
const DIAG_OVERLAP = 4;
const DIAG_CLIP = `-${STROKE_OUTER},-${STROKE_OUTER} ${CUT * 2},-${STROKE_OUTER} -${STROKE_OUTER},${CUT * 2}`;

// The cut is subtracted as a triangle whose legs run OUTSIDE the box. Its
// hypotenuse is still exactly x + y = CUT (both far points sum to CUT), so
// the chamfer line is unchanged — but extending the legs also removes the
// 1px of outline stroke that hangs outside the box above the cut, which
// would otherwise survive as a sliver up the left and top edges.
const CUT_MARGIN = 6;
const CUT_POLY = `${-CUT_MARGIN},${-CUT_MARGIN} ${CUT + CUT_MARGIN},${-CUT_MARGIN} ${-CUT_MARGIN},${CUT + CUT_MARGIN}`;

interface TagProps extends ComponentPropsWithRef<"div"> {
  /** Punched hole + grommet band. Default on — it IS the brand. */
  hole?: boolean;
  /** Angled top-left corner. Default on. */
  cut?: boolean;
  /** Surface fill (defaults to paper — the accent is trim, not fill). */
  surface?: string;
  /** Raised state (hover/drag settle): 8px offset instead of 5px. */
  lift?: boolean;
  /** Shadow hidden entirely — used DURING drag gestures for 60fps. */
  flat?: boolean;
  /** Fill for the grommet band (deck/grid cards pass the muted accent). */
  grommetFill?: string;
}

export function Tag({
  hole = true,
  cut = true,
  surface,
  lift = false,
  flat = false,
  grommetFill,
  className,
  children,
  ...rest
}: TagProps) {
  // Unique per instance so ~40 grid cards don't collide on one mask id.
  // useId is first-paint stable and needs no measurement.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fillMaskId = `tag-fill-${uid}`;
  const strokeMaskId = `tag-stroke-${uid}`;
  const diagClipId = `tag-diag-${uid}`;
  const offset = lift ? 8 : 5;

  const cutTriangle = cut ? <polygon points={CUT_POLY} fill="black" /> : null;

  return (
    <div className={cn("relative", className)} {...rest}>
      <svg
        aria-hidden="true"
        className="absolute inset-0 z-0 h-full w-full overflow-visible"
        // the offset shadow is a filter, so it follows the true silhouette
        // (cut + hole). Dropped entirely during gestures for 60fps.
        style={{
          filter: flat ? "none" : `drop-shadow(${offset}px ${offset}px 0 var(--color-ink))`,
        }}
      >
        <defs>
          {/* fills clipped to the silhouette: rounded rect − cut − hole */}
          <mask id={fillMaskId}>
            <rect width="100%" height="100%" rx={RADIUS} ry={RADIUS} fill="white" />
            {cutTriangle}
            {hole && <circle cx="50%" cy={HOLE_CY} r={HOLE_R} fill="black" />}
          </mask>
          {/* The outline's 2px stroke straddles the box edge, so 1px of it
              sits OUTSIDE. This mask must therefore extend past the box —
              a 100%×100% white rect would shave that outer half off and
              render every edge at 1px while the chamfer stayed 2px. */}
          <mask id={strokeMaskId}>
            <rect x="-50%" y="-50%" width="200%" height="200%" fill="white" />
            {cutTriangle}
          </mask>
          {/* bounds the chamfer stroke at the outline's own outer edge */}
          {cut && (
            <clipPath id={diagClipId}>
              <polygon points={DIAG_CLIP} />
            </clipPath>
          )}
        </defs>

        {/* surface + grommet band + hairline, all shaped by the fill mask */}
        <g mask={`url(#${fillMaskId})`}>
          <rect
            width="100%"
            height="100%"
            style={{ fill: surface ?? "var(--color-paper)" }}
          />
          {grommetFill && <rect width="100%" height={GROMMET_H} fill={grommetFill} />}
          {hole && (
            <line
              x1="0"
              y1={GROMMET_H}
              x2="100%"
              y2={GROMMET_H}
              strokeWidth={1}
              className="stroke-ink opacity-25"
            />
          )}
        </g>

        {/* 2px silhouette outline: rounded-rect stroke minus the cut corner… */}
        <g mask={`url(#${strokeMaskId})`}>
          <rect
            width="100%"
            height="100%"
            rx={RADIUS}
            ry={RADIUS}
            fill="none"
            strokeWidth={2}
            className="stroke-ink"
          />
        </g>
        {/* …plus the diagonal that closes the cut. Drawn long so it always
            reaches both joins, then clipped so it stops flush at the
            outline's outer edge instead of spurring past the corner. */}
        {cut && (
          <line
            x1={-DIAG_OVERLAP}
            y1={CUT + DIAG_OVERLAP}
            x2={CUT + DIAG_OVERLAP}
            y2={-DIAG_OVERLAP}
            strokeWidth={STROKE_W}
            clipPath={`url(#${diagClipId})`}
            className="stroke-ink"
          />
        )}

        {/* delicate grommet ring around the see-through hole */}
        {hole && (
          <circle
            cx="50%"
            cy={HOLE_CY}
            r={HOLE_R}
            fill="none"
            strokeWidth={HOLE_RING_W}
            className="stroke-ink opacity-70"
          />
        )}
      </svg>

      {/* h-full matters: in a fixed-size tag (deck card) the content area
          must fill the surface or a child's percentage-height chain
          collapses to 0 and the photo vanishes; in auto-height tags
          (grid, modals) 100%-of-auto resolves to auto — no effect. */}
      <div className={cn("relative z-10 h-full", hole && "pt-[38px]")}>{children}</div>
    </div>
  );
}
