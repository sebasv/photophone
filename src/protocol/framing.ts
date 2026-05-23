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
 * Pick the four PDPs closest to the image corners (one per corner). Returns
 * null if fewer than four candidates were supplied or some corner can't be
 * uniquely claimed.
 *
 * The choice of "closest to image corner" is intentional: even with mid-image
 * false-positive PDP-like patches, the four real fiducials genuinely sit
 * nearest the four image corners.
 *
 * Returned order: by image corner (top-left, top-right, bottom-right,
 * bottom-left) — *not* by sender-frame orientation. Orientation is recovered
 * later by trying all four rotational assignments against the magic.
 */
function pickFourByImageCorner(
  candidates: ReadonlyArray<{ centroid: Point }>,
  imgW: number,
  imgH: number,
): [Point, Point, Point, Point] | null {
  if (candidates.length < 4) return null;
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
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;
      const c = candidates[i]!.centroid;
      const d = Math.abs(c.x - corner.x) + Math.abs(c.y - corner.y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return null;
    used.add(bestIdx);
    picks.push(candidates[bestIdx]!.centroid);
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
  return pickFourByImageCorner(pdps, img.width, img.height);
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
    if (!magicMatches(g, palette, img, h, positions, magicCells, cellSizePx, half)) {
      continue;
    }
    // Orientation found. Decode the full payload.
    const cells = sampleAllCells(img, palette, h, positions, cellSizePx, half);
    return { cells, orientation: rotation, imageCornerCentroids: imageCorners };
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
