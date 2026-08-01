/**
 * Client-side image pipeline (tech-spec §3). Runs BEFORE upload:
 * resize to max 1200px on the long edge, export WebP (falling back to JPEG
 * where WebP encoding is unavailable) stepping quality down toward ≤800KB,
 * extract the dominant accent color from a 32×32 downsample.
 *
 * This is an OPTIMIZATION on top of the server pipeline, never a
 * replacement: the server still re-encodes with Pillow, strips EXIF/GPS
 * and enforces the pixel budget. Pure math lives in exported functions so
 * it can be unit-tested; only the canvas plumbing is browser-only.
 */

export const MAX_LONG_EDGE = 1200;
// Phones shoot 3–5MB; rejecting those at pick time is the wrong constraint,
// since we are about to downscale anyway. This only stops absurd inputs.
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const TARGET_BYTES = 800 * 1024;
// Must match MAX_IMAGE_BYTES in backend/app/routers/items.py — anything
// bigger would bounce at the server, so we refuse it here with a better
// message than a bare 413.
export const SERVER_LIMIT_BYTES = 1024 * 1024;

// Encoder ladders. We ask for WebP first (smallest for photos) and fall
// back to JPEG. Never PNG: it is lossless, so it IGNORES the quality
// argument entirely — on a 933x1200 photo it produces the same ~2.5MB at
// q=0.82 and q=0.5. That is precisely the trap below.
const WEBP_QUALITIES = [0.9, 0.82, 0.72, 0.62, 0.5];
const JPEG_QUALITIES = [0.92, 0.85, 0.75, 0.65, 0.55];

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
  /** The format the browser ACTUALLY produced — not the one we asked for.
   * Surfaced in the UI so an upload problem is diagnosable on a device we
   * cannot open a console on. */
  mimeType: string;
}

/** Filename matching the real encoding. The server keys off the multipart
 * content-type, not this, but a truthful name keeps logs honest. */
export function filenameFor(mimeType: string): string {
  if (mimeType === "image/webp") return "photo.webp";
  if (mimeType === "image/png") return "photo.png";
  return "photo.jpg";
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

/**
 * Encode, and verify what actually came back.
 *
 * The whole iOS bug lived here. Per spec, when `toBlob` is handed a type it
 * cannot encode it does NOT return null — it silently falls back to PNG.
 * iOS Safari does exactly that for `image/webp`. Checking for null therefore
 * detects nothing, the "quality step-down" loop re-encodes an identical
 * lossless PNG three times, and the user is told to shrink a file that was
 * never the problem.
 *
 * So: trust the blob's own type, never the requested one, and never the
 * user agent string.
 */
async function encodeAs(
  canvas: HTMLCanvasElement,
  type: string,
  qualities: number[],
): Promise<{ blob: Blob; supported: boolean }> {
  let smallest: Blob | null = null;
  for (const quality of qualities) {
    const blob = await toBlob(canvas, type, quality);
    if (blob === null) break; // some UAs do return null for unknown types
    if (blob.type !== type) {
      // Encoder unsupported: the UA substituted another format. Report it
      // so the caller can try the next codec instead of grinding through a
      // ladder that cannot change the output by even one byte.
      return { blob, supported: false };
    }
    if (smallest === null || blob.size < smallest.size) smallest = blob;
    if (blob.size <= TARGET_BYTES) break;
  }
  if (smallest === null) return { blob: new Blob([]), supported: false };
  return { blob: smallest, supported: true };
}

export async function processImageFile(
  file: File,
  maxEdge: number = MAX_LONG_EDGE,
): Promise<ProcessedImage> {
  if (file.size > MAX_INPUT_BYTES) {
    fail(
      `That photo is ${Math.round(file.size / 1024 / 1024)}MB — bigger than the ` +
        `${MAX_INPUT_BYTES / 1024 / 1024}MB we can process. Pick another one.`,
    );
  }

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

    // WebP first (smallest for photos). If this browser can't encode it —
    // iOS Safari can decode WebP but not write it — fall back to JPEG,
    // which honours the quality argument. Whatever we end up with, the
    // server re-encodes to WebP anyway, so this only affects upload size.
    const webp = await encodeAs(canvas, "image/webp", WEBP_QUALITIES);
    if (webp.supported) {
      blob = webp.blob;
    }
    if (blob === null || blob.size > TARGET_BYTES) {
      const jpeg = await encodeAs(canvas, "image/jpeg", JPEG_QUALITIES);
      if (jpeg.supported && (blob === null || jpeg.blob.size < blob.size)) {
        blob = jpeg.blob;
      } else if (blob === null && jpeg.blob.size > 0) {
        // Neither codec is available; keep whatever the UA produced (PNG).
        // The server accepts PNG too, so this still works if it fits.
        blob = jpeg.blob;
      }
    }
  } catch (err) {
    if ("close" in source) source.close();
    if (err instanceof ImagePipelineError) throw err; // keep our clear copy
    fail("This photo couldn't be processed on your device — it may be too large. Try a smaller one or a screenshot.");
  }

  if ("close" in source) source.close();

  if (blob === null || blob.size === 0) {
    fail("Your browser couldn't convert this photo. Try a JPEG, or a screenshot of it.");
  }
  if (blob.size > SERVER_LIMIT_BYTES) {
    // Say what actually happened. Telling someone to "pick a smaller one"
    // when their input was tiny — the old message — sends them chasing a
    // problem that isn't there. The size here is the OUTPUT size, and if
    // we're still over budget after the whole ladder, the cause is almost
    // always that the browser gave us a lossless format.
    const outKb = Math.round(blob.size / 1024);
    const format = blob.type || "an unknown format";
    fail(
      `Your browser encoded this as ${format} at ${outKb}KB, over the ` +
        `${SERVER_LIMIT_BYTES / 1024}KB limit. Try saving the photo as a JPEG and picking that.`,
    );
  }

  return {
    blob,
    previewUrl: URL.createObjectURL(blob),
    accentHex,
    width,
    height,
    mimeType: blob.type || "unknown",
  };
}
