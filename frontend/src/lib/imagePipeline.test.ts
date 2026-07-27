import { describe, expect, it } from "vitest";

import {
  dominantAccentHex,
  looksLikeHeic,
  PIPELINE_FALLBACK_ACCENT,
  targetDimensions,
} from "./imagePipeline";

function fakeFile(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe("looksLikeHeic", () => {
  it("matches HEIC/HEIF by MIME type", () => {
    expect(looksLikeHeic(fakeFile("IMG_0001.HEIC", "image/heic"))).toBe(true);
    expect(looksLikeHeic(fakeFile("x", "image/heif"))).toBe(true);
    expect(looksLikeHeic(fakeFile("x", "image/heic-sequence"))).toBe(true);
  });

  it("matches by extension when iOS gives an empty or generic MIME type", () => {
    expect(looksLikeHeic(fakeFile("IMG_0002.heic", ""))).toBe(true);
    expect(looksLikeHeic(fakeFile("photo.HEIF", "application/octet-stream"))).toBe(true);
  });

  it("does not match real supported images", () => {
    expect(looksLikeHeic(fakeFile("photo.jpg", "image/jpeg"))).toBe(false);
    expect(looksLikeHeic(fakeFile("photo.png", "image/png"))).toBe(false);
    expect(looksLikeHeic(fakeFile("photo.webp", "image/webp"))).toBe(false);
    // a .heic name but a real jpeg MIME (iOS already transcoded) → not HEIC
    expect(looksLikeHeic(fakeFile("weird.heic", "image/jpeg"))).toBe(false);
  });
});

function pixels(colors: Array<[number, number, number, number?]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach(([r, g, b, a = 255], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  });
  return data;
}

describe("targetDimensions", () => {
  it("shrinks the long edge to 1200 and keeps the aspect", () => {
    expect(targetDimensions(4000, 3000)).toEqual({ width: 1200, height: 900 });
    expect(targetDimensions(3000, 4000)).toEqual({ width: 900, height: 1200 });
  });

  it("never upscales small images", () => {
    expect(targetDimensions(640, 480)).toEqual({ width: 640, height: 480 });
    expect(targetDimensions(1200, 1200)).toEqual({ width: 1200, height: 1200 });
  });

  it("never collapses a thin edge to zero", () => {
    expect(targetDimensions(24000, 10).height).toBeGreaterThanOrEqual(1);
  });
});

describe("dominantAccentHex", () => {
  it("picks the most common color", () => {
    const data = pixels([
      [200, 40, 60],
      [200, 40, 60],
      [200, 40, 60],
      [30, 90, 200],
    ]);
    expect(dominantAccentHex(data)).toBe("#C8283C");
  });

  it("ignores near-white, near-black and transparent pixels", () => {
    const data = pixels([
      [250, 250, 250], // near-white — skipped
      [250, 250, 250],
      [250, 250, 250],
      [10, 10, 10], // near-black — skipped
      [10, 10, 10],
      [180, 60, 40, 10], // transparent — skipped
      [90, 140, 70], // the only counted pixel wins
    ]);
    expect(dominantAccentHex(data)).toBe("#5A8C46");
  });

  it("falls back to paper-deep when every pixel is white/black", () => {
    const data = pixels([
      [255, 255, 255],
      [0, 0, 0],
    ]);
    expect(dominantAccentHex(data)).toBe(PIPELINE_FALLBACK_ACCENT);
  });

  it("averages within the winning bucket (quantization doesn't posterize output)", () => {
    const data = pixels([
      [200, 40, 60],
      [204, 44, 62], // same 4-bit bucket as above
    ]);
    expect(dominantAccentHex(data)).toBe("#CA2A3D");
  });
});
