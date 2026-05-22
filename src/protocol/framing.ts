/**
 * Framing: the visual layout rendered to the screen and the geometric
 * machinery for finding it again in a (possibly warped) image.
 *
 * Cell roles:
 *   - fiducial markers in each corner — outer ring uses palette colour 0
 *     (black); inner 2×2 uses a *non-palette* marker colour (pure white)
 *     so the receiver can locate fiducials with a single colour test, even
 *     when payload cells share the palette
 *   - config indicator (decoded with worst-case parameters; placeholder for now)
 *   - calibration strip (palette samples for per-frame classifier training)
 *   - payload grid
 *
 * Pristine decode (`decodeFrame`) is for axis-aligned images.
 * Warped decode (`decodeFrameWarped`) detects fiducial centroids, solves the
 * canonical→image homography, and samples each cell at the warped position
 * of its canonical centre.
 */

import type { Palette } from "./codec";

export interface FrameGeometry {
  cellsX: number;
  cellsY: number;
  fiducialSize: number;
  configRow: number;
  configColStart: number;
  configWidth: number;
  calibrationRowStart: number;
  calibrationHeight: number;
}

export const DEFAULT_GEOMETRY: FrameGeometry = {
  cellsX: 64,
  cellsY: 64,
  fiducialSize: 4,
  configRow: 0,
  configColStart: 4,
  configWidth: 16,
  calibrationRowStart: 4,
  calibrationHeight: 2,
};

/** Non-palette marker colour for fiducial inner squares. */
export const FIDUCIAL_MARKER_RGB: readonly [number, number, number] = [
  255, 255, 255,
];

export type CellRole = "payload" | "fiducial" | "config" | "calibration";

export function cellRole(
  g: FrameGeometry,
  x: number,
  y: number,
): CellRole {
  const left = x < g.fiducialSize;
  const right = x >= g.cellsX - g.fiducialSize;
  const top = y < g.fiducialSize;
  const bottom = y >= g.cellsY - g.fiducialSize;
  if ((left || right) && (top || bottom)) return "fiducial";

  if (
    y === g.configRow &&
    x >= g.configColStart &&
    x < g.configColStart + g.configWidth
  ) {
    return "config";
  }

  if (
    y >= g.calibrationRowStart &&
    y < g.calibrationRowStart + g.calibrationHeight
  ) {
    return "calibration";
  }

  return "payload";
}

/**
 * Returns true if (x, y) is in the inner 2×2 of one of the four corner
 * fiducials — i.e., the cell should be painted with the marker colour.
 */
export function isFiducialMarkerCell(
  g: FrameGeometry,
  x: number,
  y: number,
): boolean {
  if (cellRole(g, x, y) !== "fiducial") return false;
  const fs = g.fiducialSize;
  let baseX = 0;
  let baseY = 0;
  if (x >= g.cellsX - fs) baseX = g.cellsX - fs;
  if (y >= g.cellsY - fs) baseY = g.cellsY - fs;
  const lx = x - baseX;
  const ly = y - baseY;
  return lx >= 1 && lx <= fs - 2 && ly >= 1 && ly <= fs - 2;
}

export function payloadCellPositions(
  g: FrameGeometry,
): Array<readonly [number, number]> {
  const positions: Array<readonly [number, number]> = [];
  for (let y = 0; y < g.cellsY; y++) {
    for (let x = 0; x < g.cellsX; x++) {
      if (cellRole(g, x, y) === "payload") positions.push([x, y]);
    }
  }
  return positions;
}

export function payloadCellCount(g: FrameGeometry): number {
  return payloadCellPositions(g).length;
}

export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function frameWidthPx(g: FrameGeometry, cellSizePx: number): number {
  return g.cellsX * cellSizePx;
}

export function frameHeightPx(g: FrameGeometry, cellSizePx: number): number {
  return g.cellsY * cellSizePx;
}

/**
 * Canonical (un-warped) image-space centroid of each fiducial inner-marker
 * cluster, ordered top-left, top-right, bottom-right, bottom-left.
 *
 * The inner 2×2 marker spans pixels [cs, (fs-1)·cs) in each axis on the
 * top-left fiducial, so its discrete pixel centroid is at
 * (cs + (fs-1)·cs − 1)/2 = (fs·cs − 1)/2 — half a pixel "before" the cell
 * boundary, because we're averaging integer pixel coordinates.
 */
export function fiducialCanonicalCentroids(
  g: FrameGeometry,
  cellSizePx: number,
): [Point, Point, Point, Point] {
  const fs = g.fiducialSize;
  const c = (fs / 2) * cellSizePx - 0.5;
  const right = (g.cellsX - fs / 2) * cellSizePx - 0.5;
  const bottom = (g.cellsY - fs / 2) * cellSizePx - 0.5;
  return [
    { x: c, y: c },
    { x: right, y: c },
    { x: right, y: bottom },
    { x: c, y: bottom },
  ];
}

function fillRect(
  img: RawImage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: readonly [number, number, number],
): void {
  const [r, g, b] = rgb;
  for (let py = y; py < y + h; py++) {
    const rowStart = (py * img.width + x) * 4;
    for (let px = 0; px < w; px++) {
      const o = rowStart + px * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
}

export function renderFrame(
  g: FrameGeometry,
  palette: Palette,
  payloadCells: Uint8Array,
  cellSizePx: number,
): RawImage {
  const expected = payloadCellCount(g);
  if (payloadCells.length !== expected) {
    throw new Error(
      `renderFrame: payloadCells.length=${payloadCells.length}, expected ${expected}`,
    );
  }
  const width = frameWidthPx(g, cellSizePx);
  const height = frameHeightPx(g, cellSizePx);
  const data = new Uint8ClampedArray(width * height * 4);
  const img: RawImage = { data, width, height };

  let payloadIdx = 0;
  for (let cy = 0; cy < g.cellsY; cy++) {
    for (let cx = 0; cx < g.cellsX; cx++) {
      const role = cellRole(g, cx, cy);
      const px = cx * cellSizePx;
      const py = cy * cellSizePx;
      let rgb: readonly [number, number, number];
      switch (role) {
        case "payload":
          rgb = palette.colors[payloadCells[payloadIdx++]!]!;
          break;
        case "fiducial":
          rgb = isFiducialMarkerCell(g, cx, cy)
            ? FIDUCIAL_MARKER_RGB
            : palette.colors[0]!;
          break;
        case "config":
          rgb = palette.colors[0]!;
          break;
        case "calibration":
          rgb = palette.colors[cx % palette.colors.length]!;
          break;
      }
      fillRect(img, px, py, cellSizePx, cellSizePx, rgb);
    }
  }
  return img;
}

/**
 * Decode a pristine, axis-aligned frame. No fiducial detection. Used by M1
 * tests and as a fallback when no warp is expected.
 */
export function decodeFrame(
  g: FrameGeometry,
  palette: Palette,
  img: RawImage,
  cellSizePx: number,
): Uint8Array {
  const expectedW = frameWidthPx(g, cellSizePx);
  const expectedH = frameHeightPx(g, cellSizePx);
  if (img.width !== expectedW || img.height !== expectedH) {
    throw new Error(
      `decodeFrame: image is ${img.width}x${img.height}, expected ${expectedW}x${expectedH}`,
    );
  }
  const positions = payloadCellPositions(g);
  const out = new Uint8Array(positions.length);
  const half = Math.floor(cellSizePx / 2);

  for (let i = 0; i < positions.length; i++) {
    const [cx, cy] = positions[i]!;
    const px = cx * cellSizePx + half;
    const py = cy * cellSizePx + half;
    out[i] = sampleNearestPalette(img, palette, px, py);
  }
  return out;
}

// -----------------------------------------------------------------------
// M3: fiducial detection, homography, warped decode
// -----------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/**
 * Find the four fiducial centroids in an image. Returns null if detection
 * fails (e.g., < 4 candidate clusters survive filtering).
 *
 * Looks for connected components of the non-palette marker colour (white).
 * Because the marker colour is not in the palette, payload cells can never
 * be confused with fiducials.
 */
export function detectFiducials(
  img: RawImage,
  expectedClusterSizePx: number,
): [Point, Point, Point, Point] | null {
  const components = findMarkerComponents(img);
  // We expect each fiducial cluster to be ~`expectedClusterSizePx`² pixels;
  // perspective warps can shrink one corner and grow another, so the filter
  // is intentionally wide: 1/8× to 9× the expected area.
  const expectedArea = expectedClusterSizePx * expectedClusterSizePx;
  const minArea = expectedArea / 8;
  const maxArea = expectedArea * 9;
  const filtered = components.filter(
    (c) => c.pixelCount >= minArea && c.pixelCount <= maxArea,
  );
  if (filtered.length < 4) return null;

  // For each image corner, take the candidate closest to it (in Manhattan
  // distance). Robust to spurious mid-image white blobs that survive size
  // filtering — what matters is which corner each fiducial owns.
  const w = img.width;
  const h = img.height;
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const picks: Point[] = [];
  const used = new Set<number>();
  for (const corner of corners) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < filtered.length; i++) {
      if (used.has(i)) continue;
      const c = filtered[i]!.centroid;
      const d = Math.abs(c.x - corner.x) + Math.abs(c.y - corner.y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return null;
    used.add(bestIdx);
    picks.push(filtered[bestIdx]!.centroid);
  }
  return [picks[0]!, picks[1]!, picks[2]!, picks[3]!];
}

interface Component {
  centroid: Point;
  pixelCount: number;
}

function isMarkerPixel(img: RawImage, x: number, y: number): boolean {
  const o = (y * img.width + x) * 4;
  // Loose threshold so bilinear-interpolated edge pixels after warping still
  // register as marker.
  return img.data[o]! > 200 && img.data[o + 1]! > 200 && img.data[o + 2]! > 200;
}

function findMarkerComponents(img: RawImage): Component[] {
  const w = img.width;
  const h = img.height;
  const visited = new Uint8Array(w * h);
  const components: Component[] = [];
  // Stack-based flood fill using a Uint32Array buffer to avoid per-pixel
  // array allocation cost.
  const stack = new Uint32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const seed = y * w + x;
      if (visited[seed] || !isMarkerPixel(img, x, y)) continue;
      let sp = 0;
      stack[sp++] = seed;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      while (sp > 0) {
        const idx = stack[--sp]!;
        if (visited[idx]) continue;
        visited[idx] = 1;
        const px = idx % w;
        const py = (idx / w) | 0;
        if (!isMarkerPixel(img, px, py)) continue;
        sumX += px;
        sumY += py;
        count++;
        if (px + 1 < w) stack[sp++] = idx + 1;
        if (px > 0) stack[sp++] = idx - 1;
        if (py + 1 < h) stack[sp++] = idx + w;
        if (py > 0) stack[sp++] = idx - w;
      }
      if (count > 0) {
        components.push({
          centroid: { x: sumX / count, y: sumY / count },
          pixelCount: count,
        });
      }
    }
  }
  return components;
}

export interface Homography {
  /** 3×3 matrix, row-major. */
  m: Float64Array;
}

/**
 * Solve the homography that maps the four source points to the four
 * destination points: dst ≅ H · src (with the third coordinate = 1).
 *
 * Standard 8-equation direct linear solve, setting h33 = 1.
 * 4 point pairs → 8 equations, 8 unknowns. We solve via Gaussian elimination.
 */
export function computeHomography(
  src: readonly [Point, Point, Point, Point],
  dst: readonly [Point, Point, Point, Point],
): Homography {
  // Build the 8×9 augmented matrix (8 unknowns + 1 rhs column).
  const a = new Float64Array(8 * 9);
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: X, y: Y } = dst[i]!;
    const r1 = i * 2;
    const r2 = i * 2 + 1;
    a[r1 * 9 + 0] = x;
    a[r1 * 9 + 1] = y;
    a[r1 * 9 + 2] = 1;
    a[r1 * 9 + 3] = 0;
    a[r1 * 9 + 4] = 0;
    a[r1 * 9 + 5] = 0;
    a[r1 * 9 + 6] = -X * x;
    a[r1 * 9 + 7] = -X * y;
    a[r1 * 9 + 8] = X;

    a[r2 * 9 + 0] = 0;
    a[r2 * 9 + 1] = 0;
    a[r2 * 9 + 2] = 0;
    a[r2 * 9 + 3] = x;
    a[r2 * 9 + 4] = y;
    a[r2 * 9 + 5] = 1;
    a[r2 * 9 + 6] = -Y * x;
    a[r2 * 9 + 7] = -Y * y;
    a[r2 * 9 + 8] = Y;
  }

  // Gauss-Jordan elimination with partial pivoting.
  const n = 8;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    let maxAbs = Math.abs(a[i * 9 + i]!);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(a[r * 9 + i]!);
      if (v > maxAbs) {
        maxAbs = v;
        pivot = r;
      }
    }
    if (maxAbs < 1e-12) {
      throw new Error("computeHomography: singular system");
    }
    if (pivot !== i) {
      for (let c = 0; c < 9; c++) {
        const tmp = a[i * 9 + c]!;
        a[i * 9 + c] = a[pivot * 9 + c]!;
        a[pivot * 9 + c] = tmp;
      }
    }
    const pv = a[i * 9 + i]!;
    for (let c = i; c < 9; c++) a[i * 9 + c]! /= pv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r * 9 + i]!;
      if (f === 0) continue;
      for (let c = i; c < 9; c++) {
        a[r * 9 + c]! -= f * a[i * 9 + c]!;
      }
    }
  }

  const h = new Float64Array(9);
  for (let i = 0; i < 8; i++) h[i] = a[i * 9 + 8]!;
  h[8] = 1;
  return { m: h };
}

export function applyHomography(h: Homography, p: Point): Point {
  const m = h.m;
  const w = m[6]! * p.x + m[7]! * p.y + m[8]!;
  const x = (m[0]! * p.x + m[1]! * p.y + m[2]!) / w;
  const y = (m[3]! * p.x + m[4]! * p.y + m[5]!) / w;
  return { x, y };
}

/**
 * Decode a frame after detecting fiducials and applying the
 * canonical→image perspective transform.
 *
 * `cellSizePx` is the cell size in the *canonical* (un-warped) coordinate
 * space — the same value passed to renderFrame originally.
 */
export function decodeFrameWarped(
  g: FrameGeometry,
  palette: Palette,
  img: RawImage,
  cellSizePx: number,
): Uint8Array {
  const fiducials = detectFiducials(img, cellSizePx * 2);
  if (!fiducials) {
    throw new Error("decodeFrameWarped: fiducial detection failed");
  }
  const canonical = fiducialCanonicalCentroids(g, cellSizePx);
  const h = computeHomography(canonical, fiducials);

  const positions = payloadCellPositions(g);
  const out = new Uint8Array(positions.length);
  const half = cellSizePx / 2;
  for (let i = 0; i < positions.length; i++) {
    const [cx, cy] = positions[i]!;
    const warped = applyHomography(h, {
      x: cx * cellSizePx + half,
      y: cy * cellSizePx + half,
    });
    const px = Math.round(warped.x);
    const py = Math.round(warped.y);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) {
      // Cell sampled outside the image — leave as 0. Real receivers will
      // mark this for ECC / retransmission.
      out[i] = 0;
      continue;
    }
    out[i] = sampleNearestPalette(img, palette, px, py);
  }
  return out;
}

function sampleNearestPalette(
  img: RawImage,
  palette: Palette,
  x: number,
  y: number,
): number {
  const o = (y * img.width + x) * 4;
  const r = img.data[o]!;
  const g = img.data[o + 1]!;
  const b = img.data[o + 2]!;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.colors.length; i++) {
    const [pr, pg, pb] = palette.colors[i]!;
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}
