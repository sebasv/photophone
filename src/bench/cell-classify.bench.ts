/**
 * M15 microbench: per-pixel palette classification.
 *
 * Run with:  pnpm vitest bench src/bench/cell-classify.bench.ts
 *
 * Establishes a baseline number of classifications-per-second so we can
 * track perf regressions and compare optimizations (LUT vs distance
 * math vs eventually a WebGL shader).
 */

import { bench, describe } from "vitest";
import { PALETTE_2BIT, decodeFrame } from "../protocol";
import {
  DEFAULT_GEOMETRY,
  bytesToCells,
  payloadCellCount,
  renderFrame,
} from "../protocol";

const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
const capacityBytes = (capacityCells * 2) / 8;
const CELL_SIZE_PX = 12;

// Pre-render one frame and re-use it for every benchmark iteration.
const payload = new Uint8Array(capacityBytes);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
// Magic at the head so decodeFrameWarped finds an orientation.
payload[0] = 0x50; payload[1] = 0x48; payload[2] = 0x4f; payload[3] = 0x54;
const cells = bytesToCells(payload, PALETTE_2BIT);
const frame = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL_SIZE_PX);

describe("frame decode hot path", () => {
  bench("decodeFrame() — full frame, pristine geometry", () => {
    decodeFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL_SIZE_PX);
  });
});

import { decodeFrameWarped } from "../protocol";

describe("warped frame decode (fiducial detection + homography + sample)", () => {
  bench("decodeFrameWarped() — full pipeline, axis-aligned synthetic frame", () => {
    decodeFrameWarped(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL_SIZE_PX);
  });
});
