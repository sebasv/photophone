/**
 * A Photophone frame: the visual layout rendered to the screen.
 *
 * A frame has three regions:
 *   - fiducial markers in each corner (for receiver alignment + perspective unwarp)
 *   - a calibration strip (for white-balance / colour-classifier training)
 *   - a payload grid of coloured cells
 */

export interface FrameGeometry {
  /** Total frame size in cells (including markers + calibration). */
  cellsX: number;
  cellsY: number;
  /** Side length of each corner fiducial, in cells. */
  fiducialSize: number;
  /** Height of the calibration strip, in cells. */
  calibrationHeight: number;
}

export interface Frame {
  geometry: FrameGeometry;
  /**
   * Payload cells, row-major. Each cell is an integer index into the
   * active colour palette (see codec.ts).
   */
  cells: Uint8Array;
}

export const DEFAULT_GEOMETRY: FrameGeometry = {
  cellsX: 64,
  cellsY: 64,
  fiducialSize: 4,
  calibrationHeight: 2,
};

export function payloadCapacity(geometry: FrameGeometry): number {
  const usableRows = geometry.cellsY - geometry.calibrationHeight;
  const usableCols = geometry.cellsX;
  const fiducialCells = geometry.fiducialSize * geometry.fiducialSize * 4;
  return usableRows * usableCols - fiducialCells;
}
