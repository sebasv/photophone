import { describe, expect, it } from "vitest";
import {
  bytesToCells,
  cellsToBytes,
  PALETTE_2BIT,
} from "./codec";
import {
  applyHomography,
  cellRole,
  computeHomography,
  DEFAULT_GEOMETRY,
  decodeFrame,
  decodeFrameWarped,
  detectFiducials,
  detectionBoundsForCellSize,
  fiducialCanonicalCentroids,
  type Homography,
  isFiducialMarkerCell,
  payloadCellCount,
  payloadCellPositions,
  type Point,
  type RawImage,
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

describe("fiducial marker geometry", () => {
  it("marks the inner 2×2 of each 4-cell fiducial as marker cells", () => {
    expect(isFiducialMarkerCell(DEFAULT_GEOMETRY, 0, 0)).toBe(false);
    expect(isFiducialMarkerCell(DEFAULT_GEOMETRY, 1, 1)).toBe(true);
    expect(isFiducialMarkerCell(DEFAULT_GEOMETRY, 2, 2)).toBe(true);
    expect(isFiducialMarkerCell(DEFAULT_GEOMETRY, 3, 3)).toBe(false);

    expect(isFiducialMarkerCell(DEFAULT_GEOMETRY, 61, 61)).toBe(true);
    expect(isFiducialMarkerCell(DEFAULT_GEOMETRY, 62, 62)).toBe(true);
    expect(isFiducialMarkerCell(DEFAULT_GEOMETRY, 63, 63)).toBe(false);

    expect(isFiducialMarkerCell(DEFAULT_GEOMETRY, 10, 10)).toBe(false);
  });
});

describe("fiducial detection on a pristine frame", () => {
  it("locates the four fiducial centroids at their canonical positions", () => {
    const cellSizePx = 8;
    const cells = new Uint8Array(payloadCellCount(DEFAULT_GEOMETRY));
    const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, cellSizePx);

    const detected = detectFiducials(
      img,
      detectionBoundsForCellSize(cellSizePx),
    );
    expect(detected).not.toBeNull();
    const canonical = fiducialCanonicalCentroids(DEFAULT_GEOMETRY, cellSizePx);

    for (let i = 0; i < 4; i++) {
      expect(detected![i]!.x).toBeCloseTo(canonical[i]!.x, 0);
      expect(detected![i]!.y).toBeCloseTo(canonical[i]!.y, 0);
    }
  });
});

describe("homography solver", () => {
  it("recovers the identity transform from coincident points", () => {
    const pts: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const h = computeHomography(pts, pts);
    for (const p of pts) {
      const q = applyHomography(h, p);
      expect(q.x).toBeCloseTo(p.x, 6);
      expect(q.y).toBeCloseTo(p.y, 6);
    }
  });

  it("maps corner points exactly to their destinations", () => {
    const src: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const dst: [Point, Point, Point, Point] = [
      { x: 50, y: 30 },
      { x: 230, y: 70 },
      { x: 260, y: 200 },
      { x: 40, y: 180 },
    ];
    const h = computeHomography(src, dst);
    for (let i = 0; i < 4; i++) {
      const q = applyHomography(h, src[i]!);
      expect(q.x).toBeCloseTo(dst[i]!.x, 6);
      expect(q.y).toBeCloseTo(dst[i]!.y, 6);
    }
  });
});

describe("M3 done-when: decode a rotated, scaled, perspective-warped frame", () => {
  const cellSizePx = 8;

  it.each([
    {
      name: "small rotation + scale",
      dst: [
        { x: 120, y: 110 },
        { x: 660, y: 80 },
        { x: 690, y: 620 },
        { x: 90, y: 590 },
      ] as [Point, Point, Point, Point],
    },
    {
      name: "stronger perspective",
      dst: [
        { x: 150, y: 200 },
        { x: 620, y: 60 },
        { x: 690, y: 660 },
        { x: 70, y: 540 },
      ] as [Point, Point, Point, Point],
    },
  ])("$name", ({ dst }) => {
    // Render a pristine frame with a deterministic payload.
    const original = randomBytes(800, 0xfeed);
    const cells = bytesToCells(original, PALETTE_2BIT);
    const capacity = payloadCellCount(DEFAULT_GEOMETRY);
    const padded = new Uint8Array(capacity);
    padded.set(cells);
    const pristine = renderFrame(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      padded,
      cellSizePx,
    );

    // Warp it into a larger output buffer.
    const src = fiducialCanonicalCentroids(DEFAULT_GEOMETRY, cellSizePx);
    const inverse = computeHomography(dst, src);
    const warped = warpImage(pristine, inverse, 800, 720);

    // Detect + unwarp + decode.
    const decoded = decodeFrameWarped(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      warped,
      cellSizePx,
    );
    const trimmed = decoded.slice(0, cells.length);
    const restored = cellsToBytes(trimmed, PALETTE_2BIT);

    expect(restored).toEqual(original);
  });
});

/**
 * Inverse-mapped bilinear warp: for every output pixel, sample the input
 * through `inverseHomography` (warped-space → source-space). Used only by
 * tests to generate synthetic perspective-warped frames.
 */
function warpImage(
  src: RawImage,
  inverseH: Homography,
  outW: number,
  outH: number,
): RawImage {
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const p = applyHomography(inverseH, { x, y });
      const sx = p.x;
      const sy = p.y;
      const oOut = (y * outW + x) * 4;
      data[oOut + 3] = 255;
      if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) {
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const o00 = (y0 * src.width + x0) * 4;
      const o10 = o00 + 4;
      const o01 = o00 + src.width * 4;
      const o11 = o01 + 4;
      for (let c = 0; c < 3; c++) {
        const a = src.data[o00 + c]! * (1 - fx) + src.data[o10 + c]! * fx;
        const b = src.data[o01 + c]! * (1 - fx) + src.data[o11 + c]! * fx;
        data[oOut + c] = Math.round(a * (1 - fy) + b * fy);
      }
    }
  }
  return { data, width: outW, height: outH };
}
