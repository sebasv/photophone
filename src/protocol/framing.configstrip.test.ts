import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  bytesToCells,
  computeHomography,
  decodeFrameConfigBits,
  encodeFrameConfigBits,
  fiducialCanonicalCentroids,
  payloadCellCount,
  renderFrame,
  sampleConfigStripLuminance,
  type FrameConfigBits,
} from "./index";

const CELL = 12;

function buildFrameWithConfig(bits: Uint8Array) {
  const cellsCount = payloadCellCount(DEFAULT_GEOMETRY);
  const bytes = (cellsCount * 2) / 8;
  const payload = new Uint8Array(bytes);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
  const cells = bytesToCells(payload, PALETTE_2BIT);
  return renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL, bits);
}

function pristineHomography() {
  // Identity-equivalent homography from canonical to "image" coords
  // (the image IS at canonical scale because we used cellSizePx=12).
  const canonical = fiducialCanonicalCentroids(DEFAULT_GEOMETRY, CELL);
  return computeHomography(canonical, canonical);
}

describe("M14 config strip — render + sample round-trip", () => {
  it("round-trips an arbitrary 16-bit pattern", () => {
    const bits = new Uint8Array([0xa5, 0x3c]);
    const frame = buildFrameWithConfig(bits);
    const sampled = sampleConfigStripLuminance(DEFAULT_GEOMETRY, frame, pristineHomography(), CELL);
    expect(sampled).toEqual(bits);
  });

  it("round-trips an all-ones strip", () => {
    const bits = new Uint8Array([0xff, 0xff]);
    const frame = buildFrameWithConfig(bits);
    const sampled = sampleConfigStripLuminance(DEFAULT_GEOMETRY, frame, pristineHomography(), CELL);
    expect(sampled).toEqual(bits);
  });

  it("round-trips an all-zeros strip", () => {
    // All zeros means all config cells are rendered as the LOW colour;
    // mean threshold would be undefined. We handle this by picking the
    // mean as a degenerate split. Both extremes (all 1s) need to work too.
    const bits = new Uint8Array([0x00, 0x00]);
    const frame = buildFrameWithConfig(bits);
    const sampled = sampleConfigStripLuminance(DEFAULT_GEOMETRY, frame, pristineHomography(), CELL);
    // With no contrast, mean=luma_low and `>` fails for every cell → all 0s.
    expect(sampled).toEqual(bits);
  });

  it("M14 FrameConfigBits encode → render → sample → decode matches the original struct", () => {
    const original: FrameConfigBits = {
      mode: "broadcast", frameType: "payload", paletteId: 5, linkTier: 3,
    };
    const bits = encodeFrameConfigBits(original);
    const frame = buildFrameWithConfig(bits);
    const sampled = sampleConfigStripLuminance(DEFAULT_GEOMETRY, frame, pristineHomography(), CELL);
    const decoded = decodeFrameConfigBits(sampled);
    expect(decoded).toEqual(original);
  });

  it("legacy renderFrame call (no configBits arg) still produces a valid frame", () => {
    // Sanity: existing renderFrame consumers (send.ts, broadcast-send.ts, etc.)
    // keep working with no behavioural change.
    const cells = bytesToCells(new Uint8Array((payloadCellCount(DEFAULT_GEOMETRY) * 2) / 8), PALETTE_2BIT);
    const f1 = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL);
    expect(f1.width).toBe(DEFAULT_GEOMETRY.cellsX * CELL);
    expect(f1.height).toBe(DEFAULT_GEOMETRY.cellsY * CELL);
  });

  it("rejects configBits of the wrong length", () => {
    const cells = bytesToCells(new Uint8Array((payloadCellCount(DEFAULT_GEOMETRY) * 2) / 8), PALETTE_2BIT);
    expect(() =>
      renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL, new Uint8Array(3)),
    ).toThrow(/configBits/);
  });
});
