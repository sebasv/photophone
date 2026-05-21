/**
 * Codec: maps between bytes and grid cells.
 *
 * The colour palette is the channel alphabet. With N colours per cell, each
 * cell carries log2(N) bits. The first iteration uses a 4-colour palette
 * (2 bits/cell) — cheap to classify reliably under bad camera conditions.
 *
 * Bit ordering within a byte is big-endian: cell 0 carries the most-significant
 * `bitsPerCell` bits, cell 1 the next, etc. This matches network byte order
 * conventions and means the first cell of a packet maps to the first bits of
 * the first byte.
 */

export interface Palette {
  /** RGB triplets in [0, 255]. Must be a power-of-two length. */
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
  const n = palette.colors.length;
  const bits = Math.log2(n);
  if (!Number.isInteger(bits) || bits < 1) {
    throw new Error(
      `palette size must be a power of two ≥ 2; got ${n}`,
    );
  }
  return bits;
}

/** Number of cells produced for a given byte length. */
export function cellsForBytes(byteLength: number, palette: Palette): number {
  const bits = bitsPerCell(palette);
  return Math.ceil((byteLength * 8) / bits);
}

export function bytesToCells(bytes: Uint8Array, palette: Palette): Uint8Array {
  const bits = bitsPerCell(palette);
  const mask = (1 << bits) - 1;
  const cellsPerByte = 8 / bits;
  if (!Number.isInteger(cellsPerByte)) {
    throw new Error(
      `bitsPerCell (${bits}) must evenly divide 8; pick a palette of 2/4/16/256 colours`,
    );
  }
  const out = new Uint8Array(bytes.length * cellsPerByte);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    for (let c = 0; c < cellsPerByte; c++) {
      const shift = 8 - bits * (c + 1);
      out[i * cellsPerByte + c] = (b >> shift) & mask;
    }
  }
  return out;
}

export function cellsToBytes(cells: Uint8Array, palette: Palette): Uint8Array {
  const bits = bitsPerCell(palette);
  const cellsPerByte = 8 / bits;
  if (!Number.isInteger(cellsPerByte)) {
    throw new Error(
      `bitsPerCell (${bits}) must evenly divide 8; pick a palette of 2/4/16/256 colours`,
    );
  }
  if (cells.length % cellsPerByte !== 0) {
    throw new Error(
      `cells length (${cells.length}) must be a multiple of ${cellsPerByte}`,
    );
  }
  const out = new Uint8Array(cells.length / cellsPerByte);
  const mask = (1 << bits) - 1;
  for (let i = 0; i < out.length; i++) {
    let b = 0;
    for (let c = 0; c < cellsPerByte; c++) {
      const shift = 8 - bits * (c + 1);
      b |= (cells[i * cellsPerByte + c]! & mask) << shift;
    }
    out[i] = b;
  }
  return out;
}
