import { describe, expect, it } from "vitest";

import { fisherYates } from "./shuffle";

describe("fisherYates", () => {
  it("is a permutation: same elements, same length, no repeats", () => {
    const input = Array.from({ length: 40 }, (_, i) => `item-${i}`);
    const out = fisherYates(input);
    expect(out).toHaveLength(40);
    expect(new Set(out).size).toBe(40);
    expect([...out].sort()).toEqual([...input].sort());
    expect(input[0]).toBe("item-0"); // input untouched
  });

  it("uses the injected rng deterministically", () => {
    const seq = [0.9, 0.1, 0.5];
    let i = 0;
    const rng = () => seq[i++ % seq.length];
    expect(fisherYates([1, 2, 3, 4], rng)).toEqual(fisherYates([1, 2, 3, 4], (() => { i = 0; return rng; })()));
  });

  it("different runs produce different orders (40 cards, sanity)", () => {
    const input = Array.from({ length: 40 }, (_, i) => i);
    const a = fisherYates(input).join(",");
    const b = fisherYates(input).join(",");
    const c = fisherYates(input).join(",");
    // three identical shuffles of 40! permutations means the rng is broken
    expect(a === b && b === c).toBe(false);
  });
});
