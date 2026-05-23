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
  detectPDPs,
  decodeFrameWarpedWithDiagnostics,
  fiducialCanonicalCentroids,
  type Homography,
  otsuThreshold,
  payloadCellCount,
  payloadCellPositions,
  pdpCellColour,
  type Point,
  type RawImage,
  renderFrame,
} from "./framing";

const MAGIC = [0x50, 0x48, 0x4f, 0x54] as const;

describe("frame geometry", () => {
  it("matches the design doc cell counts after pivoting to 7×7 PDPs", () => {
    // 64*64 - 4 corners*(7*7) - 1*16 config - 2*64 calibration = 3756
    expect(payloadCellCount(DEFAULT_GEOMETRY)).toBe(3756);
  });

  it("classifies the four 7×7 corner blocks as fiducial", () => {
    expect(cellRole(DEFAULT_GEOMETRY, 0, 0)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 6, 6)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 7, 0)).not.toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 0, 7)).not.toBe("fiducial");

    expect(cellRole(DEFAULT_GEOMETRY, 57, 6)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 63, 0)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 56, 0)).not.toBe("fiducial");

    expect(cellRole(DEFAULT_GEOMETRY, 0, 63)).toBe("fiducial");
    expect(cellRole(DEFAULT_GEOMETRY, 63, 63)).toBe("fiducial");
  });

  it("classifies the config indicator strip starting just past the TL fiducial", () => {
    expect(cellRole(DEFAULT_GEOMETRY, 7, 0)).toBe("config");
    expect(cellRole(DEFAULT_GEOMETRY, 22, 0)).toBe("config");
    expect(cellRole(DEFAULT_GEOMETRY, 23, 0)).toBe("payload");
  });

  it("classifies the calibration band starting just below the fiducial row", () => {
    expect(cellRole(DEFAULT_GEOMETRY, 32, 7)).toBe("calibration");
    expect(cellRole(DEFAULT_GEOMETRY, 32, 8)).toBe("calibration");
    expect(cellRole(DEFAULT_GEOMETRY, 32, 9)).toBe("payload");
  });

  it("enumerates payload positions in row-major order", () => {
    const positions = payloadCellPositions(DEFAULT_GEOMETRY);
    expect(positions.length).toBe(3756);
    for (let i = 1; i < positions.length; i++) {
      const [x0, y0] = positions[i - 1]!;
      const [x1, y1] = positions[i]!;
      expect(y1 > y0 || (y1 === y0 && x1 > x0)).toBe(true);
    }
  });
});

describe("PDP cell colouring", () => {
  it("paints the outer ring black and the middle ring white", () => {
    // Top-left fiducial (cells 0..6, 0..6). Cross-section through row 3
    // should be ratio 1:1:3:1:1.
    expect(pdpCellColour(DEFAULT_GEOMETRY, 0, 3)).toBe("black"); // outer
    expect(pdpCellColour(DEFAULT_GEOMETRY, 1, 3)).toBe("white"); // middle
    expect(pdpCellColour(DEFAULT_GEOMETRY, 2, 3)).toBe("black"); // inner
    expect(pdpCellColour(DEFAULT_GEOMETRY, 3, 3)).toBe("black"); // inner
    expect(pdpCellColour(DEFAULT_GEOMETRY, 4, 3)).toBe("black"); // inner
    expect(pdpCellColour(DEFAULT_GEOMETRY, 5, 3)).toBe("white"); // middle
    expect(pdpCellColour(DEFAULT_GEOMETRY, 6, 3)).toBe("black"); // outer
  });

  it("paints the same pattern in all four corners", () => {
    // Centre of each PDP's inner 3×3 should be black.
    expect(pdpCellColour(DEFAULT_GEOMETRY, 3, 3)).toBe("black"); // TL
    expect(pdpCellColour(DEFAULT_GEOMETRY, 60, 3)).toBe("black"); // TR
    expect(pdpCellColour(DEFAULT_GEOMETRY, 60, 60)).toBe("black"); // BR
    expect(pdpCellColour(DEFAULT_GEOMETRY, 3, 60)).toBe("black"); // BL
    // White ring cells in each corner.
    expect(pdpCellColour(DEFAULT_GEOMETRY, 1, 1)).toBe("white"); // TL
    expect(pdpCellColour(DEFAULT_GEOMETRY, 62, 1)).toBe("white"); // TR
    expect(pdpCellColour(DEFAULT_GEOMETRY, 62, 62)).toBe("white"); // BR
    expect(pdpCellColour(DEFAULT_GEOMETRY, 1, 62)).toBe("white"); // BL
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

describe("Otsu adaptive thresholding", () => {
  it("returns -1 for a uniform image", () => {
    const img = solidImage(32, 32, 128);
    expect(otsuThreshold(img)).toBe(-1);
  });

  it("picks a threshold between two well-separated brightness modes", () => {
    // 32×32 image, half pixels at luminance ~30, half at ~210. Otsu's
    // optimum threshold should land between the two modes.
    const img = bimodalImage(32, 32, 30, 210);
    const t = otsuThreshold(img);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(210);
  });
});

describe("PDP detection", () => {
  it("finds four PDPs at the canonical positions in a pristine frame", () => {
    const cellSizePx = 8;
    const cells = new Uint8Array(payloadCellCount(DEFAULT_GEOMETRY));
    const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, cellSizePx);

    const detected = detectFiducials(img);
    expect(detected).not.toBeNull();

    // Should match the canonical positions in image-corner order. With a
    // pristine frame and no warp, image-corner order == sender-frame order.
    const canonical = fiducialCanonicalCentroids(DEFAULT_GEOMETRY, cellSizePx);
    for (let i = 0; i < 4; i++) {
      expect(detected![i]!.x).toBeCloseTo(canonical[i]!.x, 0);
      expect(detected![i]!.y).toBeCloseTo(canonical[i]!.y, 0);
    }
  });

  it("returns at least four candidates on a pristine frame, with sensible area ratios", () => {
    const cellSizePx = 8;
    const cells = new Uint8Array(payloadCellCount(DEFAULT_GEOMETRY));
    const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, cellSizePx);

    const t = otsuThreshold(img);
    const candidates = detectPDPs(img, t);
    expect(candidates.length).toBeGreaterThanOrEqual(4);

    for (const c of candidates) {
      // Canonical area ratio is 16/9 ≈ 1.78; widen for tolerance.
      expect(c.areaRatio).toBeGreaterThan(0.6);
      expect(c.areaRatio).toBeLessThan(4.0);
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
    const { warped, original } = renderWarped(dst);
    const result = decodeFrameWarped(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      warped,
      cellSizePx,
    );
    // Should land on orientation 0 — these warps are perspective only, no rotation.
    expect(result.orientation).toBe(0);
    const trimmed = result.cells.slice(0, bytesToCells(original, PALETTE_2BIT).length);
    const restored = cellsToBytes(trimmed, PALETTE_2BIT);
    expect(restored).toEqual(original);
  });
});

describe("M3.5 done-when: decode at any of the four cardinal camera orientations", () => {
  const cellSizePx = 8;

  it.each([
    { name: "upright", rotateImage: 0 },
    { name: "90° CW", rotateImage: 1 },
    { name: "180°", rotateImage: 2 },
    { name: "90° CCW", rotateImage: 3 },
  ])("$name → orientation $rotateImage", ({ rotateImage }) => {
    const dst: [Point, Point, Point, Point] = [
      { x: 120, y: 110 },
      { x: 660, y: 80 },
      { x: 690, y: 620 },
      { x: 90, y: 590 },
    ];
    const { warped, original } = renderWarped(dst);
    const rotated = rotateImageK(warped, rotateImage);

    const result = decodeFrameWarped(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      rotated,
      cellSizePx,
    );
    expect(result.orientation).toBe(rotateImage);
    const trimmed = result.cells.slice(0, bytesToCells(original, PALETTE_2BIT).length);
    const restored = cellsToBytes(trimmed, PALETTE_2BIT);
    expect(restored).toEqual(original);
  });
});

describe("PDP selection — false-positive rejection", () => {
  const cellSizePx = 8;

  it("prefers four real PDPs over a false positive sitting closer to an image corner", () => {
    // Render a perspective-warped frame, then paint a fake PDP-shaped blob
    // in the empty image area near the top-left corner — *closer to image-TL*
    // than the real TL fiducial. This is the user's M4.5-observed scenario:
    // small UI elements (page text, browser buttons) nearer an image edge
    // than the canvas's actual PDPs.
    const dst: [Point, Point, Point, Point] = [
      { x: 120, y: 110 },
      { x: 660, y: 80 },
      { x: 690, y: 620 },
      { x: 90, y: 590 },
    ];
    const { warped, original } = renderWarped(dst);

    const fakeCX = 50;
    const fakeCY = 50; // closer to image-TL (0,0) than the real TL at (120,110)
    paintFakePDP(warped, fakeCX, fakeCY, 14, 8);

    const result = decodeFrameWarped(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      warped,
      cellSizePx,
    );
    expect(result.orientation).toBe(0);
    const trimmed = result.cells.slice(0, bytesToCells(original, PALETTE_2BIT).length);
    expect(cellsToBytes(trimmed, PALETTE_2BIT)).toEqual(original);

    // Confirm the fake was a viable candidate (i.e. the test actually
    // exercises the selector, not just "detector ignored it").
    const dx = decodeFrameWarpedWithDiagnostics(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      warped,
      cellSizePx,
    );
    const sawFake = dx.detection.allCandidates.some(
      (c) =>
        Math.abs(c.centroid.x - fakeCX) < 25 &&
        Math.abs(c.centroid.y - fakeCY) < 25,
    );
    expect(sawFake).toBe(true);

    // And the chosen four should NOT include the fake.
    const chosenIncludesFake = dx.detection.chosen!.some(
      (p) => Math.abs(p.x - fakeCX) < 25 && Math.abs(p.y - fakeCY) < 25,
    );
    expect(chosenIncludesFake).toBe(false);
  });
});

/**
 * Paint a fake PDP-shaped pattern (white ring around a dark centre) onto
 * the image at (cx, cy). Used by the false-positive rejection test to
 * inject a structurally-PDP-like artefact that the selector must reject.
 */
function paintFakePDP(
  img: RawImage,
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
): void {
  for (let dy = -outerRadius; dy <= outerRadius; dy++) {
    for (let dx = -outerRadius; dx <= outerRadius; dx++) {
      const r2 = dx * dx + dy * dy;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const o = (y * img.width + x) * 4;
      if (r2 <= innerRadius * innerRadius) {
        img.data[o] = 0;
        img.data[o + 1] = 0;
        img.data[o + 2] = 0;
      } else if (r2 <= outerRadius * outerRadius) {
        img.data[o] = 255;
        img.data[o + 1] = 255;
        img.data[o + 2] = 255;
      }
      img.data[o + 3] = 255;
    }
  }
}

describe("M5 done-when: decode under simulated lighting shifts", () => {
  const cellSizePx = 8;
  // A mild perspective warp shared across all the lighting shifts below.
  const dst: [Point, Point, Point, Point] = [
    { x: 120, y: 110 },
    { x: 660, y: 80 },
    { x: 690, y: 620 },
    { x: 90, y: 590 },
  ];

  it.each([
    {
      name: "warm light (R↑, B↓) — would break a static-palette classifier",
      // Reduces blue channel enough that palette[3] = (0, 0, 255) lands at
      // (0, 0, 102) in the camera image — closer to (0, 0, 0) than (0, 0, 255).
      // Without M5 the magic check would fail (the magic has blue cells).
      shift: { rMul: 1.0, rBias: 0, gMul: 1.0, gBias: 0, bMul: 0.4, bBias: 0 },
    },
    {
      name: "cool light (B↑, R↓)",
      shift: { rMul: 0.6, rBias: 20, gMul: 1.0, gBias: 0, bMul: 1.0, bBias: 0 },
    },
    {
      name: "dim mixed light (all channels reduced + slight per-channel bias)",
      shift: { rMul: 0.55, rBias: 10, gMul: 0.6, gBias: 5, bMul: 0.5, bBias: 8 },
    },
  ])("$name", ({ shift }) => {
    const { warped, original } = renderWarped(dst);
    applyColourShift(warped, shift);

    const result = decodeFrameWarped(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      warped,
      cellSizePx,
    );
    expect(result.orientation).toBe(0);
    expect(result.learnedPalette.colors.length).toBe(PALETTE_2BIT.colors.length);
    const trimmed = result.cells.slice(0, bytesToCells(original, PALETTE_2BIT).length);
    expect(cellsToBytes(trimmed, PALETTE_2BIT)).toEqual(original);
  });

  it("surfaces the learned palette in WarpedDecodeResult so the receiver UI can show it", () => {
    const { warped } = renderWarped(dst);
    applyColourShift(warped, { rMul: 1.0, rBias: 0, gMul: 1.0, gBias: 0, bMul: 0.4, bBias: 0 });
    const result = decodeFrameWarped(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      warped,
      cellSizePx,
    );
    // Learned palette's blue should be the shifted blue (~0, ~0, ~102),
    // dramatically different from the canonical (0, 0, 255).
    const learnedBlue = result.learnedPalette.colors[3]!;
    expect(learnedBlue[2]).toBeLessThan(150); // canonical was 255, observed should be ~102
    expect(learnedBlue[0]).toBeLessThan(40); // R stays near 0
    expect(learnedBlue[1]).toBeLessThan(40); // G stays near 0
  });
});

/**
 * Apply a per-channel linear colour transform to an image in place. Used
 * by M5 tests to simulate lighting conditions a camera would impose.
 *   newR = clamp(rMul * R + rBias, 0..255)  (and same for G, B)
 */
function applyColourShift(
  img: RawImage,
  shift: { rMul: number; rBias: number; gMul: number; gBias: number; bMul: number; bBias: number },
): void {
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i]! * shift.rMul + shift.rBias;
    const g = img.data[i + 1]! * shift.gMul + shift.gBias;
    const b = img.data[i + 2]! * shift.bMul + shift.bBias;
    img.data[i] = Math.max(0, Math.min(255, Math.round(r)));
    img.data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
    img.data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Build a payload whose first 4 bytes are the PHOT magic, with the rest
 * pseudo-random and deterministic from a seed. Used by every warped-decode
 * test, since `decodeFrameWarped` now recovers orientation by validating
 * the magic at the start of the byte stream.
 */
function makeMagicPayload(byteCount: number, seed: number): Uint8Array {
  const out = randomBytes(byteCount, seed);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC[i]!;
  return out;
}

/**
 * Render a frame with magic-prefixed payload, then warp it into a 800×720
 * output buffer using `dst` as the warped fiducial centroids.
 */
function renderWarped(
  dst: [Point, Point, Point, Point],
): { warped: RawImage; original: Uint8Array } {
  const cellSizePx = 8;
  const original = makeMagicPayload(800, 0xfeed);
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
  const src = fiducialCanonicalCentroids(DEFAULT_GEOMETRY, cellSizePx);
  const inverse = computeHomography(dst, src);
  const warped = warpImage(pristine, inverse, 800, 720);
  return { warped, original };
}

/**
 * Rotate an image by k * 90° clockwise. k in 0..3.
 * Used to simulate the camera being held at different cardinal orientations.
 */
function rotateImageK(src: RawImage, k: number): RawImage {
  k = ((k % 4) + 4) % 4;
  if (k === 0) return src;
  const w = src.width;
  const h = src.height;
  const newW = k % 2 === 0 ? w : h;
  const newH = k % 2 === 0 ? h : w;
  const data = new Uint8ClampedArray(newW * newH * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = x;
      let ny = y;
      if (k === 1) { // 90° CW
        nx = h - 1 - y;
        ny = x;
      } else if (k === 2) { // 180°
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else if (k === 3) { // 270° CW = 90° CCW
        nx = y;
        ny = w - 1 - x;
      }
      const o = (y * w + x) * 4;
      const no = (ny * newW + nx) * 4;
      data[no] = src.data[o]!;
      data[no + 1] = src.data[o + 1]!;
      data[no + 2] = src.data[o + 2]!;
      data[no + 3] = src.data[o + 3]!;
    }
  }
  return { data, width: newW, height: newH };
}

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

function solidImage(w: number, h: number, luminance: number): RawImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = luminance;
    data[i + 1] = luminance;
    data[i + 2] = luminance;
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

function bimodalImage(w: number, h: number, dark: number, bright: number): RawImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    const v = (i / 4) % 2 === 0 ? dark : bright;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

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


describe("M4.5 decodeFrameWarpedWithDiagnostics", () => {
  const cellSizePx = 8;

  it("returns the same decode + a populated diagnostics struct on success", () => {
    const dst: [Point, Point, Point, Point] = [
      { x: 120, y: 110 },
      { x: 660, y: 80 },
      { x: 690, y: 620 },
      { x: 90, y: 590 },
    ];
    const { warped, original } = renderWarped(dst);

    const d = decodeFrameWarpedWithDiagnostics(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      warped,
      cellSizePx,
    );

    expect(d.failureReason).toBeNull();
    expect(d.result).not.toBeNull();
    expect(d.detection.otsuThreshold).toBeGreaterThanOrEqual(0);
    expect(d.detection.chosen).not.toBeNull();
    expect(d.detection.allCandidates.length).toBeGreaterThanOrEqual(4);
    expect(d.rotationsAttempted.length).toBeGreaterThan(0);
    const matchedRotations = d.rotationsAttempted.filter((r) => r.matched);
    expect(matchedRotations.length).toBe(1);
    expect(matchedRotations[0]!.rotation).toBe(d.result!.orientation);

    // The decoded cells should still recover the original payload.
    const trimmed = d.result!.cells.slice(0, bytesToCells(original, PALETTE_2BIT).length);
    expect(cellsToBytes(trimmed, PALETTE_2BIT)).toEqual(original);
  });

  it("surfaces a failureReason and no result for an image with no PDPs", () => {
    const img = solidImage(800, 600, 100);
    const d = decodeFrameWarpedWithDiagnostics(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      img,
      cellSizePx,
    );
    expect(d.result).toBeNull();
    expect(d.failureReason).toBeTruthy();
    expect(d.detection.chosen).toBeNull();
  });

  it("records each rotation's sampled magic bytes when detection succeeds but no rotation matches", () => {
    // Render a frame with garbage (no magic) and decode. PDPs will be found
    // but no rotation will match the magic.
    const cellSizePx2 = 8;
    const capacity = payloadCellCount(DEFAULT_GEOMETRY);
    const cells = new Uint8Array(capacity);
    for (let i = 0; i < capacity; i++) cells[i] = (i * 3 + 7) & 0x3; // not PHOT
    const pristine = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, cellSizePx2);

    const d = decodeFrameWarpedWithDiagnostics(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      pristine,
      cellSizePx2,
    );
    expect(d.result).toBeNull();
    expect(d.detection.chosen).not.toBeNull();
    expect(d.rotationsAttempted.length).toBe(4);
    expect(d.rotationsAttempted.every((r) => !r.matched)).toBe(true);
    // All four magic-byte samples should be 4 bytes long.
    for (const attempt of d.rotationsAttempted) {
      expect(attempt.magicBytes.length).toBe(4);
    }
  });
});
