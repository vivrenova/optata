/**
 * The raw dominant pixel from a photo is always garish. Mute it before it
 * touches the chrome: desaturate ~50% (capped at 40%), nudge lightness
 * toward the paper tone and clamp to a mid band — a hot magenta photo
 * yields a dusty mauve trim that sits in the palette instead of fighting
 * it. The accent is trim, not fill.
 */

const PAPER_LIGHTNESS = 0.88;
const FALLBACK = "#D5D4CE"; // --paper-deep

export function muteAccent(hex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return FALLBACK;
  const n = parseInt(match[1], 16);
  const r = (n >> 16) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;

  let hue = 0;
  let saturation = 0;
  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const mutedSaturation = Math.min(saturation * 0.5, 0.4);
  const towardPaper = lightness + (PAPER_LIGHTNESS - lightness) * 0.4;
  const mutedLightness = Math.min(0.8, Math.max(0.62, towardPaper));

  return `hsl(${Math.round(hue)} ${Math.round(mutedSaturation * 100)}% ${Math.round(mutedLightness * 100)}%)`;
}
