// Shared hue math for the status-token distinctness guard. One definition,
// imported by both the runtime nudge (resolve.ts) and the distinctness test —
// so "≥ MIN_HUE_DELTA apart on the wheel" means the same thing at runtime and
// in the assertion. No new public *behavioral* surface: pure hex→hue helpers.

// Minimum hue separation (degrees) we require on the color wheel between the
// running status hue and the accent/danger hues.
export const MIN_HUE_DELTA = 25;

/**
 * Hue (0..360) of a `#rrggbb` color, or `null` for achromatic inputs
 * (grey/black/white — hue undefined) or unparseable strings. Achromatic
 * colors can't collide with a chromatic running hue, so callers treat `null`
 * as "no collision possible".
 */
export function hexToHue(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  const r = (n >> 16) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null; // achromatic — hue undefined
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Shortest distance between two hues on the 360° wheel. */
export function hueDelta(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}
