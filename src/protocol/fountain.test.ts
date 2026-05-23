import { describe, expect, it } from "vitest";
import {
  deriveSourceIndices,
  deserializeEncoded,
  encodeOnePacket,
  idealSolitonDegree,
  ingestEncodedPacket,
  isComplete,
  newFountainDecoder,
  recoverPayload,
  serializeEncoded,
  type EncodedPacket,
} from "./fountain";

const SOURCE_SIZE = 16;

describe("deriveSourceIndices", () => {
  it("returns up to `degree` distinct indices in [0, K)", () => {
    const idx = deriveSourceIndices(0x1234, 5, 100);
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.length).toBeLessThanOrEqual(5);
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(100);
    }
    expect(new Set(idx).size).toBe(idx.length);
  });

  it("is deterministic for a given seed/degree/K", () => {
    const a = deriveSourceIndices(0xabcdef, 7, 50);
    const b = deriveSourceIndices(0xabcdef, 7, 50);
    expect(a).toEqual(b);
  });

  it("returns at most K indices when degree > K", () => {
    const idx = deriveSourceIndices(0xfeed, 20, 5);
    expect(idx.length).toBe(5);
    expect(new Set(idx).size).toBe(5);
  });
});

describe("serializeEncoded / deserializeEncoded", () => {
  it("round-trips a packet", () => {
    const packet: EncodedPacket = {
      degree: 3,
      seed: 0x123456,
      xorPayload: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
    };
    const wire = serializeEncoded(packet);
    expect(wire.length).toBe(4 + 8);
    const parsed = deserializeEncoded(wire);
    expect(parsed.degree).toBe(packet.degree);
    expect(parsed.seed).toBe(packet.seed);
    expect(parsed.xorPayload).toEqual(packet.xorPayload);
  });
});

describe("encodeOnePacket", () => {
  it("XORs the indicated source packets together", () => {
    const sources = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([10, 20, 30, 40]),
      new Uint8Array([100, 200, 50, 75]),
    ];
    // Use a seed that picks specific indices; verify XOR
    // The actual indices depend on the PRNG, so encode and check XOR matches indices.
    const packet = encodeOnePacket(sources, 2, 0xa5a5);
    const indices = deriveSourceIndices(0xa5a5, 2, 3);
    const expected = new Uint8Array(4);
    for (const i of indices) {
      for (let j = 0; j < 4; j++) expected[j] = expected[j]! ^ sources[i]![j]!;
    }
    expect(packet.xorPayload).toEqual(expected);
    expect(packet.degree).toBe(indices.length);
  });
});

describe("decoder peeling — small K with explicit degree-1 packets", () => {
  it("recovers K=5 sources from degree-1 packets alone", () => {
    const sources = makeSources(5, SOURCE_SIZE, 0x1111);
    const decoder = newFountainDecoder(5, SOURCE_SIZE);

    // Build degree-1 packets by finding seeds that derive each source index.
    for (let i = 0; i < 5; i++) {
      const seed = findSeedForSingleIndex(i, 5);
      const packet = encodeOnePacket(sources, 1, seed);
      const result = ingestEncodedPacket(decoder, packet);
      expect(result).toBe("accepted");
    }

    expect(isComplete(decoder)).toBe(true);
    expect(recoverPayload(decoder)).toEqual(sources);
  });

  it("peels degree-2 packets after their source is recovered", () => {
    const sources = makeSources(3, SOURCE_SIZE, 0x2222);
    const decoder = newFountainDecoder(3, SOURCE_SIZE);

    // First add a degree-2 packet that combines sources 0 and 1.
    const seed01 = findSeedForExactIndices([0, 1], 3);
    const pkt01 = encodeOnePacket(sources, 2, seed01);
    expect(ingestEncodedPacket(decoder, pkt01)).toBe("accepted");
    expect(isComplete(decoder)).toBe(false);

    // Now add a degree-1 packet for source 0. Peeling should:
    //   - recover source 0,
    //   - reduce pkt01 to a degree-1 row for source 1,
    //   - recover source 1.
    const seed0 = findSeedForSingleIndex(0, 3);
    const pkt0 = encodeOnePacket(sources, 1, seed0);
    expect(ingestEncodedPacket(decoder, pkt0)).toBe("accepted");
    expect(decoder.recovered.has(0)).toBe(true);
    expect(decoder.recovered.has(1)).toBe(true);

    // And one more for source 2 to complete.
    const seed2 = findSeedForSingleIndex(2, 3);
    const pkt2 = encodeOnePacket(sources, 1, seed2);
    ingestEncodedPacket(decoder, pkt2);
    expect(isComplete(decoder)).toBe(true);
    expect(recoverPayload(decoder)).toEqual(sources);
  });

  it("marks already-fully-recovered packets as redundant", () => {
    const sources = makeSources(2, SOURCE_SIZE, 0x3333);
    const decoder = newFountainDecoder(2, SOURCE_SIZE);
    const seed0 = findSeedForSingleIndex(0, 2);
    const seed1 = findSeedForSingleIndex(1, 2);
    ingestEncodedPacket(decoder, encodeOnePacket(sources, 1, seed0));
    ingestEncodedPacket(decoder, encodeOnePacket(sources, 1, seed1));
    // Both sources now known. A new packet covering source 0 again:
    const result = ingestEncodedPacket(decoder, encodeOnePacket(sources, 1, seed0));
    expect(result).toBe("redundant");
  });
});

describe("M9 done-when: receiver restarted mid-stream recovers from the rest", () => {
  it("recovers K=8 sources after dropping the first half of a 32-packet stream", () => {
    const K = 8;
    const sources = makeSources(K, SOURCE_SIZE, 0xc0de);
    // Build 32 encoded packets, mixing degrees 1, 2, 3, 4 with deterministic seeds.
    const packets: EncodedPacket[] = [];
    let seed = 1;
    while (packets.length < 32) {
      // Cycle through small degrees to ensure enough degree-1 packets for peeling.
      const degree = 1 + (packets.length % 4);
      const pkt = encodeOnePacket(sources, degree, seed);
      packets.push(pkt);
      seed = (seed * 1103515245 + 12345) >>> 0; // standard LCG
      if (seed === 0) seed = 1;
    }

    // Simulate killing the receiver mid-transfer: drop the first 16 packets.
    const decoder = newFountainDecoder(K, SOURCE_SIZE);
    for (let i = 16; i < packets.length; i++) {
      ingestEncodedPacket(decoder, packets[i]!);
    }
    expect(isComplete(decoder)).toBe(true);
    expect(recoverPayload(decoder)).toEqual(sources);
  });
});

describe("idealSolitonDegree", () => {
  it("returns 1 for the smallest probability mass", () => {
    expect(idealSolitonDegree(0, 50)).toBe(1);
  });

  it("returns a degree ≤ K for any u in [0, 1)", () => {
    for (let u = 0; u < 1; u += 0.05) {
      const d = idealSolitonDegree(u, 100);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(100);
    }
  });
});

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeSources(K: number, S: number, seed: number): Uint8Array[] {
  let s = seed >>> 0;
  const out: Uint8Array[] = [];
  for (let k = 0; k < K; k++) {
    const pkt = new Uint8Array(S);
    for (let i = 0; i < S; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      pkt[i] = s & 0xff;
    }
    out.push(pkt);
  }
  return out;
}

/**
 * Brute-force search for a seed that makes `deriveSourceIndices(seed, 1, K)`
 * return exactly `[target]`. Used by tests to construct degree-1 packets
 * targeting specific sources.
 */
function findSeedForSingleIndex(target: number, K: number): number {
  for (let seed = 1; seed < 1 << 20; seed++) {
    const idx = deriveSourceIndices(seed, 1, K);
    if (idx.length === 1 && idx[0] === target) return seed;
  }
  throw new Error(`could not find seed for target=${target}, K=${K}`);
}

/**
 * Brute-force search for a seed whose 2-element index derivation matches
 * the given indices (as a set).
 */
function findSeedForExactIndices(targets: number[], K: number): number {
  const wanted = new Set(targets);
  for (let seed = 1; seed < 1 << 20; seed++) {
    const idx = deriveSourceIndices(seed, targets.length, K);
    if (idx.length !== targets.length) continue;
    const got = new Set(idx);
    if (got.size === wanted.size && [...got].every((i) => wanted.has(i))) return seed;
  }
  throw new Error(`could not find seed for indices=${targets.join(",")}, K=${K}`);
}
