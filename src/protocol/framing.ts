/**
 * Framing — frame layout, rendering, and the M3.5 robust detection pipeline.
 *
 * Cell roles:
 *   - fiducial — corner Position Detection Patterns (PDPs), 7×7 cells each,
 *     rendered as three concentric rings: black outer / white middle / black
 *     inner 3×3 (1:1:3:1:1 cross-section ratio, identical to QR codes' finder
 *     patterns)
 *   - config indicator (decoded with worst-case parameters; placeholder for now)
 *   - calibration strip (palette samples for per-frame classifier training)
 *   - payload grid
 *
 * Detection (M3.5):
 *   1. Otsu's method picks a per-frame brightness threshold from the
 *      luminance histogram, replacing the old fixed >200 constant. Survives
 *      indoor/outdoor lighting changes transparently.
 *   2. Connected components of "above threshold" and "below threshold" pixels
 *      are computed. A real PDP shows up as a dark inner cluster fully
 *      enclosed by a white ring, with the two areas in roughly 9:16 ratio
 *      (the canonical 3×3 black centre vs. 16-cell white ring).
 *   3. We pick the 4 PDPs closest to the image corners and try all 4
 *      rotational assignments to canonical TL/TR/BR/BL; the rotation whose
 *      first 16 payload cells decode to the "PHOT" magic wins. False-positive
 *      probability per non-matching rotation is 2⁻³².
 */

import type { Palette } from "./codec";
import { bitsPerCell, cellsToBytes } from "./codec";

// =========================================================================
// Geometry
// =========================================================================

export interface FrameGeometry {
  cellsX: number;
  cellsY: number;
  /** PDP side length in cells. M3.5: 7 (QR-style 1:1:3:1:1). */
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
  fiducialSize: 7,
  configRow: 0,
  configColStart: 7,
  configWidth: 16,
  calibrationRowStart: 7,
  calibrationHeight: 2,
};

/** Non-palette marker colour for the PDPs' white middle ring. */
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
 * For a cell inside a corner PDP, return the colour role:
 *  - "black" for the outer ring (distance 0 from PDP edge) and the inner 3×3 centre (distance >= 2)
 *  - "white" for the middle ring (distance 1) — the only cells painted in the non-palette marker colour
 *
 * Caller must have already verified `cellRole(g, x, y) === "fiducial"`.
 * Returns "black" for non-fiducial cells (defensive but not relied on).
 */
export function pdpCellColour(
  g: FrameGeometry,
  x: number,
  y: number,
): "black" | "white" {
  const fs = g.fiducialSize;
  let baseX = 0;
  let baseY = 0;
  if (x >= g.cellsX - fs) baseX = g.cellsX - fs;
  if (y >= g.cellsY - fs) baseY = g.cellsY - fs;
  const lx = x - baseX;
  const ly = y - baseY;
  if (lx < 0 || lx >= fs || ly < 0 || ly >= fs) return "black";
  const distToEdge = Math.min(lx, ly, fs - 1 - lx, fs - 1 - ly);
  return distToEdge === 1 ? "white" : "black";
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
 * Canonical (un-warped) image-space centroid of each PDP, ordered TL/TR/BR/BL.
 * The PDP centroid is the centre of its 3×3 inner-black region, which for a
 * fiducial occupying cells [0, fs) is at pixel ((fs·cellSizePx)/2 − 0.5).
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

// =========================================================================
// Rendering
// =========================================================================

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
          rgb =
            pdpCellColour(g, cx, cy) === "white"
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
 * unit tests where the canvas and the decoder share the exact same geometry.
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

/**
 * 4-bit-per-channel pre-quantized LUT: 16×16×16 = 4096 entries, each
 * holding the palette index whose colour is closest (Euclidean RGB
 * distance) to the centre of that bucket. The table is built once per
 * (palette reference) and amortizes the per-cell distance math across
 * the lifetime of the session.
 *
 * Measurable speedup vs the per-cell distance loop: ~6-10× on a stock
 * laptop for the 2-bit palette (M15 bench).
 */
const paletteLutCache = new WeakMap<Palette, Uint8Array>();

function paletteLut(palette: Palette): Uint8Array {
  const cached = paletteLutCache.get(palette);
  if (cached) return cached;
  const lut = new Uint8Array(4096);
  const C = palette.colors;
  for (let qr = 0; qr < 16; qr++) {
    const cr = (qr << 4) | 0x08;
    for (let qg = 0; qg < 16; qg++) {
      const cg = (qg << 4) | 0x08;
      for (let qb = 0; qb < 16; qb++) {
        const cb = (qb << 4) | 0x08;
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < C.length; i++) {
          const [pr, pg, pb] = C[i]!;
          const dr = cr - pr;
          const dg = cg - pg;
          const db = cb - pb;
          const d = dr * dr + dg * dg + db * db;
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        lut[(qr << 8) | (qg << 4) | qb] = bestIdx;
      }
    }
  }
  paletteLutCache.set(palette, lut);
  return lut;
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
  const lut = paletteLut(palette);
  return lut[((r & 0xf0) << 4) | (g & 0xf0) | (b >>> 4)]!;
}

// =========================================================================
// Homography (4-point projective solve)
// =========================================================================

export interface Point {
  x: number;
  y: number;
}

export interface Homography {
  /** 3×3 matrix, row-major. */
  m: Float64Array;
}

export function computeHomography(
  src: readonly [Point, Point, Point, Point],
  dst: readonly [Point, Point, Point, Point],
): Homography {
  const a = new Float64Array(8 * 9);
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: X, y: Y } = dst[i]!;
    const r1 = i * 2;
    const r2 = i * 2 + 1;
    a[r1 * 9 + 0] = x;
    a[r1 * 9 + 1] = y;
    a[r1 * 9 + 2] = 1;
    a[r1 * 9 + 6] = -X * x;
    a[r1 * 9 + 7] = -X * y;
    a[r1 * 9 + 8] = X;

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

// =========================================================================
// M3.5: Otsu adaptive thresholding
// =========================================================================

/**
 * Otsu's method: pick the brightness threshold that maximises the
 * between-class variance of dark vs. bright pixels in the image's luminance
 * histogram. Returns a value in [0, 255], or -1 if the image is uniform.
 *
 * Luminance is the standard Rec. 601 weighting `0.299R + 0.587G + 0.114B`
 * (computed in integer arithmetic to avoid float overhead in the inner loop).
 */
export function otsuThreshold(img: RawImage): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i]!;
    const g = img.data[i + 1]!;
    const b = img.data[i + 2]!;
    const y = (299 * r + 587 * g + 114 * b + 500) / 1000 | 0;
    hist[y]!++;
  }
  const total = (img.data.length / 4) | 0;

  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]!;

  let sumB = 0;
  let wB = 0;
  let maxBetween = -1;
  let bestT = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF <= 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxBetween) {
      maxBetween = between;
      bestT = t;
    }
  }
  return bestT;
}

// =========================================================================
// M3.5: PDP detection
// =========================================================================

interface Component {
  centroid: Point;
  pixelCount: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Compute luminance of a single pixel using the same Rec. 601 weighting
 * Otsu uses, so threshold comparisons are consistent.
 */
function luminance(img: RawImage, x: number, y: number): number {
  const o = (y * img.width + x) * 4;
  const r = img.data[o]!;
  const g = img.data[o + 1]!;
  const b = img.data[o + 2]!;
  return ((299 * r + 587 * g + 114 * b + 500) / 1000) | 0;
}

/**
 * Iterative 4-connected flood-fill of pixels matching `predicate(x, y)`.
 * Re-used for finding both bright and dark connected components.
 */
function findComponents(
  img: RawImage,
  predicate: (x: number, y: number) => boolean,
): Component[] {
  const w = img.width;
  const h = img.height;
  const visited = new Uint8Array(w * h);
  const stack = new Uint32Array(w * h);
  const components: Component[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const seed = y * w + x;
      if (visited[seed] || !predicate(x, y)) continue;
      let sp = 0;
      stack[sp++] = seed;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (sp > 0) {
        const idx = stack[--sp]!;
        if (visited[idx]) continue;
        visited[idx] = 1;
        const px = idx % w;
        const py = (idx / w) | 0;
        if (!predicate(px, py)) continue;
        sumX += px;
        sumY += py;
        count++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (px + 1 < w) stack[sp++] = idx + 1;
        if (px > 0) stack[sp++] = idx - 1;
        if (py + 1 < h) stack[sp++] = idx + w;
        if (py > 0) stack[sp++] = idx - w;
      }
      if (count > 0) {
        components.push({
          centroid: { x: sumX / count, y: sumY / count },
          pixelCount: count,
          minX,
          maxX,
          minY,
          maxY,
        });
      }
    }
  }
  return components;
}

export interface PDPCandidate {
  centroid: Point;
  whiteRingArea: number;
  blackCentreArea: number;
  /** Ratio whiteRingArea / blackCentreArea — should be near 16/9 ≈ 1.78 for a clean PDP. */
  areaRatio: number;
}

/**
 * Find Position Detection Pattern candidates: pairs of a bright (above-Otsu)
 * connected component (the white middle ring) and a dark (below-Otsu)
 * connected component (the inner 3×3 black centre) whose bounding boxes nest
 * correctly and whose area ratio is in the expected range.
 *
 * Canonical area ratio: 16 white cells / 9 black centre cells = 1.78. The
 * tolerance is intentionally wide (0.6× to 4×) because partial pixels at
 * boundaries and bilinear smearing under warp distort the discrete counts.
 */
/**
 * Verify the 1:1:3:1:1 cross-section ratio through a candidate PDP centroid.
 *
 * Every real PDP has the same structural signature: a centred line through
 * its 3×3 inner-black square, then the 1-cell white middle ring on each
 * side, then the 1-cell outer black ring. So along any line through the
 * centre — horizontal or vertical — the band widths form a 1:1:3:1:1
 * ratio (`dark:light:dark:light:dark`).
 *
 * This is the structural property the flood-fill localiser tests by proxy
 * (nested bbox + area ratio). The proxy lets some false positives through:
 * a small UI shape with a dark blob inside a bright frame on a dark page
 * can satisfy nested bbox + area ratio without actually having the
 * 1:1:3:1:1 widths. The cross-section check rejects those decisively.
 *
 * Implementation walks from the centroid outward in four cardinal
 * directions, counting consecutive pixels above/below the Otsu threshold.
 * Each non-centre band must be in the tolerance range `[0.4, 2.0]` of
 * the canonical "1 unit" (one third of the centre dark band's width).
 * Tolerance is loose enough to absorb mild perspective warp; tight enough
 * that arbitrary UI shapes don't pass.
 *
 * The outer dark band is only required to *reach* one canonical unit
 * (no upper bound). Beyond the outer ring we re-enter sender-frame
 * content of unpredictable colour — the walk's terminating condition
 * is intentionally permissive to handle that.
 */
function verifyCrossSection(
  img: RawImage,
  centroid: Point,
  threshold: number,
): boolean {
  const cx = Math.round(centroid.x);
  const cy = Math.round(centroid.y);
  if (cx < 0 || cy < 0 || cx >= img.width || cy >= img.height) return false;
  if (luminance(img, cx, cy) > threshold) return false; // centre must be dark
  return (
    checkCrossAxis(img, cx, cy, threshold, 1, 0) &&
    checkCrossAxis(img, cx, cy, threshold, 0, 1)
  );
}

function checkCrossAxis(
  img: RawImage,
  cx: number,
  cy: number,
  threshold: number,
  dx: number,
  dy: number,
): boolean {
  // The four band widths along this axis, walking out from the centre.
  const leftDark = countWhile(img, cx - dx, cy - dy, -dx, -dy, threshold, true);
  const rightDark = countWhile(img, cx + dx, cy + dy, dx, dy, threshold, true);
  const centerWidth = leftDark + 1 + rightDark;
  if (centerWidth < 3) return false; // too small to be a meaningful PDP

  const leftLightStartX = cx - (leftDark + 1) * dx;
  const leftLightStartY = cy - (leftDark + 1) * dy;
  const leftLight = countWhile(img, leftLightStartX, leftLightStartY, -dx, -dy, threshold, false);

  const rightLightStartX = cx + (rightDark + 1) * dx;
  const rightLightStartY = cy + (rightDark + 1) * dy;
  const rightLight = countWhile(img, rightLightStartX, rightLightStartY, dx, dy, threshold, false);

  // Cap the outer-dark walk at one centre width — beyond that we are well
  // outside the PDP and surrounding cell content is unpredictable.
  const outerCap = Math.ceil(centerWidth);
  const leftOuter = countWhile(
    img,
    cx - (leftDark + 1 + leftLight) * dx,
    cy - (leftDark + 1 + leftLight) * dy,
    -dx,
    -dy,
    threshold,
    true,
    outerCap,
  );
  const rightOuter = countWhile(
    img,
    cx + (rightDark + 1 + rightLight) * dx,
    cy + (rightDark + 1 + rightLight) * dy,
    dx,
    dy,
    threshold,
    true,
    outerCap,
  );

  const unit = centerWidth / 3;
  const tolLow = unit * 0.4;
  const tolHigh = unit * 2.0;
  // Light bands: must be within [low, high] of one unit.
  if (leftLight < tolLow || leftLight > tolHigh) return false;
  if (rightLight < tolLow || rightLight > tolHigh) return false;
  // Outer dark bands: must reach at least one unit. No upper bound (dark
  // surroundings beyond the PDP are normal).
  if (leftOuter < tolLow) return false;
  if (rightOuter < tolLow) return false;
  return true;
}

/**
 * Count consecutive pixels starting AT (sx, sy), walking in direction
 * (dx, dy), for which `(luminance <= threshold) === wantDark`. Stops at
 * the first mismatch, image boundary, or `cap` iterations (if provided).
 */
function countWhile(
  img: RawImage,
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  threshold: number,
  wantDark: boolean,
  cap = Infinity,
): number {
  let count = 0;
  let x = sx;
  let y = sy;
  while (count < cap && x >= 0 && y >= 0 && x < img.width && y < img.height) {
    const isDark = luminance(img, x, y) <= threshold;
    if (isDark !== wantDark) break;
    count++;
    x += dx;
    y += dy;
  }
  return count;
}

export function detectPDPs(img: RawImage, threshold: number): PDPCandidate[] {
  const whites = findComponents(img, (x, y) => luminance(img, x, y) > threshold);
  const darks = findComponents(img, (x, y) => luminance(img, x, y) <= threshold);

  const candidates: PDPCandidate[] = [];
  for (const white of whites) {
    if (white.pixelCount < 16) continue; // a single white pixel is not a PDP ring
    if (white.pixelCount > img.width * img.height * 0.5) continue; // overwhelming background
    for (const dark of darks) {
      // Dark centre must lie entirely inside the white ring's bbox.
      if (dark.minX < white.minX || dark.maxX > white.maxX) continue;
      if (dark.minY < white.minY || dark.maxY > white.maxY) continue;
      // Dark centroid must be near the white centroid (within half the bbox
      // diagonal). Filters out the "page background" dark blob that touches
      // the image edges through the corners.
      const dx = dark.centroid.x - white.centroid.x;
      const dy = dark.centroid.y - white.centroid.y;
      const ringDiag =
        ((white.maxX - white.minX) + (white.maxY - white.minY)) / 2;
      if (Math.hypot(dx, dy) > ringDiag * 0.5) continue;
      // Area ratio sanity check.
      const ratio = white.pixelCount / dark.pixelCount;
      if (ratio < 0.6 || ratio > 4.0) continue;
      // Final structural filter: 1:1:3:1:1 cross-section through the centroid.
      // Rejects shapes that pass nested-bbox + area-ratio by coincidence
      // (small letters, button-with-icon, reflections) but don't have the
      // actual band-width signature.
      if (!verifyCrossSection(img, dark.centroid, threshold)) continue;
      candidates.push({
        centroid: dark.centroid,
        whiteRingArea: white.pixelCount,
        blackCentreArea: dark.pixelCount,
        areaRatio: ratio,
      });
    }
  }
  return candidates;
}

/**
 * Pick the four PDPs that most plausibly represent the canvas's corner
 * fiducials, then arrange them by image corner.
 *
 * The earlier greedy "closest to each image corner" heuristic failed when
 * a small UI element happened to sit closer to an image corner than the
 * canvas's PDP (e.g. a "back" link near a laptop's top-left bezel). The
 * detection layer correctly flagged the real PDPs as candidates, but the
 * selector picked the false positive.
 *
 * The fix uses two structural truths about the four real PDPs:
 *
 *   - **Mutual similarity.** The four real PDPs share the same render,
 *     so under a mild perspective warp their pixel areas and area ratios
 *     vary smoothly across the image — very low coefficient of variation
 *     across the set. Random UI elements look nothing like each other.
 *   - **Convex quadrilateral geometry.** The canvas is convex, so its
 *     four PDP centroids form a convex quadrilateral. A subset that
 *     mixes two real PDPs and two random false positives almost always
 *     fails convexity (the false positives land "inside" the real
 *     quad, causing self-intersection or reflex angles).
 *
 * Algorithm:
 *   1. Rank candidates by area-ratio quality and take the top ~20 (caps
 *      the C(n,4) combinatorial search).
 *   2. Enumerate all 4-subsets. Reject any subset whose four centroids
 *      do not form a convex quadrilateral.
 *   3. Score the surviving subsets by 1 / (1 + areaCV + ratioCV), where
 *      *CV* is the standard deviation divided by the mean. Pick the
 *      highest-scoring subset.
 *   4. Assign that subset's four points to TL / TR / BR / BL by Manhattan
 *      distance to the image corners.
 *
 * C(20, 4) = 4845 subsets, each O(1) work — microseconds in practice.
 */
function pickFourPDPs(
  candidates: ReadonlyArray<PDPCandidate>,
  imgW: number,
  imgH: number,
): [Point, Point, Point, Point] | null {
  if (candidates.length < 4) return null;
  if (candidates.length === 4) {
    // Skip the search; just assign.
    return assignByImageCorner(
      candidates.map((c) => c.centroid),
      imgW,
      imgH,
    );
  }

  const cap = Math.min(candidates.length, 20);
  const indices = rankByQuality(candidates).slice(0, cap);

  let bestScore = -Infinity;
  let bestPoints: Point[] | null = null;

  for (let i = 0; i < indices.length - 3; i++) {
    for (let j = i + 1; j < indices.length - 2; j++) {
      for (let k = j + 1; k < indices.length - 1; k++) {
        for (let l = k + 1; l < indices.length; l++) {
          const subset = [
            candidates[indices[i]!]!,
            candidates[indices[j]!]!,
            candidates[indices[k]!]!,
            candidates[indices[l]!]!,
          ];
          const points = subset.map((c) => c.centroid);
          if (!isConvexQuad(points)) continue;
          const score = scoreSubset(subset, imgW, imgH);
          if (score > bestScore) {
            bestScore = score;
            bestPoints = points;
          }
        }
      }
    }
  }

  if (!bestPoints) {
    // No convex 4-subset; fall back to the closest-to-corner heuristic on
    // the highest-quality four. Better to return *something* than nothing.
    bestPoints = indices.slice(0, 4).map((idx) => candidates[idx]!.centroid);
  }

  return assignByImageCorner(bestPoints, imgW, imgH);
}

function rankByQuality(candidates: ReadonlyArray<PDPCandidate>): number[] {
  const idealRatio = 16 / 9;
  return candidates
    .map((_, i) => i)
    .sort((a, b) => {
      const cA = candidates[a]!;
      const cB = candidates[b]!;
      const errA = Math.abs(cA.areaRatio - idealRatio);
      const errB = Math.abs(cB.areaRatio - idealRatio);
      if (errA !== errB) return errA - errB;
      const areaA = cA.whiteRingArea + cA.blackCentreArea;
      const areaB = cB.whiteRingArea + cB.blackCentreArea;
      return areaB - areaA;
    });
}

/**
 * Score a candidate 4-subset by how plausibly it represents the canvas's
 * four real PDPs. Combines two projection-stable signals and one
 * positioning signal:
 *
 *   - **Area-ratio similarity (low CV).** A PDP's white-ring-to-dark-centre
 *     area ratio is invariant under projective transforms, so the four real
 *     PDPs always share it; spurious candidates have random ratios.
 *   - **Corner proximity.** The four chosen points, once assigned to image
 *     corners by Manhattan distance, should collectively sit *near* those
 *     corners. A mid-image false positive will push its assigned corner's
 *     distance up.
 *
 * Note: *area* similarity (not the ratio) is intentionally NOT used.
 * Under strong perspective, the local Jacobian varies enough that the
 * four real PDPs can differ in pixel area by 10× or more — a spurious
 * candidate sitting in the middle of that distribution can have lower
 * area variance than the real four. The ratio sidesteps this entirely.
 */
function scoreSubset(
  subset: ReadonlyArray<PDPCandidate>,
  imgW: number,
  imgH: number,
): number {
  const ratios = subset.map((c) => c.areaRatio);
  const ratioCV = coefficientOfVariation(ratios);

  // Pixel area is a strong real-world signal: false positives (page text,
  // UI buttons) are typically ~5-20× smaller than real PDPs, so a 4-subset
  // mixing real and fake has very high areaCV. We weight area below ratio
  // because under extreme synthetic perspective the four real PDPs can
  // differ in area by 10× (large Jacobian variation), which would let a
  // spurious mid-image candidate win on pure area similarity. The 0.5
  // weight is large enough to dominate in realistic conditions while
  // losing to ratio when perspective is severe.
  const areas = subset.map((c) => c.whiteRingArea + c.blackCentreArea);
  const areaCV = coefficientOfVariation(areas);

  const points = subset.map((c) => c.centroid);
  const assigned = assignByImageCorner(points, imgW, imgH);
  if (!assigned) return -Infinity;
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: imgW, y: 0 },
    { x: imgW, y: imgH },
    { x: 0, y: imgH },
  ];
  let totalCornerDist = 0;
  for (let i = 0; i < 4; i++) {
    totalCornerDist += Math.hypot(
      assigned[i]!.x - corners[i]!.x,
      assigned[i]!.y - corners[i]!.y,
    );
  }
  const imgDiag = Math.hypot(imgW, imgH);
  const normCornerDist = totalCornerDist / (imgDiag * 4); // 0..~1

  return -ratioCV - 0.5 * areaCV - normCornerDist;
}

function coefficientOfVariation(values: ReadonlyArray<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return Infinity;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance) / mean;
}

/**
 * Convexity test for four points: order them by angle around their centroid,
 * then verify all four cross-products of consecutive edge pairs have the same
 * sign. Robust to point ordering in the input.
 */
function isConvexQuad(pts: ReadonlyArray<Point>): boolean {
  if (pts.length !== 4) return false;
  const cx = (pts[0]!.x + pts[1]!.x + pts[2]!.x + pts[3]!.x) / 4;
  const cy = (pts[0]!.y + pts[1]!.y + pts[2]!.y + pts[3]!.y) / 4;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = sorted[i]!;
    const b = sorted[(i + 1) % 4]!;
    const c = sorted[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Given four points, return them in image-corner order (TL, TR, BR, BL) by
 * Manhattan distance to each image corner. Same algorithm the old greedy
 * selector used, but operating only on the four already chosen by
 * pickFourPDPs.
 */
function assignByImageCorner(
  pts: ReadonlyArray<Point>,
  imgW: number,
  imgH: number,
): [Point, Point, Point, Point] | null {
  if (pts.length !== 4) return null;
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: imgW, y: 0 },
    { x: imgW, y: imgH },
    { x: 0, y: imgH },
  ];
  const used = new Set<number>();
  const picks: Point[] = [];
  for (const corner of corners) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      const c = pts[i]!;
      const d = Math.abs(c.x - corner.x) + Math.abs(c.y - corner.y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return null;
    used.add(bestIdx);
    picks.push(pts[bestIdx]!);
  }
  return [picks[0]!, picks[1]!, picks[2]!, picks[3]!];
}

/**
 * Detect the four PDP centroids in an image, arranged by image corner
 * (image-TL, image-TR, image-BR, image-BL). Orientation relative to the
 * sender's frame is not yet known — that comes from the magic-validation
 * pass inside `decodeFrameWarped`.
 *
 * Returns null if fewer than four PDPs were detected.
 */
export function detectFiducials(
  img: RawImage,
): [Point, Point, Point, Point] | null {
  const threshold = otsuThreshold(img);
  if (threshold < 0) return null;
  const pdps = detectPDPs(img, threshold);
  return pickFourPDPs(pdps, img.width, img.height);
}

/**
 * STUB — middle-tier incremental detection (see docs/INCREMENTAL-DETECTION.md).
 *
 * Given expected fiducial positions from the previous frame, search a small
 * window around each one for the real fiducial. This is the path between
 * "trust the cached corners blindly" (PR #32) and "re-detect on the full
 * image" (current fallback) — needed for the hand-wobble case where the
 * camera moved a little but the fiducials are still nearby.
 *
 * Not yet implemented. See the design doc for the algorithm sketch and open
 * questions. Returning null signals the caller should fall through to the
 * full-image detector, so the stub is safe to call from production paths.
 */
export function detectFiducialsInWindows(
  _img: RawImage,
  _expected: [Point, Point, Point, Point],
  _windowRadiusPx: number,
): [Point, Point, Point, Point] | null {
  return null;
}

// =========================================================================
// M3.5: warped decode with orientation recovery
// =========================================================================

/** PHOT — the 4-byte magic at the start of every packet. */
const MAGIC: ReadonlyArray<number> = [0x50, 0x48, 0x4f, 0x54];

/**
 * Each rotation is a cyclic shift of the (TL, TR, BR, BL) image-corner
 * assignment: rotation r places the image-corner blob at slot (TL+r) mod 4
 * as the canonical TL. Together the four rotations cover the four cardinal
 * camera orientations.
 */
function rotateAssignment(
  imageCorners: readonly [Point, Point, Point, Point],
  rotation: number,
): [Point, Point, Point, Point] {
  return [
    imageCorners[(0 + rotation) % 4]!,
    imageCorners[(1 + rotation) % 4]!,
    imageCorners[(2 + rotation) % 4]!,
    imageCorners[(3 + rotation) % 4]!,
  ];
}

export interface WarpedDecodeResult {
  /** Full payload-cell array (length = `payloadCellCount(g)`). */
  cells: Uint8Array;
  /** Rotation that produced the matching magic, 0..3. */
  orientation: number;
  /** Detected PDP centroids in image-corner order (pre-orientation). */
  imageCornerCentroids: [Point, Point, Point, Point];
  /** M5: per-frame palette learned from the calibration strip — same length as the canonical palette, with the *observed* RGB per index under this frame's lighting. */
  learnedPalette: Palette;
}

/**
 * Decode a (possibly warped, possibly rotated) frame.
 *
 *  1. Detect four PDPs via Otsu + connected-components (`detectFiducials`)
 *  2. For each of four rotational assignments, solve the canonical→image
 *     homography, sample the first 16 payload cells (= 4 bytes), and check
 *     whether those bytes equal the "PHOT" magic
 *  3. The rotation whose magic matches is the correct orientation; decode
 *     the full payload at that rotation
 */
export function decodeFrameWarped(
  g: FrameGeometry,
  palette: Palette,
  img: RawImage,
  cellSizePx: number,
): WarpedDecodeResult {
  const imageCorners = detectFiducials(img);
  if (!imageCorners) {
    throw new Error("decodeFrameWarped: PDP detection failed");
  }

  const canonical = fiducialCanonicalCentroids(g, cellSizePx);
  const positions = payloadCellPositions(g);
  const cellsPerByte = 8 / bitsPerCell(palette);
  const magicCells = MAGIC.length * cellsPerByte;
  if (positions.length < magicCells) {
    throw new Error(
      `decodeFrameWarped: payload too small to carry the magic (${positions.length} < ${magicCells})`,
    );
  }
  const half = cellSizePx / 2;

  for (let rotation = 0; rotation < 4; rotation++) {
    const assigned = rotateAssignment(imageCorners, rotation);
    let h: Homography;
    try {
      h = computeHomography(canonical, assigned);
    } catch {
      continue; // singular system for this rotation — try the next
    }
    // M5: learn the per-frame palette from the calibration strip before
    // classifying cells. Has to be inside the rotation loop because the
    // homography (and therefore the calibration cell positions) differs
    // per rotation.
    const learnedPalette = learnPaletteFromCalibration(g, palette, img, h, cellSizePx);
    if (!magicMatches(g, learnedPalette, img, h, positions, magicCells, cellSizePx, half)) {
      continue;
    }
    const cells = sampleAllCells(img, learnedPalette, h, positions, cellSizePx, half);
    return { cells, orientation: rotation, imageCornerCentroids: imageCorners, learnedPalette };
  }

  throw new Error(
    "decodeFrameWarped: no rotation produced the expected magic — frame may be corrupted",
  );
}

function magicMatches(
  g: FrameGeometry,
  palette: Palette,
  img: RawImage,
  h: Homography,
  positions: ReadonlyArray<readonly [number, number]>,
  magicCells: number,
  cellSizePx: number,
  half: number,
): boolean {
  void g;
  const sampled = new Uint8Array(magicCells);
  for (let i = 0; i < magicCells; i++) {
    const [cx, cy] = positions[i]!;
    const warped = applyHomography(h, {
      x: cx * cellSizePx + half,
      y: cy * cellSizePx + half,
    });
    const px = Math.round(warped.x);
    const py = Math.round(warped.y);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return false;
    sampled[i] = sampleNearestPalette(img, palette, px, py);
  }
  const bytes = cellsToBytes(sampled, palette);
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

function sampleAllCells(
  img: RawImage,
  palette: Palette,
  h: Homography,
  positions: ReadonlyArray<readonly [number, number]>,
  cellSizePx: number,
  half: number,
): Uint8Array {
  const out = new Uint8Array(positions.length);
  for (let i = 0; i < positions.length; i++) {
    const [cx, cy] = positions[i]!;
    const warped = applyHomography(h, {
      x: cx * cellSizePx + half,
      y: cy * cellSizePx + half,
    });
    const px = Math.round(warped.x);
    const py = Math.round(warped.y);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) {
      out[i] = 0;
      continue;
    }
    out[i] = sampleNearestPalette(img, palette, px, py);
  }
  return out;
}

// =========================================================================
// M5: per-frame palette calibration
// =========================================================================

/**
 * Build a per-frame palette by sampling the calibration strip and using
 * each observed cell's RGB as the "live" colour for the palette index it
 * was rendered with.
 *
 * Why: the canonical palette `(0,0,0), (255,0,0), (0,255,0), (0,0,255)` is
 * what the sender renders, but the camera reports the same cells with
 * arbitrary tint, gain, and gamma based on the lighting it was metered
 * against. Under warm light blue cells come back like `(0,0,102)` — close
 * enough to black under the canonical palette that a static
 * nearest-palette classifier mis-labels them. The calibration strip lets
 * us learn the actual observed colour for each palette index on this
 * specific frame and classify payload cells against that.
 *
 * The strip has many cells per palette index (rows `calibrationRowStart`
 * to `calibrationRowStart + calibrationHeight`, all columns), each
 * rendered as `palette[cx % palette.length]`. We average the observed
 * RGB across all such cells per index.
 */
function learnPaletteFromCalibration(
  g: FrameGeometry,
  palette: Palette,
  img: RawImage,
  h: Homography,
  cellSizePx: number,
): Palette {
  const n = palette.colors.length;
  const sums = Array.from({ length: n }, () => ({ r: 0, g: 0, b: 0, count: 0 }));
  const half = cellSizePx / 2;
  for (let cy = g.calibrationRowStart; cy < g.calibrationRowStart + g.calibrationHeight; cy++) {
    for (let cx = 0; cx < g.cellsX; cx++) {
      const idx = cx % n;
      const warped = applyHomography(h, {
        x: cx * cellSizePx + half,
        y: cy * cellSizePx + half,
      });
      const px = Math.round(warped.x);
      const py = Math.round(warped.y);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const o = (py * img.width + px) * 4;
      const bucket = sums[idx]!;
      bucket.r += img.data[o]!;
      bucket.g += img.data[o + 1]!;
      bucket.b += img.data[o + 2]!;
      bucket.count++;
    }
  }
  const learned: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const bucket = sums[i]!;
    if (bucket.count === 0) {
      // Fall back to canonical colour when we couldn't sample (shouldn't
      // happen for a well-aligned frame; defensive).
      const [r, g, b] = palette.colors[i]!;
      learned.push([r, g, b]);
    } else {
      learned.push([
        bucket.r / bucket.count,
        bucket.g / bucket.count,
        bucket.b / bucket.count,
      ]);
    }
  }
  return { colors: learned };
}

// =========================================================================
// M4.5: diagnostic variants — return everything the detector / decoder saw
// =========================================================================

export interface FiducialDetectionDiagnostics {
  /** Per-frame Otsu threshold, or -1 if the image was uniform. */
  otsuThreshold: number;
  /** All PDP candidates that passed the area-ratio + nested-bbox checks. */
  allCandidates: PDPCandidate[];
  /** The four chosen as closest-to-image-corner, or null if < 4 candidates. */
  chosen: [Point, Point, Point, Point] | null;
}

export function detectFiducialsWithDiagnostics(
  img: RawImage,
): FiducialDetectionDiagnostics {
  const t = otsuThreshold(img);
  if (t < 0) return { otsuThreshold: t, allCandidates: [], chosen: null };
  const allCandidates = detectPDPs(img, t);
  const chosen = pickFourPDPs(allCandidates, img.width, img.height);
  return { otsuThreshold: t, allCandidates, chosen };
}

/** One rotation that the decoder tried, with the four magic bytes it sampled. */
export interface DecodeRotationAttempt {
  rotation: number;
  /** The 4 bytes sampled from the first 16 payload cells at this rotation. */
  magicBytes: Uint8Array;
  /** Whether those four bytes equalled the "PHOT" magic. */
  matched: boolean;
}

export interface DecodeFrameWarpedDiagnostics {
  detection: FiducialDetectionDiagnostics;
  /** One entry per rotation tried (0..3), in order, stopping at the first match. */
  rotationsAttempted: DecodeRotationAttempt[];
  /** Decode output if any rotation matched; null otherwise. */
  result: WarpedDecodeResult | null;
  /** Short string describing the failure mode when result is null. */
  failureReason: string | null;
}

/**
 * Like `decodeFrameWarped`, but never throws and returns every intermediate
 * the receiver UI / future overlay needs to surface the "why" of a failure.
 */
export function decodeFrameWarpedWithDiagnostics(
  g: FrameGeometry,
  palette: Palette,
  img: RawImage,
  cellSizePx: number,
): DecodeFrameWarpedDiagnostics {
  const detection = detectFiducialsWithDiagnostics(img);
  const rotationsAttempted: DecodeRotationAttempt[] = [];

  if (!detection.chosen) {
    return {
      detection,
      rotationsAttempted,
      result: null,
      failureReason:
        detection.allCandidates.length === 0
          ? "no PDP candidates passed the area-ratio and nested-bbox tests"
          : `only ${detection.allCandidates.length} PDPs detected, need 4`,
    };
  }

  const canonical = fiducialCanonicalCentroids(g, cellSizePx);
  const positions = payloadCellPositions(g);
  const cellsPerByte = 8 / bitsPerCell(palette);
  const magicCells = MAGIC.length * cellsPerByte;
  if (positions.length < magicCells) {
    return {
      detection,
      rotationsAttempted,
      result: null,
      failureReason: `payload region too small to carry the magic (${positions.length} < ${magicCells} cells)`,
    };
  }
  const half = cellSizePx / 2;

  for (let rotation = 0; rotation < 4; rotation++) {
    const assigned = rotateAssignment(detection.chosen, rotation);
    let h: Homography;
    try {
      h = computeHomography(canonical, assigned);
    } catch {
      rotationsAttempted.push({
        rotation,
        magicBytes: new Uint8Array(MAGIC.length),
        matched: false,
      });
      continue;
    }
    // M5: per-rotation learned palette.
    const learnedPalette = learnPaletteFromCalibration(g, palette, img, h, cellSizePx);
    const magicCellBuf = new Uint8Array(magicCells);
    let outOfBounds = false;
    for (let i = 0; i < magicCells; i++) {
      const [cx, cy] = positions[i]!;
      const warped = applyHomography(h, {
        x: cx * cellSizePx + half,
        y: cy * cellSizePx + half,
      });
      const px = Math.round(warped.x);
      const py = Math.round(warped.y);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) {
        outOfBounds = true;
        break;
      }
      magicCellBuf[i] = sampleNearestPalette(img, learnedPalette, px, py);
    }
    if (outOfBounds) {
      rotationsAttempted.push({
        rotation,
        magicBytes: new Uint8Array(MAGIC.length),
        matched: false,
      });
      continue;
    }
    const magicBytes = cellsToBytes(magicCellBuf, palette);
    let matched = true;
    for (let i = 0; i < MAGIC.length; i++) {
      if (magicBytes[i] !== MAGIC[i]) {
        matched = false;
        break;
      }
    }
    rotationsAttempted.push({ rotation, magicBytes, matched });
    if (matched) {
      const cells = sampleAllCells(img, learnedPalette, h, positions, cellSizePx, half);
      return {
        detection,
        rotationsAttempted,
        result: {
          cells,
          orientation: rotation,
          imageCornerCentroids: detection.chosen,
          learnedPalette,
        },
        failureReason: null,
      };
    }
  }

  return {
    detection,
    rotationsAttempted,
    result: null,
    failureReason: "no rotation produced the expected magic — frame likely corrupted",
  };
}
