/**
 * Codec: maps between bytes and grid cells.
 *
 * The colour palette is the channel alphabet. With N colours per cell, each
 * cell carries log2(N) bits. The first iteration uses a 4-colour palette
 * (2 bits/cell) — cheap to classify reliably under bad camera conditions.
 */

export interface Palette {
  /** RGB triplets in [0, 255]. */
  colors: ReadonlyArray<readonly [number, number, number]>;
}

export const PALETTE_2BIT: Palette = {
  colors: [
    [0, 0, 0],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ],
};

export function bitsPerCell(palette: Palette): number {
  return Math.log2(palette.colors.length);
}

export function bytesToCells(_bytes: Uint8Array, _palette: Palette): Uint8Array {
  throw new Error("codec.bytesToCells: not implemented");
}

export function cellsToBytes(_cells: Uint8Array, _palette: Palette): Uint8Array {
  throw new Error("codec.cellsToBytes: not implemented");
}
