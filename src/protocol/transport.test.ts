import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodePacket,
  encodePacket,
  HEADER_SIZE,
  ingest,
  isComplete,
  MAGIC,
  missing,
  newReassembly,
  packetize,
  reassemble,
  VERSION_MAJOR,
  type SessionInfo,
} from "./transport";

const SESSION: SessionInfo = { sessionId: 0xdeadbeef };

describe("encodePacket / decodePacket", () => {
  it("round-trips a packet", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const wire = encodePacket(7, 42, payload, SESSION);

    expect(wire.length).toBe(HEADER_SIZE + payload.length);
    expect(wire.slice(0, 4)).toEqual(MAGIC);
    expect(wire[4]).toBe(VERSION_MAJOR);

    const parsed = decodePacket(wire, SESSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.seq).toBe(7);
    expect(parsed!.total).toBe(42);
    expect(parsed!.payload).toEqual(payload);
  });

  it("rejects wrong magic", () => {
    const wire = encodePacket(0, 1, new Uint8Array(0), SESSION);
    wire[0] = 0;
    expect(decodePacket(wire, SESSION)).toBeNull();
  });

  it("rejects a different session", () => {
    const wire = encodePacket(0, 1, new Uint8Array(0), SESSION);
    expect(decodePacket(wire, { sessionId: 0xcafef00d })).toBeNull();
  });

  it("rejects truncated payload", () => {
    const wire = encodePacket(0, 1, new Uint8Array([1, 2, 3]), SESSION);
    expect(decodePacket(wire.slice(0, wire.length - 1), SESSION)).toBeNull();
  });
});

describe("packetize", () => {
  it("emits ceil(payload/size) packets and tags total consistently", () => {
    const payload = new Uint8Array(2500);
    const packets = packetize(payload, 1000, SESSION);
    expect(packets.length).toBe(3);

    for (const wire of packets) {
      const parsed = decodePacket(wire, SESSION)!;
      expect(parsed.total).toBe(3);
    }

    // The last packet's payload is the residual (500 bytes).
    const last = decodePacket(packets[2]!, SESSION)!;
    expect(last.payload.length).toBe(500);
  });

  it("handles an empty payload as zero packets", () => {
    expect(packetize(new Uint8Array(0), 100, SESSION)).toEqual([]);
  });
});

describe("reassembly state machine", () => {
  it("accepts packets in any order and reports missing seq numbers", () => {
    const original = new Uint8Array(2500);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;

    const packets = packetize(original, 1000, SESSION);
    const state = newReassembly(SESSION);

    expect(missing(state)).toEqual([]); // unknown until first packet seen

    // out of order, with one dropped
    expect(ingest(state, packets[2]!)).toBe("accepted");
    expect(state.expectedTotal).toBe(3);
    expect(missing(state)).toEqual([0, 1]);

    expect(ingest(state, packets[0]!)).toBe("accepted");
    expect(missing(state)).toEqual([1]);
    expect(isComplete(state)).toBe(false);

    // duplicate of one we already have
    expect(ingest(state, packets[0]!)).toBe("duplicate");

    // finally fill the gap
    expect(ingest(state, packets[1]!)).toBe("accepted");
    expect(isComplete(state)).toBe(true);
    expect(missing(state)).toEqual([]);

    expect(reassemble(state)).toEqual(original);
  });

  it("rejects packets from foreign sessions", () => {
    const stranger = encodePacket(0, 1, new Uint8Array([1, 2, 3]), {
      sessionId: 0x1234,
    });
    const state = newReassembly(SESSION);
    expect(ingest(state, stranger)).toBe("rejected-session");
    expect(state.expectedTotal).toBeNull();
  });

  it("rejects mismatched totals after one was established", () => {
    const a = encodePacket(0, 3, new Uint8Array([1]), SESSION);
    const b = encodePacket(1, 4, new Uint8Array([2]), SESSION);
    const state = newReassembly(SESSION);
    expect(ingest(state, a)).toBe("accepted");
    expect(ingest(state, b)).toBe("rejected-inconsistent-total");
  });

  it("throws on reassemble before complete, with the missing list in the error", () => {
    const packets = packetize(new Uint8Array(100), 30, SESSION);
    const state = newReassembly(SESSION);
    ingest(state, packets[0]!);
    expect(() => reassemble(state)).toThrow(/missing/);
  });
});

describe("M2 done-when: hello_world.png round-trips through shuffle + drop + restore", () => {
  it("reassembles byte-perfect when enough packets are present", () => {
    const png = readFileSync(new URL("../../hello_world.png", import.meta.url));
    const payload = new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
    const sentSha = sha256(payload);

    // Packet payload size of 633 matches the doc's predicted unicast capacity
    // — see DESIGN.md §4.
    const packets = packetize(payload, 633, SESSION);
    expect(packets.length).toBeGreaterThan(40);

    // Shuffle deterministically, drop a few, then add them back at the end.
    const shuffled = shuffle(packets, 0xabcd);
    const dropped: Uint8Array[] = [];
    const delivered: Uint8Array[] = [];
    for (let i = 0; i < shuffled.length; i++) {
      if (i % 13 === 7) dropped.push(shuffled[i]!);
      else delivered.push(shuffled[i]!);
    }

    const state = newReassembly(SESSION);
    for (const w of delivered) ingest(state, w);
    expect(isComplete(state)).toBe(false);
    expect(missing(state).length).toBe(dropped.length);

    for (const w of dropped) ingest(state, w);
    expect(isComplete(state)).toBe(true);

    const restored = reassemble(state);
    expect(restored.length).toBe(payload.length);
    expect(sha256(restored)).toBe(sentSha);
  });

  it("cleanly reports missing seq numbers when packets are lost", () => {
    const png = readFileSync(new URL("../../hello_world.png", import.meta.url));
    const payload = new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
    const packets = packetize(payload, 633, SESSION);

    const state = newReassembly(SESSION);
    const dropMe = new Set([3, 17, 41]);
    for (let i = 0; i < packets.length; i++) {
      if (dropMe.has(i)) continue;
      ingest(state, packets[i]!);
    }

    expect(isComplete(state)).toBe(false);
    expect(missing(state).sort((a, b) => a - b)).toEqual([3, 17, 41]);
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function shuffle<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = items.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
