import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  bytesToCells,
  decodeFrameWarped,
  decodeFrameWarpedStateful,
  newWarpedDecoderState,
  payloadCellCount,
  renderFrame,
} from "./index";

const CELL = 12;
const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
const capacityBytes = (capacityCells * 2) / 8;

function buildFrame(seed: number) {
  const payload = new Uint8Array(capacityBytes);
  for (let i = 0; i < payload.length; i++) payload[i] = ((i * seed) ^ (seed >>> 3)) & 0xff;
  // Inject magic at cells 0..15 so the rotation check passes.
  payload[0] = 0x50; payload[1] = 0x48; payload[2] = 0x4f; payload[3] = 0x54;
  const cells = bytesToCells(payload, PALETTE_2BIT);
  return renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL);
}

describe("decodeFrameWarpedStateful — correctness", () => {
  it("first decode on cold state matches the stateless result byte-for-byte", () => {
    const frame = buildFrame(31);
    const expected = decodeFrameWarped(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL);
    const state = newWarpedDecoderState();
    const actual = decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    expect(actual.cells).toEqual(expected.cells);
    expect(actual.orientation).toBe(expected.orientation);
    expect(state.totalFullDetects).toBe(1);
    expect(state.totalFastHits).toBe(0);
  });

  it("second decode of an identical frame hits the fast path", () => {
    const frame = buildFrame(31);
    const state = newWarpedDecoderState();
    decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    const second = decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    expect(state.totalFastHits).toBe(1);
    expect(state.totalFullDetects).toBe(1);
    expect(state.consecutiveFastHits).toBe(1);
    expect(second.orientation).toBe(0);
  });

  it("changing the underlying frame payload still matches the magic and hits fast path", () => {
    // Different payload bytes but same fiducials + same orientation —
    // the fast path should still work, since the magic still matches.
    const f1 = buildFrame(31);
    const f2 = buildFrame(97);
    const state = newWarpedDecoderState();
    decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, f1, CELL, state);
    const r2 = decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, f2, CELL, state);
    expect(state.totalFastHits).toBe(1);
    // Should return the cells of f2, not f1 — verify by comparing with
    // a fresh stateless decode.
    const expected = decodeFrameWarped(DEFAULT_GEOMETRY, PALETTE_2BIT, f2, CELL);
    expect(r2.cells).toEqual(expected.cells);
  });
});

describe("decodeFrameWarpedStateful — graceful fallback on stale cache", () => {
  it("magic-mismatch on cached fiducials triggers full re-detection", () => {
    const f1 = buildFrame(31);
    const state = newWarpedDecoderState();
    decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, f1, CELL, state);
    expect(state.lastFiducials).not.toBeNull();
    // Corrupt the cache so the fast path will fail magic.
    state.lastFiducials = [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    ];
    const r = decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, f1, CELL, state);
    // Full re-detect should have happened, and the result must still match
    // the stateless decode.
    expect(state.totalFullDetects).toBe(2);
    const expected = decodeFrameWarped(DEFAULT_GEOMETRY, PALETTE_2BIT, f1, CELL);
    expect(r.cells).toEqual(expected.cells);
  });
});

describe("decodeFrameWarpedStateful — measurable speedup of the fast path", () => {
  it("warm-cache decode is at least 5× faster than cold-cache decode", () => {
    const frame = buildFrame(31);
    const state = newWarpedDecoderState();
    // Warm the cache.
    decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);

    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      decodeFrameWarped(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL);
    }
    const tCold = (performance.now() - t0) / N;

    const t1 = performance.now();
    for (let i = 0; i < N; i++) {
      decodeFrameWarpedStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    }
    const tWarm = (performance.now() - t1) / N;

    // Document the numbers in the failure for context if the ratio drifts.
    const ratio = tCold / tWarm;
    expect(ratio, `warm-cache ratio: ${ratio.toFixed(2)}× (cold=${tCold.toFixed(2)}ms, warm=${tWarm.toFixed(2)}ms)`).toBeGreaterThan(5);
  });
});

import {
  decodeFrameWarpedWithDiagnosticsStateful,
} from "./index";

describe("decodeFrameWarpedWithDiagnosticsStateful — cache path labelling", () => {
  it("labels the first decode 'cold'", () => {
    const frame = buildFrame(31);
    const state = newWarpedDecoderState();
    const d = decodeFrameWarpedWithDiagnosticsStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    expect(d.cachePath).toBe("cold");
    expect(d.result).not.toBeNull();
    expect(state.totalFullDetects).toBe(1);
    expect(state.totalFastHits).toBe(0);
  });

  it("labels a repeat decode 'fast-hit'", () => {
    const frame = buildFrame(31);
    const state = newWarpedDecoderState();
    decodeFrameWarpedWithDiagnosticsStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    const d2 = decodeFrameWarpedWithDiagnosticsStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    expect(d2.cachePath).toBe("fast-hit");
    expect(state.totalFastHits).toBe(1);
    expect(state.totalFullDetects).toBe(1);
  });

  it("labels a decode 'fast-miss-fallback' when the cached fiducials no longer match", () => {
    const frame = buildFrame(31);
    const state = newWarpedDecoderState();
    decodeFrameWarpedWithDiagnosticsStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    // Corrupt the cache so the fast path fails magic.
    state.lastFiducials = [
      { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 },
    ];
    const d3 = decodeFrameWarpedWithDiagnosticsStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    expect(d3.cachePath).toBe("fast-miss-fallback");
    expect(d3.result).not.toBeNull();
    expect(state.totalFullDetects).toBe(2);
  });

  it("rotationsAttempted on a fast-hit shows only the cached rotation", () => {
    const frame = buildFrame(31);
    const state = newWarpedDecoderState();
    decodeFrameWarpedWithDiagnosticsStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    const d2 = decodeFrameWarpedWithDiagnosticsStateful(DEFAULT_GEOMETRY, PALETTE_2BIT, frame, CELL, state);
    expect(d2.rotationsAttempted.length).toBe(1);
    expect(d2.rotationsAttempted[0]!.matched).toBe(true);
    expect(d2.rotationsAttempted[0]!.rotation).toBe(state.lastRotation);
  });
});
