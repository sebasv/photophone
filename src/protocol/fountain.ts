/**
 * LT (Luby Transform) fountain coding for the broadcast / forward-only
 * delivery mode (M10).
 *
 * Wire format per encoded packet (DESIGN.md §5.1):
 *
 *   offset 0 | 1 | degree (number of source packets XOR'd into this one)
 *   offset 1 | 3 | seed (PRNG seed used to derive the source indices)
 *   offset 4 | S | XOR'd payload bytes (size = source packet size)
 *
 * The receiver re-derives the source indices by seeding the same xorshift32
 * PRNG with the encoded packet's seed and drawing `degree` distinct values
 * modulo K (the number of source packets, known via bootstrap metadata).
 *
 * Decoder uses *peeling* (a.k.a. belief propagation):
 *
 *   - Subtract every already-recovered source from each incoming packet
 *   - If a packet's remaining source set has size 1: recover that source
 *   - Propagate: for every pending packet still containing that source,
 *     XOR it out and shrink the source set
 *   - Repeat until no more degree-1 packets exist (then wait for more
 *     encoded packets) or all K sources have been recovered
 *
 * Peeling fails if no degree-1 (after reduction) packet ever appears.
 * That's why fountain codes use a degree distribution with non-trivial
 * probability mass at degree 1 (the Robust Soliton distribution). This
 * module provides `idealSolitonDegree` as a starter; Robust Soliton can
 * be added when we measure the recovery overhead in practice.
 */

export const ENCODED_HEADER_SIZE = 4;

export interface EncodedPacket {
  /** Number of source packets XOR'd into this packet (1 ≤ degree ≤ K). */
  degree: number;
  /** 24-bit seed used to derive the source indices via xorshift32. */
  seed: number;
  /** XOR'd source bytes (length = source packet size S). */
  xorPayload: Uint8Array;
}

/**
 * Deterministic source-index derivation from (seed, degree, K).
 * Returns up to `degree` distinct indices in [0, K). May return fewer if
 * `degree > K` or repeated PRNG draws collide enough times.
 */
export function deriveSourceIndices(
  seed: number,
  degree: number,
  K: number,
): number[] {
  if (degree <= 0 || K <= 0) return [];
  let s = seed >>> 0;
  if (s === 0) s = 1; // xorshift32 sticks at 0
  const target = Math.min(degree, K);
  const set = new Set<number>();
  // Guard against pathological cases by capping iterations.
  const maxIters = target * 16 + 32;
  for (let iter = 0; iter < maxIters && set.size < target; iter++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    set.add((s >>> 0) % K);
  }
  return Array.from(set);
}

// =========================================================================
// Encoder
// =========================================================================

/**
 * Encode one packet by XORing `degree` source packets together. Source
 * indices are derived from `seed` via `deriveSourceIndices`. `degree` is
 * clamped to the actual returned index count (which may be less than the
 * requested degree if K is small or PRNG collisions reduce it).
 */
export function encodeOnePacket(
  sourcePackets: ReadonlyArray<Uint8Array>,
  degree: number,
  seed: number,
): EncodedPacket {
  const K = sourcePackets.length;
  if (K === 0) throw new Error("encodeOnePacket: no source packets");
  const S = sourcePackets[0]!.length;
  for (const sp of sourcePackets) {
    if (sp.length !== S) {
      throw new Error("encodeOnePacket: all source packets must have the same length");
    }
  }
  const indices = deriveSourceIndices(seed, degree, K);
  if (indices.length === 0) {
    throw new Error("encodeOnePacket: derived zero source indices");
  }
  const xor = new Uint8Array(S);
  for (const idx of indices) {
    const src = sourcePackets[idx]!;
    for (let i = 0; i < S; i++) xor[i] = xor[i]! ^ src[i]!;
  }
  return { degree: indices.length, seed, xorPayload: xor };
}

/** Serialise an encoded packet to wire bytes (header + payload). */
export function serializeEncoded(packet: EncodedPacket): Uint8Array {
  const out = new Uint8Array(ENCODED_HEADER_SIZE + packet.xorPayload.length);
  out[0] = packet.degree & 0xff;
  out[1] = (packet.seed >>> 16) & 0xff;
  out[2] = (packet.seed >>> 8) & 0xff;
  out[3] = packet.seed & 0xff;
  out.set(packet.xorPayload, ENCODED_HEADER_SIZE);
  return out;
}

/** Deserialise wire bytes back into an EncodedPacket. */
export function deserializeEncoded(bytes: Uint8Array): EncodedPacket {
  if (bytes.length < ENCODED_HEADER_SIZE) {
    throw new Error("deserializeEncoded: too short to contain a header");
  }
  const degree = bytes[0]!;
  const seed = (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  return {
    degree,
    seed,
    xorPayload: bytes.slice(ENCODED_HEADER_SIZE),
  };
}

/**
 * Ideal Soliton degree distribution: p(1) = 1/K, p(d) = 1/(d(d-1)) for d ≥ 2.
 *
 * Given a uniform random value `u` in [0, 1), returns a degree d such that
 * P(degree ≤ d) ≈ u under the ideal Soliton distribution. The mean of the
 * distribution is roughly ln(K).
 *
 * In production we'd want Robust Soliton, which adds a spike near
 * K/R for some R; ideal Soliton works for proof-of-concept tests and
 * for small K.
 */
export function idealSolitonDegree(u: number, K: number): number {
  // p(1) = 1/K
  if (u < 1 / K) return 1;
  // CDF: F(d) = 1/K + sum_{i=2..d} 1/(i*(i-1)) = 1/K + (1 - 1/d)
  // Solve for d: u = 1/K + 1 - 1/d  ⇒  1/d = 1 + 1/K - u  ⇒  d = 1 / (1 + 1/K - u)
  const d = Math.ceil(1 / (1 + 1 / K - u));
  return Math.max(1, Math.min(K, d));
}

// =========================================================================
// Decoder (peeling)
// =========================================================================

interface PendingRow {
  sources: Set<number>;
  xor: Uint8Array;
}

export interface FountainDecoder {
  /** Number of source packets in the original payload. */
  K: number;
  /** Source packet size in bytes. */
  S: number;
  /** Recovered source packets, keyed by source index. */
  recovered: Map<number, Uint8Array>;
  /** Encoded packets we couldn't peel yet (degree > 1 after reduction). */
  pending: PendingRow[];
}

export function newFountainDecoder(K: number, S: number): FountainDecoder {
  if (K <= 0) throw new Error("newFountainDecoder: K must be > 0");
  if (S <= 0) throw new Error("newFountainDecoder: S must be > 0");
  return { K, S, recovered: new Map(), pending: [] };
}

export function isComplete(state: FountainDecoder): boolean {
  return state.recovered.size === state.K;
}

/**
 * Ingest one encoded packet. Returns:
 *   - "accepted" if the packet added new information (recovered a source
 *     directly or via peeling, OR was queued for later peeling),
 *   - "redundant" if every source it covered was already recovered, or
 *   - "rejected" if the packet was malformed (e.g., wrong payload size).
 */
export function ingestEncodedPacket(
  state: FountainDecoder,
  packet: EncodedPacket,
): "accepted" | "redundant" | "rejected" {
  if (packet.xorPayload.length !== state.S) return "rejected";
  const indices = deriveSourceIndices(packet.seed, packet.degree, state.K);
  if (indices.length === 0) return "rejected";

  const sources = new Set<number>(indices);
  const xor = packet.xorPayload.slice();

  // Subtract already-recovered sources.
  for (const idx of indices) {
    const known = state.recovered.get(idx);
    if (known) {
      for (let i = 0; i < state.S; i++) xor[i] = xor[i]! ^ known[i]!;
      sources.delete(idx);
    }
  }
  if (sources.size === 0) return "redundant";

  state.pending.push({ sources, xor });
  attemptPeeling(state);
  return "accepted";
}

/**
 * Repeatedly find a degree-1 pending row, recover its source, propagate
 * the recovery into all other pending rows, and continue until no more
 * degree-1 rows are available.
 */
function attemptPeeling(state: FountainDecoder): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < state.pending.length; i++) {
      const row = state.pending[i]!;
      if (row.sources.size === 0) {
        // Fully reduced redundancy — discard.
        state.pending.splice(i, 1);
        i--;
        changed = true;
        continue;
      }
      if (row.sources.size === 1) {
        const idx = row.sources.values().next().value as number;
        state.recovered.set(idx, row.xor);
        state.pending.splice(i, 1);
        // Propagate.
        for (const other of state.pending) {
          if (other.sources.has(idx)) {
            for (let j = 0; j < state.S; j++) other.xor[j] = other.xor[j]! ^ row.xor[j]!;
            other.sources.delete(idx);
          }
        }
        changed = true;
        // Restart from the top in case earlier rows became degree-1.
        i = -1;
      }
    }
  }
}

/**
 * Return the K recovered source packets in order [0..K-1]. Throws if
 * `isComplete` is false.
 */
export function recoverPayload(state: FountainDecoder): Uint8Array[] {
  if (!isComplete(state)) {
    throw new Error(`fountain recover: incomplete (${state.recovered.size}/${state.K} sources)`);
  }
  const out: Uint8Array[] = [];
  for (let i = 0; i < state.K; i++) {
    const src = state.recovered.get(i);
    if (!src) throw new Error(`fountain recover: missing source ${i}`);
    out.push(src);
  }
  return out;
}
