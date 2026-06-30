/**
 * Unit tests for the screenshot non-blank content assertion (A2).
 *
 * The byte-size guard (MIN_PNG_BYTES) cannot prove a render — a solid-black PNG
 * compresses small but can still exceed 1KB, and the all-chrome (#0d1117) frame
 * a backgrounded Electron window produces is itself near-black. These tests pin
 * the modal-color metric: a uniform frame is "blank"; a sparse-but-real UI passes.
 */

import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import { assertNonBlank, assessNonBlank } from "../screenshot.ts";

// Build a synthetic RGBA PNG buffer of solid `fill`, then optionally paint a
// rectangular region a different color (the "content").
function makePng(
  width: number,
  height: number,
  fill: [number, number, number],
  region?: { x0: number; y0: number; x1: number; y1: number; color: [number, number, number] },
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const inRegion =
        region !== undefined && x >= region.x0 && x < region.x1 && y >= region.y0 && y < region.y1;
      const [r, g, b] = inRegion ? region.color : fill;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// #0d1117 → (13, 17, 23): the Electron window backgroundColor.
const CHROME: [number, number, number] = [13, 17, 23];
const BLACK: [number, number, number] = [0, 0, 0];
const TEXT: [number, number, number] = [230, 237, 243]; // light foreground (#e6edf3)

describe("screenshot content-check", () => {
  test("an all-#0d1117 chrome frame is blank", () => {
    const buf = makePng(200, 200, CHROME);
    const result = assessNonBlank(buf);
    expect(result.ok).toBe(false);
    expect(result.modal).toBe("#0d1117");
    expect(() => assertNonBlank(buf, "chrome.png")).toThrow("blank render");
  });

  test("an all-black frame is blank", () => {
    const buf = makePng(200, 200, BLACK);
    const result = assessNonBlank(buf);
    expect(result.ok).toBe(false);
    expect(result.modal).toBe("#000000");
    expect(() => assertNonBlank(buf, "black.png")).toThrow("blank render");
  });

  test("a sparse-but-valid UI (mostly chrome + a small text region) passes", () => {
    // 200x200 = 40000 px. A 40x40 region = 1600 px = 4% — past the 2% threshold,
    // but still a small minority of the frame (mostly chrome, like a real screen).
    const buf = makePng(200, 200, CHROME, {
      x0: 0,
      y0: 0,
      x1: 40,
      y1: 40,
      color: TEXT,
    });
    const result = assessNonBlank(buf);
    expect(result.modal).toBe("#0d1117"); // chrome still dominant
    expect(result.differingFraction).toBeCloseTo(0.04, 3);
    expect(result.ok).toBe(true);
    expect(() => assertNonBlank(buf, "ui.png")).not.toThrow();
  });

  test("a region below the 2% threshold is still blank", () => {
    // A 20x20 region = 400 px = 1% — under the 2% threshold.
    const buf = makePng(200, 200, CHROME, {
      x0: 0,
      y0: 0,
      x1: 20,
      y1: 20,
      color: TEXT,
    });
    const result = assessNonBlank(buf);
    expect(result.differingFraction).toBeCloseTo(0.01, 3);
    expect(result.ok).toBe(false);
  });
});
