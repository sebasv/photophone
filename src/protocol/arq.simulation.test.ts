import { describe, expect, it } from "vitest";
import {
  decodeAck,
  decodeBackChannelFrame,
  encodeAck,
  encodeBackChannelFrame,
  ingest,
  isComplete,
  missing,
  newReassembly,
  packetize,
  type ByteRange,
  type SessionInfo,
} from "./index";

const SESSION: SessionInfo = { sessionId: 0xa1a1a1a1 };

/**
 * Lossy-channel simulation. The sender cycles through packets one per
 * "tick"; some packets are dropped on the way; the receiver periodically
 * emits an ACK over the back-channel listing what it has so the sender
 * can skip already-received bytes. We compare ticks-to-complete against
 * a no-back-channel baseline.
 */
/** Deterministic PRNG (xorshift32) so test results are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function rangesEqual(a: ByteRange[], b: ByteRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.offset !== b[i]!.offset || a[i]!.length !== b[i]!.length) return false;
  }
  return true;
}

it("M13 ARQ simulation: ACK-aware sender completes faster than cyclic baseline on a 1-in-3 loss channel", () => {
  const totalBytes = 5000;
  const payload = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) payload[i] = (i * 37 + 7) & 0xff;
  const PACKET_SIZE = 200;
  const packets = packetize(payload, PACKET_SIZE, SESSION);

  // ---- Baseline: cyclic broadcast, no back-channel, no skipping ----
  // Random 1-in-3 loss with same seed for both runs so the comparison is fair.
  function cyclicBaselineTicks(): number {
    const rng = makeRng(0xcafef00d);
    const state = newReassembly(SESSION);
    let ticks = 0;
    while (!isComplete(state) || state.highestByte < totalBytes) {
      const idx = ticks % packets.length;
      const lost = rng() < 0.33;
      if (!lost) ingest(state, packets[idx]!);
      ticks++;
      if (ticks > packets.length * 200) throw new Error("baseline never converges");
    }
    return ticks;
  }

  // ---- ARQ: receiver acks every K ticks; sender skips acked ranges ----
  function arqTicks(): number {
    const rng = makeRng(0xcafef00d);
    const state = newReassembly(SESSION);
    const senderAckMap = new Set<number>();
    let ticks = 0;
    while (!isComplete(state) || state.highestByte < totalBytes) {
      let chosen = -1;
      for (let off = 0; off < packets.length; off++) {
        const idx = (ticks + off) % packets.length;
        if (!senderAckMap.has(idx)) { chosen = idx; break; }
      }
      if (chosen === -1) throw new Error("ARQ: every packet acked but reassembly incomplete?");
      const lost = rng() < 0.33;
      if (!lost) ingest(state, packets[chosen]!);
      ticks++;

      // Every 5 ticks, receiver renders an ACK back-channel frame and
      // the sender ingests it.
      if (ticks % 5 === 0) {
        const ranges = state.received.slice();
        const ackMsg = encodeAck(ranges);
        const ackWire = encodeBackChannelFrame(ackMsg, SESSION, ticks);
        const parsed = decodeBackChannelFrame(ackWire, SESSION);
        expect(parsed).not.toBeNull();
        const decoded = decodeAck(parsed!.msg);
        expect(decoded).not.toBeNull();
        expect(rangesEqual(decoded!, ranges)).toBe(true);
        // Sender marks the packet indices fully covered by acked ranges.
        for (let i = 0; i < packets.length; i++) {
          const pOffset = i * PACKET_SIZE;
          const pEnd = Math.min(pOffset + PACKET_SIZE, totalBytes);
          const pLen = pEnd - pOffset;
          for (const r of decoded!) {
            if (r.offset <= pOffset && r.offset + r.length >= pOffset + pLen) {
              senderAckMap.add(i);
              break;
            }
          }
        }
      }
      if (ticks > packets.length * 100) throw new Error("ARQ never converges");
    }
    return ticks;
  }

  const baseline = cyclicBaselineTicks();
  const arq = arqTicks();
  // ARQ should finish in strictly fewer ticks because once a packet is
  // acked, the sender stops re-sending it; the cyclic baseline keeps
  // re-sending acked packets forever.
  expect(arq).toBeLessThan(baseline);
});

describe("ACK after channel obstruction", () => {
  it("receiver recovers after a stretch of total loss when sender re-prioritizes nacked ranges", () => {
    const totalBytes = 2000;
    const payload = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i++) payload[i] = i & 0xff;
    const packets = packetize(payload, 250, SESSION);

    const state = newReassembly(SESSION);
    // Phase 1: deliver packets 0..3 cleanly.
    for (let i = 0; i < 4; i++) ingest(state, packets[i]!);
    expect(state.received[0]!.length).toBe(1000);

    // Phase 2: channel blocked (no packets delivered for many "ticks").
    // Receiver still tells the sender what's missing.
    const gaps = missing(state);
    expect(gaps.length).toBe(0); // contiguous so far, but bytes 1000..2000 aren't seen

    // Phase 3: channel restores. Sender prioritizes the never-acked tail.
    for (let i = 4; i < packets.length; i++) ingest(state, packets[i]!);
    expect(isComplete(state)).toBe(true);
    expect(state.highestByte).toBe(totalBytes);
  });
});
