import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";

import type { AnonymousItem } from "../../api/types";
import { fisherYates } from "../../lib/shuffle";
import { DeckCard } from "../profile/DeckCard";

import corteizUrl from "../../assets/demo/corteiz.webp";
import lvgolfUrl from "../../assets/demo/lvgolf.webp";
import omegaUrl from "../../assets/demo/omega.webp";
import ordinaryUrl from "../../assets/demo/ordinary.webp";
import plushbeeUrl from "../../assets/demo/plushbee.webp";
import rarebeautyUrl from "../../assets/demo/rarebeauty.webp";
import valentinoUrl from "../../assets/demo/valentino.webp";

/**
 * The landing demo — a stranger must FEEL the core interaction in three
 * seconds, without signing up. Reuses the real DeckCard and the exact
 * swipe numbers from the deck (fling >400 velocity or >35% width, ±12°),
 * but is its own tiny component: photos are BUNDLED assets (zero runtime
 * network beyond our own origin), no views are recorded, and the deck
 * loops forever.
 *
 * Photos are owned/no-attribution-required, run through the same pipeline
 * as a real upload (long edge ≤1200, WebP ≤150KB). accent_color below is
 * the RAW dominant colour, exactly what the client pipeline uploads for a
 * real item — the muting happens at render time, so these cards behave
 * identically to a genuine wishlist item.
 */

const FLING_VELOCITY = 400;
const FLING_OFFSET_RATIO = 0.35;
const DEAL_SPRING = { type: "spring", stiffness: 260, damping: 26 } as const;
const FLY_MS = 320;

const DEMO_ITEMS: AnonymousItem[] = [
  {
    view: "anonymous",
    id: "demo-rarebeauty",
    title: "Rare Beauty Liquid Blush",
    image_url: rarebeautyUrl,
    accent_color: "#98948C",
    link: null,
    price: "20.00",
    currency: "EUR",
    note: null,
    order_index: 0,
  },
  {
    view: "anonymous",
    id: "demo-valentino",
    title: "Valentino Born in Roma",
    image_url: valentinoUrl,
    accent_color: "#292826",
    link: null,
    price: "100.00",
    currency: "USD",
    note: null,
    order_index: 1,
  },
  {
    view: "anonymous",
    id: "demo-ordinary",
    title: "The Ordinary Glycolic Acid",
    image_url: ordinaryUrl,
    accent_color: "#95886C",
    link: null,
    price: "10.00",
    currency: "USD",
    note: null,
    order_index: 2,
  },
  {
    view: "anonymous",
    id: "demo-corteiz",
    title: "Corteiz C Star Mohair Knit Sweater",
    image_url: corteizUrl,
    accent_color: "#082659",
    link: null,
    price: "130.00",
    currency: "EUR",
    note: null,
    order_index: 3,
  },
  {
    view: "anonymous",
    id: "demo-lvgolf",
    title: "Louis Vuitton Golf Card Holder",
    image_url: lvgolfUrl,
    accent_color: "#148879",
    link: null,
    price: "450.00",
    currency: "USD",
    note: null,
    order_index: 4,
  },
  {
    view: "anonymous",
    id: "demo-omega",
    title: "Omega Swatch “Mission to Mars”",
    image_url: omegaUrl,
    accent_color: "#B7B9B5",
    link: null,
    price: "100.00",
    currency: "USD",
    note: null,
    order_index: 5,
  },
  {
    view: "anonymous",
    id: "demo-plushbee",
    title: "Plush Minecraft Bee",
    image_url: plushbeeUrl,
    accent_color: "#79746A",
    link: null,
    price: "25.00",
    currency: "EUR",
    note: null,
    order_index: 6,
  },
];

interface Flying {
  item: AnonymousItem;
  direction: 1 | -1;
  fromX: number;
  key: string;
}

export function DemoDeck() {
  const reducedMotion = useReducedMotion();
  const [order, setOrder] = useState(() => fisherYates(DEMO_ITEMS.map((item) => item.id)));
  const [position, setPosition] = useState(0);
  const [flying, setFlying] = useState<Flying | null>(null);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const flyCleanup = useRef<ReturnType<typeof setTimeout> | null>(null);

  const byId = new Map(DEMO_ITEMS.map((item) => [item.id, item]));
  const topThree = order
    .slice(position, position + 3)
    .map((id) => byId.get(id))
    .filter((item): item is AnonymousItem => item !== undefined);

  const advance = useCallback(
    (direction: 1 | -1 = 1, fromX = 0) => {
      const currentId = order[position];
      const current = currentId ? byId.get(currentId) : undefined;
      const canAnimate = !reducedMotion && document.visibilityState !== "hidden";
      if (current && canAnimate) {
        if (flyCleanup.current) clearTimeout(flyCleanup.current);
        setFlying({ item: current, direction, fromX, key: `${current.id}:${position}` });
        flyCleanup.current = setTimeout(() => setFlying(null), FLY_MS + 200);
      }
      setPosition((p) => {
        if (p + 1 >= order.length) {
          // the demo never dead-ends: reshuffle and loop
          setOrder(fisherYates(DEMO_ITEMS.map((item) => item.id)));
          return 0;
        }
        return p + 1;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, position, reducedMotion],
  );

  useEffect(() => {
    return () => {
      if (flyCleanup.current) clearTimeout(flyCleanup.current);
    };
  }, []);

  // Keyboard support without making the frame a focus target: a focusable
  // wrapper draws a hard rectangle around the card, which competes with the
  // demo. Arrow keys only (never space) so page scrolling is untouched, and
  // never while the user is typing in a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // target can be a non-Element (window/document) — .closest would throw
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      advance(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [advance]);

  return (
    // overflow:clip on BOTH axes — an outgoing card translates ±640px on X
    // and its rotation swells the box on Y, and either axis growing the
    // document flashes a scrollbar. clip (not hidden) creates no scroll
    // container; the clip-margin lets the card still visibly leave the
    // frame before it's cut, so the throw still reads as a throw.
    <div
      ref={frameRef}
      aria-label="Shuffle demo"
      className="relative mx-auto aspect-[3/4] w-full max-w-[300px] [overflow-clip-margin:96px] [overflow:clip]"
    >
      {[...topThree].reverse().map((item) => {
        const depth = topThree.indexOf(item);
        return (
          <DemoCard
            key={item.id}
            item={item}
            depth={depth}
            reducedMotion={Boolean(reducedMotion)}
            dragging={dragging && depth === 0}
            setDragging={setDragging}
            frameRef={frameRef}
            onAdvance={advance}
            position={position + depth}
            total={order.length}
          />
        );
      })}

      {flying && (
        <motion.div
          key={flying.key}
          aria-hidden="true"
          className="absolute inset-0"
          style={{ zIndex: 30, pointerEvents: "none" }}
          initial={{ x: flying.fromX, opacity: 1 }}
          animate={{ x: flying.direction * 640, rotate: flying.direction * 14 }}
          transition={{ duration: FLY_MS / 1000, ease: [0.3, 0.05, 0.6, 1] }}
          onAnimationComplete={() => setFlying(null)}
        >
          <DeckCard item={flying.item} position={position} total={order.length} dragging={true} />
        </motion.div>
      )}
    </div>
  );
}

function DemoCard({
  item,
  depth,
  reducedMotion,
  dragging,
  setDragging,
  frameRef,
  onAdvance,
  position,
  total,
}: {
  item: AnonymousItem;
  depth: number;
  reducedMotion: boolean;
  dragging: boolean;
  setDragging: (value: boolean) => void;
  frameRef: React.RefObject<HTMLDivElement | null>;
  onAdvance: (direction: 1 | -1, fromX?: number) => void;
  position: number;
  total: number;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-320, 0, 320], [-12, 0, 12], { clamp: true });
  const isTop = depth === 0;

  const pose = reducedMotion
    ? { opacity: 1 }
    : {
        opacity: 1,
        scale: 1 - depth * 0.045,
        y: depth * 12,
        rotate: depth === 0 ? 0 : depth === 1 ? -1.6 : 1.4,
      };

  return (
    <motion.div
      className="absolute inset-0"
      style={{
        zIndex: 10 - depth,
        x: isTop ? x : 0,
        rotate: isTop ? rotate : undefined,
        willChange: dragging ? "transform" : undefined,
        pointerEvents: isTop ? "auto" : "none",
      }}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 30, scale: 0.94, rotate: -2 }}
      animate={pose}
      transition={reducedMotion ? { duration: 0.12 } : DEAL_SPRING}
      drag={isTop && !reducedMotion ? "x" : false}
      dragElastic={0.9}
      dragMomentum={false}
      onDragStart={() => setDragging(true)}
      onDragEnd={(_, info) => {
        setDragging(false);
        const width = frameRef.current?.clientWidth ?? 280;
        const flung =
          Math.abs(info.velocity.x) > FLING_VELOCITY ||
          Math.abs(info.offset.x) > width * FLING_OFFSET_RATIO;
        if (flung) {
          onAdvance(info.offset.x >= 0 || info.velocity.x > 0 ? 1 : -1, x.get());
          x.set(0);
        }
      }}
    >
      <DeckCard
        item={item}
        position={position}
        total={total}
        dragging={dragging}
        onAdvance={isTop ? () => onAdvance(1) : undefined}
        onOpen={isTop ? () => onAdvance(1) : undefined}
      />
    </motion.div>
  );
}
