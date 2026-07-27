import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tag } from "./Tag";

/**
 * The Tag must be fully formed on the FIRST paint with zero measured
 * dimensions. jsdom has no layout engine — getBoundingClientRect is 0×0 and
 * ResizeObserver is a no-op stub — so this is exactly the "no size settled
 * yet" case. The old measurement-gated Tag rendered nothing here; the
 * declarative Tag renders its whole silhouette. This test is the guard
 * against the ResizeObserver approach ever creeping back.
 */
describe("Tag renders complete with no measured dimensions", () => {
  it("paints silhouette, grommet band, hole and 2px stroke synchronously", () => {
    const { container } = render(
      <Tag grommetFill="#c9a0a0" data-testid="tag">
        <p>body</p>
      </Tag>,
    );

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();

    // fill mask exists: rounded rect (white) − cut triangle − hole circle
    const maskCircle = svg!.querySelector('mask circle[fill="black"]');
    const maskTriangle = svg!.querySelector("mask polygon");
    expect(maskCircle).not.toBeNull(); // the see-through hole punch
    expect(maskTriangle).not.toBeNull(); // the angled cut

    // grommet band (accent fill) present
    const band = Array.from(svg!.querySelectorAll("rect")).find((r) => {
      const f = r.getAttribute("fill");
      return f === "#c9a0a0";
    });
    expect(band).toBeDefined();

    // the 2px silhouette stroke and the delicate hole ring
    const stroke = Array.from(svg!.querySelectorAll("rect")).find(
      (r) => r.getAttribute("stroke-width") === "2",
    );
    const ring = Array.from(svg!.querySelectorAll("circle")).find(
      (c) => c.getAttribute("stroke-width") === "1.25",
    );
    expect(stroke).toBeDefined();
    expect(ring).toBeDefined();

    // the diagonal that closes the cut corner
    const diagonal = svg!.querySelector('line[stroke-width="2"]');
    expect(diagonal).not.toBeNull();

    // and the offset shadow is a drop-shadow filter (follows the silhouette)
    expect(svg!.getAttribute("style") ?? "").toContain("drop-shadow");
  });

  it("without a grommetFill there is no accent band, but the hole still renders", () => {
    const { container } = render(<Tag>login box</Tag>);
    const svg = container.querySelector("svg")!;
    const accentBand = Array.from(svg.querySelectorAll("rect")).find((r) => {
      const f = r.getAttribute("fill");
      return f && f !== "white" && f !== "none";
    });
    expect(accentBand).toBeUndefined();
    expect(svg.querySelector('circle[stroke-width="1.25"]')).not.toBeNull();
  });

  it("flat drops the shadow filter entirely (drag-gesture 60fps path)", () => {
    const { container } = render(<Tag flat>x</Tag>);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("style") ?? "").toContain("filter: none");
  });

  it("cut={false} omits the diagonal and the mask triangle", () => {
    const { container } = render(<Tag cut={false}>x</Tag>);
    const svg = container.querySelector("svg")!;
    expect(svg.querySelector("mask polygon")).toBeNull();
    expect(svg.querySelector('line[stroke-width="2"]')).toBeNull();
  });
});
