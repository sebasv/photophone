/**
 * Framing: the visual layout rendered to the screen.
 *
 * A frame has four regions:
 *   - fiducial markers in each corner (for receiver alignment + perspective unwarp)
 *   - a config indicator (decoded with worst-case parameters; tells receiver
 *     how to interpret the rest of the frame)
 *   - a calibration strip (palette samples for per-frame colour classifier training)
 *   - a payload grid of coloured cells
 *
 * M1 lays out all four regions but only the payload region carries
 * varying data. Fiducials, config and calibration are painted with static
 * placeholders so the geometry is correct for downstream milestones.
 */

import type { Palette } from "./codec";

export interface FrameGeometry {
  cellsX: number;
  cellsY: number;
  /** Side length of each corner fiducial, in cells. */
  fiducialSize: number;
  /** Row on which the config indicator sits (typically 0). */
  configRow: number;
  /** Column where the config indicator starts (typically just past the top-left fiducial). */
  configColStart: number;
  /** Width of the config indicator, in cells. */
  configWidth: number;
  /** First row of the calibration strip (typically just below the top fiducial rows). */
  calibrationRowStart: number;
  /** Height of the calibration strip, in rows. */
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

/** Returns the (x, y) cell positions that carry payload, in row-major order. */
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

/**
 * A DOM-free image buffer. The page layer wraps it in `ImageData` for canvas
 * drawing; the protocol layer never touches DOM types.
 */
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

/**
 * Render a frame to a pixel buffer.
 *
 * `payloadCells` must contain exactly `payloadCellCount(g)` cell-indices, each
 * in [0, palette.colors.length). Callers pad with zeros if they have fewer
 * bytes than the frame can carry — the higher transport layer carries the
 * effective length in its packet header.
 */
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
      let colorIdx: number;
      switch (role) {
        case "payload":
          colorIdx = payloadCells[payloadIdx++]!;
          break;
        case "fiducial":
          // Solid colour-0 corner blocks. M3 will replace with structured markers.
          colorIdx = 0;
          break;
        case "config":
          // Static placeholder until later milestones use this region.
          colorIdx = 0;
          break;
        case "calibration":
          // Cycle through palette colours for nearest-neighbour classifier training.
          colorIdx = cx % palette.colors.length;
          break;
      }
      const rgb = palette.colors[colorIdx]!;
      fillRect(img, px, py, cellSizePx, cellSizePx, rgb);
    }
  }
  return img;
}

/**
 * Decode a pristine, axis-aligned frame back to payload cell indices.
 * No fiducial detection, no perspective unwarp — that lands in M3.
 *
 * Samples the centre pixel of each cell and finds the nearest palette colour
 * by squared Euclidean RGB distance.
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
    const o = (py * img.width + px) * 4;
    const r = img.data[o]!;
    const gC = img.data[o + 1]!;
    const b = img.data[o + 2]!;
    out[i] = nearestPaletteIndex(palette, r, gC, b);
  }
  return out;
}

function nearestPaletteIndex(
  palette: Palette,
  r: number,
  g: number,
  b: number,
): number {
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
