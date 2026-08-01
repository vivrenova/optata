import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dominantAccentHex,
  filenameFor,
  ImagePipelineError,
  looksLikeHeic,
  MAX_INPUT_BYTES,
  PIPELINE_FALLBACK_ACCENT,
  processImageFile,
  SERVER_LIMIT_BYTES,
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

describe("filenameFor", () => {
  it("names the file after what was actually encoded", () => {
    expect(filenameFor("image/webp")).toBe("photo.webp");
    expect(filenameFor("image/png")).toBe("photo.png");
    expect(filenameFor("image/jpeg")).toBe("photo.jpg");
    expect(filenameFor("")).toBe("photo.jpg");
  });
});

/**
 * A fake browser with a configurable encoder table, so the fallback path can
 * be tested without a real canvas.
 *
 * The behaviour being modelled is the one that caused the iOS bug: when
 * `toBlob` is asked for a type the browser cannot encode, it does NOT return
 * null — it silently returns a PNG. PNG is lossless, so every quality step
 * produces a byte-identical result. Any encoder missing from `sizes` behaves
 * exactly that way here.
 */
function installFakeBrowser(
  sizes: Record<string, ((quality: number) => number) | undefined>,
  pngBytes = 2496 * 1024,
) {
  const attempts: Array<{ requested: string; produced: string; quality: number }> = [];
  const decode = vi.fn(async () => ({ width: 3000, height: 4000, close: () => {} }));

  globalThis.createImageBitmap = decode as unknown as typeof createImageBitmap;

  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => {},
    getImageData: () => ({ data: pixels([[120, 80, 200]]) }),
  })) as unknown as HTMLCanvasElement["getContext"];

  HTMLCanvasElement.prototype.toBlob = function (
    callback: BlobCallback,
    type?: string,
    quality?: number,
  ) {
    const requested = type ?? "image/png";
    const encoder = sizes[requested];
    const produced = encoder ? requested : "image/png";
    const bytes = encoder ? encoder(quality ?? 1) : pngBytes;
    attempts.push({ requested, produced, quality: quality ?? 1 });
    callback(new Blob([new ArrayBuffer(bytes)], { type: produced }));
  } as unknown as HTMLCanvasElement["toBlob"];

  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};

  return { attempts, decode };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ImagePipelineError);
    return (err as Error).message;
  }
  throw new Error("expected the pipeline to reject");
}

describe("processImageFile encoder fallback", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
  });

  const photo = () => new File([new Uint8Array([1, 2, 3])], "IMG_1.jpg", { type: "image/jpeg" });

  it("uses WebP where the browser can encode it, and resizes to 1200", async () => {
    installFakeBrowser({ "image/webp": (q) => Math.round(900 * 1024 * q) });

    const result = await processImageFile(photo());

    expect(result.mimeType).toBe("image/webp");
    expect(result.width).toBe(900);
    expect(result.height).toBe(1200);
  });

  it("falls back to JPEG — not PNG — when WebP encoding is unavailable", async () => {
    // This is the iOS Safari case, and the exact regression being pinned:
    // before the fix the null-check never fired, three identical 2.5MB PNGs
    // were produced, and the user was told to pick a smaller photo.
    const { attempts } = installFakeBrowser({ "image/jpeg": (q) => Math.round(700 * 1024 * q) });

    const result = await processImageFile(photo());

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.blob.size).toBeLessThanOrEqual(SERVER_LIMIT_BYTES);
    // WebP is abandoned after ONE attempt: re-asking a missing encoder at a
    // lower quality cannot change a lossless result by a single byte.
    expect(attempts.filter((a) => a.requested === "image/webp")).toHaveLength(1);
    expect(attempts.some((a) => a.requested === "image/jpeg")).toBe(true);
  });

  it("accepts a PNG when it is the only thing the browser can produce and it fits", async () => {
    installFakeBrowser({}, 400 * 1024);

    const result = await processImageFile(photo());

    expect(result.mimeType).toBe("image/png");
    expect(filenameFor(result.mimeType)).toBe("photo.png");
  });

  it("reports the real format and size instead of blaming the input's size", async () => {
    installFakeBrowser({}, 2496 * 1024);

    const message = await messageOf(processImageFile(photo()));

    expect(message).toContain("image/png");
    expect(message).toContain("2496KB");
    // the old copy — "This photo is still too large after compressing. Pick a
    // smaller one." — sent people chasing a problem that was never theirs
    expect(message).not.toMatch(/smaller/i);
  });

  it("rejects an absurd input before decoding anything", async () => {
    const { decode } = installFakeBrowser({ "image/webp": () => 100 * 1024 });
    const huge = new File([new ArrayBuffer(MAX_INPUT_BYTES + 1)], "huge.jpg", {
      type: "image/jpeg",
    });

    const message = await messageOf(processImageFile(huge));

    expect(message).toContain("10MB");
    expect(decode).not.toHaveBeenCalled();
  });
});
