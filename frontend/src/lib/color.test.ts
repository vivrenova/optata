import { describe, expect, it } from "vitest";

import { muteAccent } from "./color";

function parts(hsl: string) {
  const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(hsl);
  if (!m) throw new Error("not hsl: " + hsl);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

describe("muteAccent — accent is trim, not fill", () => {
  it("hot magenta becomes a dusty mauve: saturation capped, lightness mid-band", () => {
    const { h, s, l } = parts(muteAccent("#FF00FF"));
    expect(h).toBe(300); // hue is preserved
    expect(s).toBeLessThanOrEqual(40);
    expect(l).toBeGreaterThanOrEqual(62);
    expect(l).toBeLessThanOrEqual(80);
  });

  it("near-black and near-white both land in the mid lightness band", () => {
    expect(parts(muteAccent("#050505")).l).toBeGreaterThanOrEqual(62);
    expect(parts(muteAccent("#FAFAFA")).l).toBeLessThanOrEqual(80);
  });

  it("every output stays within the saturation cap", () => {
    for (const hex of ["#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#2E22E0"]) {
      expect(parts(muteAccent(hex)).s).toBeLessThanOrEqual(40);
    }
  });

  it("garbage input falls back to paper-deep", () => {
    expect(muteAccent("magenta")).toBe("#D5D4CE");
    expect(muteAccent("")).toBe("#D5D4CE");
  });
});
