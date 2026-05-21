import { describe, expect, it } from "vitest";
import {
  bitsPerCell,
  bytesToCells,
  cellsForBytes,
  cellsToBytes,
  PALETTE_2BIT,
  type Palette,
} from "./codec";

describe("bitsPerCell", () => {
  it("reports 2 bits for the 4-colour palette", () => {
    expect(bitsPerCell(PALETTE_2BIT)).toBe(2);
  });

  it("rejects non-power-of-two palettes", () => {
    const bad: Palette = {
      colors: [
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
      ],
    };
    expect(() => bitsPerCell(bad)).toThrow(/power of two/);
  });
});

describe("cellsForBytes", () => {
  it("returns 4 cells per byte for the 2-bit palette", () => {
    expect(cellsForBytes(0, PALETTE_2BIT)).toBe(0);
    expect(cellsForBytes(1, PALETTE_2BIT)).toBe(4);
    expect(cellsForBytes(800, PALETTE_2BIT)).toBe(3200);
  });
});

describe("bytesToCells / cellsToBytes — 2-bit palette", () => {
  it("splits a byte into 4 big-endian 2-bit cells", () => {
    // 0b11_01_10_00 = 0xD8 → [3, 1, 2, 0]
    const cells = bytesToCells(new Uint8Array([0xd8]), PALETTE_2BIT);
    expect(Array.from(cells)).toEqual([3, 1, 2, 0]);
  });

  it("handles 0x00 and 0xff cleanly", () => {
    expect(Array.from(bytesToCells(new Uint8Array([0x00]), PALETTE_2BIT))).toEqual([0, 0, 0, 0]);
    expect(Array.from(bytesToCells(new Uint8Array([0xff]), PALETTE_2BIT))).toEqual([3, 3, 3, 3]);
  });

  it("round-trips 800 random bytes", () => {
    const bytes = randomBytes(800, 0xc0de);
    const cells = bytesToCells(bytes, PALETTE_2BIT);
    expect(cells.length).toBe(3200);
    const back = cellsToBytes(cells, PALETTE_2BIT);
    expect(back).toEqual(bytes);
  });

  it("round-trips an empty buffer", () => {
    const bytes = new Uint8Array(0);
    const back = cellsToBytes(bytesToCells(bytes, PALETTE_2BIT), PALETTE_2BIT);
    expect(back).toEqual(bytes);
  });

  it("cellsToBytes rejects misaligned input", () => {
    expect(() => cellsToBytes(new Uint8Array([0, 1, 2]), PALETTE_2BIT)).toThrow(
      /multiple of 4/,
    );
  });
});

function randomBytes(n: number, seed: number): Uint8Array {
  // xorshift32 — deterministic across runs for reproducible failures.
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
