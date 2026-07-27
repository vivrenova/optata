/**
 * Client-side image pipeline (tech-spec §3). Runs BEFORE upload:
 * resize to max 1200px on the long edge, export WebP q=0.82 targeting
 * ≤300KB, extract the dominant accent color from a 32×32 downsample.
 *
 * This is an OPTIMIZATION on top of the server pipeline, never a
 * replacement: the server still re-encodes with Pillow, strips EXIF/GPS
 * and enforces the pixel budget. Pure math lives in exported functions so
 * it can be unit-tested; only the canvas plumbing is browser-only.
 */

export const MAX_LONG_EDGE = 1200;
export const TARGET_BYTES = 300 * 1024;
// server hard limit is 500KB — refuse to upload anything that would bounce
export const SERVER_LIMIT_BYTES = 500 * 1024;

export const PIPELINE_FALLBACK_ACCENT = "#D6D6D1"; // --paper-deep

/** A user-facing pipeline failure: the message is safe to show verbatim.
 * Distinguished from raw browser exceptions so the outer catch keeps our
 * clear copy and only rewrites the cryptic ones. */
export class ImagePipelineError extends Error {}

function fail(message: string): never {
  throw new ImagePipelineError(message);
}

/**
 * iPhones shoot HEIC by default. When picking from Photos, iOS Safari
 * USUALLY transcodes HEIC→JPEG for a web file input — but not always (Files
 * app, drag-drop, some iOS versions), and Chrome/Firefox can't decode HEIC
 * at all. We can't tell in advance whether the browser will decode it, so
 * we try; only when decode fails AND the file looks like HEIC do we say so
 * specifically. iOS often hands over an empty MIME type, hence the name check.
 */
export function looksLikeHeic(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/heic") || type.startsWith("image/heif")) return true;
  if (type === "" || type === "application/octet-stream") {
    return /\.(heic|heif)$/i.test(file.name);
  }
  return false;
}

/** Scale (w,h) so the longer edge is ≤ maxEdge. Never upscales. */
export function targetDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_LONG_EDGE,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Dominant color from RGBA pixel data (a 32×32 downsample): quantize each
 * channel to 4 bits, count buckets, skip near-white / near-black /
 * transparent pixels, return the average color of the winning bucket.
 */
export function dominantAccentHex(pixels: Uint8ClampedArray): string {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a < 128) continue;
    if (r >= 240 && g >= 240 && b >= 240) continue; // near-white
    if (r <= 20 && g <= 20 && b <= 20) continue; // near-black

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best) return PIPELINE_FALLBACK_ACCENT; // an all-white/all-black photo

  const toHex = (value: number) =>
    Math.round(value / best.count)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(best.r)}${toHex(best.g)}${toHex(best.b)}`;
}

export interface ProcessedImage {
  blob: Blob;
  /** Object URL for the live preview — caller revokes it when done. */
  previewUrl: string;
  accentHex: string;
  width: number;
  height: number;
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to the <img> path (some formats/browsers)
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("undecodable image"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function processImageFile(
  file: File,
  maxEdge: number = MAX_LONG_EDGE,
): Promise<ProcessedImage> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await decode(file);
  } catch {
    // The browser couldn't decode it. HEIC (iPhone default) is the common
    // culprit and needs its own instruction.
    if (looksLikeHeic(file)) {
      fail(
        "iPhone HEIC photos can't be opened here. Take a screenshot of it, or " +
          "in Photos choose Share → save as JPEG, then pick that.",
      );
    }
    fail("That file can't be read as an image. Pick a JPEG, PNG or WebP.");
  }

  // Everything below can throw on a low-memory device (decode/draw/encode of
  // a large photo). Wrap it so an OOM surfaces as clear copy, never a raw
  // browser exception — and crucially, the ORIGINAL is never uploaded: the
  // only Blob any caller sends is the one this function returns, and it is
  // guaranteed ≤ SERVER_LIMIT_BYTES below.
  let blob: Blob | null = null;
  let accentHex = PIPELINE_FALLBACK_ACCENT;
  let width: number;
  let height: number;
  try {
    const sourceWidth = "naturalWidth" in source ? source.naturalWidth : source.width;
    const sourceHeight = "naturalHeight" in source ? source.naturalHeight : source.height;
    ({ width, height } = targetDimensions(sourceWidth, sourceHeight, maxEdge));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) fail("Your browser blocked image processing. Try a different browser.");
    context.drawImage(source, 0, 0, width, height);

    // accent from a 32×32 downsample of the SAME canvas
    const swatch = document.createElement("canvas");
    swatch.width = 32;
    swatch.height = 32;
    const swatchContext = swatch.getContext("2d", { willReadFrequently: true });
    if (swatchContext) {
      swatchContext.drawImage(canvas, 0, 0, 32, 32);
      accentHex = dominantAccentHex(swatchContext.getImageData(0, 0, 32, 32).data);
    }

    // WebP q=0.82, stepping quality down until it fits the 300KB target;
    // Safari <16 has no WebP encoder — JPEG is fine, the server re-encodes.
    for (const quality of [0.82, 0.66, 0.5]) {
      blob = await toBlob(canvas, "image/webp", quality);
      if (blob === null) break; // encoder unsupported
      if (blob.size <= TARGET_BYTES) break;
    }
    if (blob === null) {
      for (const quality of [0.85, 0.7, 0.55]) {
        blob = await toBlob(canvas, "image/jpeg", quality);
        if (blob !== null && blob.size <= TARGET_BYTES) break;
      }
    }
  } catch (err) {
    if ("close" in source) source.close();
    if (err instanceof ImagePipelineError) throw err; // keep our clear copy
    fail("This photo couldn't be processed on your device — it may be too large. Try a smaller one or a screenshot.");
  }

  if ("close" in source) source.close();

  if (blob === null) fail("Couldn't encode this photo. Try a different one.");
  if (blob.size > SERVER_LIMIT_BYTES) {
    fail("This photo is still too large after compressing. Pick a smaller one.");
  }

  return { blob, previewUrl: URL.createObjectURL(blob), accentHex, width, height };
}
