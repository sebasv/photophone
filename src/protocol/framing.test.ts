import { describe, expect, it } from "vitest";
import {
  bytesToCells,
  cellsToBytes,
  PALETTE_2BIT,
} from "./codec";
import {
  cellRole,
  DEFAULT_GEOMETRY,
  decodeFrame,
  payloadCellCount,
  payloadCellPositions,
  renderFrame,
} from "./framing";

describe("frame geometry", () => {
  it("matches the design doc cell counts", () => {
    // 64*64 - 4 corners*(4*4) - 1*16 config - 2*64 calibration = 3888
    expect(payloadCellCount(DEFAULT_GEOMETRY)).toBe(3888);
  });

  it("classifies corner cells as fiducial", () => {
    expect(cellRole(DEFAULT_GEOMETRY, 0, 0)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 3, 3)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 63, 0)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 0, 63)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 63, 63)).toBe("fiducial");
  });

  it("classifies the config indicator strip", () => {
    expect(cellRole(DEFAULT_GEOMETRY, 4, 0)).toBe("config");
    expect(cellRole(DEFAULT_GEOMETRY, 19, 0)).toBe("config");
    expect(cellRole(DEFAULT_GEOMETRY, 20, 0)).toBe("payload");
  });

  it("classifies the calibration band", () => {
    expect(cellRole(DEFAULT_GEOMETRY, 32, 4)).toBe("calibration");
    expect(cellRole(DEFAULT_GEOMETRY, 32, 5)).toBe("calibration");
    expect(cellRole(DEFAULT_GEOMETRY, 32, 6)).toBe("payload");
  });

  it("enumerates payload positions in row-major order", () => {
    const positions = payloadCellPositions(DEFAULT_GEOMETRY);
    expect(positions.length).toBe(3888);
    for (let i = 1; i < positions.length; i++) {
      const [x0, y0] = positions[i - 1]!;
      const [x1, y1] = positions[i]!;
      expect(y1 > y0 || (y1 === y0 && x1 > x0)).toBe(true);
    }
  });
});

describe("renderFrame / decodeFrame — pristine round-trip", () => {
  const cellSizePx = 8;

  it("round-trips the cell sequence byte-for-byte", () => {
    const positions = payloadCellPositions(DEFAULT_GEOMETRY);
    const cells = new Uint8Array(positions.length);
    for (let i = 0; i < cells.length; i++) cells[i] = i % 4;

    const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, cellSizePx);
    const decoded = decodeFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, img, cellSizePx);

    expect(decoded).toEqual(cells);
  });

  it("M1 done-when: 800 random bytes round-trip end-to-end", () => {
    const original = randomBytes(800, 0xface);

    // bytes → cells → padded → render → decode → unpad → bytes
    const cells = bytesToCells(original, PALETTE_2BIT);
    const capacity = payloadCellCount(DEFAULT_GEOMETRY);
    expect(cells.length).toBeLessThanOrEqual(capacity);

    const padded = new Uint8Array(capacity);
    padded.set(cells);

    const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, padded, cellSizePx);
    const decoded = decodeFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, img, cellSizePx);

    const trimmed = decoded.slice(0, cells.length);
    const restored = cellsToBytes(trimmed, PALETTE_2BIT);

    expect(restored).toEqual(original);
  });

  it("rejects renderFrame inputs of the wrong length", () => {
    const wrong = new Uint8Array(payloadCellCount(DEFAULT_GEOMETRY) - 1);
    expect(() =>
      renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, wrong, cellSizePx),
    ).toThrow(/expected/);
  });

  it("rejects decodeFrame images of the wrong size", () => {
    const bad = {
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    };
    expect(() =>
      decodeFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, bad, cellSizePx),
    ).toThrow(/expected/);
  });
});

function randomBytes(n: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}
