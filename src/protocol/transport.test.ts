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
    const wire = encodePacket(0, payload, SESSION);

    expect(wire.length).toBe(HEADER_SIZE + payload.length);
    expect(wire.slice(0, 4)).toEqual(MAGIC);
    expect(wire[4]).toBe(VERSION_MAJOR);

    const parsed = decodePacket(wire, SESSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.payloadOffset).toBe(0);
    expect(parsed!.payload).toEqual(payload);
  });

  it("carries the byte offset round-trip", () => {
    const payload = new Uint8Array([9, 9, 9]);
    const wire = encodePacket(12345, payload, SESSION);
    const parsed = decodePacket(wire, SESSION)!;
    expect(parsed.payloadOffset).toBe(12345);
    expect(parsed.payload).toEqual(payload);
  });

  it("rejects wrong magic", () => {
    const wire = encodePacket(0, new Uint8Array(0), SESSION);
    wire[0] = 0;
    expect(decodePacket(wire, SESSION)).toBeNull();
  });

  it("rejects a different session", () => {
    const wire = encodePacket(0, new Uint8Array(0), SESSION);
    expect(decodePacket(wire, { sessionId: 0xcafef00d })).toBeNull();
  });

  it("rejects truncated payload", () => {
    const wire = encodePacket(0, new Uint8Array([1, 2, 3]), SESSION);
    expect(decodePacket(wire.slice(0, wire.length - 1), SESSION)).toBeNull();
  });
});

describe("packetize", () => {
  it("emits packets with monotonically increasing offsets", () => {
    const payload = new Uint8Array(2500);
    const packets = packetize(payload, 1000, SESSION);
    expect(packets.length).toBe(3);

    const offsets = packets.map((p) => decodePacket(p, SESSION)!.payloadOffset);
    expect(offsets).toEqual([0, 1000, 2000]);

    // Last packet's payload is the residual.
    const last = decodePacket(packets[2]!, SESSION)!;
    expect(last.payload.length).toBe(500);
  });

  it("handles an empty payload as zero packets", () => {
    expect(packetize(new Uint8Array(0), 100, SESSION)).toEqual([]);
  });
});

describe("reassembly state machine", () => {
  it("accepts packets in any order and reports missing byte ranges", () => {
    const original = new Uint8Array(2500);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;

    const packets = packetize(original, 1000, SESSION);
    const state = newReassembly(SESSION, original.length);

    expect(missing(state)).toEqual([{ offset: 0, length: 2500 }]);

    expect(ingest(state, packets[2]!)).toBe("accepted");
    expect(missing(state)).toEqual([{ offset: 0, length: 2000 }]);

    expect(ingest(state, packets[0]!)).toBe("accepted");
    expect(missing(state)).toEqual([{ offset: 1000, length: 1000 }]);
    expect(isComplete(state)).toBe(false);

    expect(ingest(state, packets[0]!)).toBe("duplicate");

    expect(ingest(state, packets[1]!)).toBe("accepted");
    expect(isComplete(state)).toBe(true);
    expect(missing(state)).toEqual([]);
    expect(reassemble(state)).toEqual(original);
  });

  it("merges adjacent and overlapping ranges into a single interval", () => {
    const state = newReassembly(SESSION, 1000);

    ingest(state, encodePacket(0, new Uint8Array(200), SESSION));
    ingest(state, encodePacket(400, new Uint8Array(200), SESSION));
    expect(state.received).toEqual([
      { offset: 0, length: 200 },
      { offset: 400, length: 200 },
    ]);

    // Fill the gap; everything should coalesce into one range.
    ingest(state, encodePacket(200, new Uint8Array(200), SESSION));
    expect(state.received).toEqual([{ offset: 0, length: 600 }]);

    // Adjacent extension (no gap).
    ingest(state, encodePacket(600, new Uint8Array(100), SESSION));
    expect(state.received).toEqual([{ offset: 0, length: 700 }]);

    // Overlapping extension absorbs an existing tail piece.
    ingest(state, encodePacket(800, new Uint8Array(150), SESSION));
    ingest(state, encodePacket(650, new Uint8Array(300), SESSION));
    expect(state.received).toEqual([{ offset: 0, length: 950 }]);
  });

  it("rejects packets that would overrun the payload buffer", () => {
    const state = newReassembly(SESSION, 100);
    const wire = encodePacket(80, new Uint8Array(40), SESSION);
    expect(ingest(state, wire)).toBe("out-of-bounds");
  });

  it("rejects packets from foreign sessions", () => {
    const stranger = encodePacket(0, new Uint8Array([1, 2, 3]), {
      sessionId: 0x1234,
    });
    const state = newReassembly(SESSION, 100);
    expect(ingest(state, stranger)).toBe("rejected-session");
    expect(state.received).toEqual([]);
  });

  it("throws on reassemble before complete, with the missing list in the error", () => {
    const packets = packetize(new Uint8Array(100), 30, SESSION);
    const state = newReassembly(SESSION, 100);
    ingest(state, packets[0]!);
    expect(() => reassemble(state)).toThrow(/missing/);
  });
});

describe("variable-capacity retransmit", () => {
  it("fills a missing range with multiple smaller packets at lower capacity", () => {
    // Simulates the user's scenario: an original ~956-byte packet covered
    // bytes [16252, 17208). Capacity drops to 400 bytes. We re-send the
    // missing range as three smaller packets and reassembly closes the gap.
    const totalSize = 30000;
    const original = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i++) original[i] = (i * 7) & 0xff;

    const state = newReassembly(SESSION, totalSize);

    // First pass: deliver everything except the range [16252, 17208).
    const firstPass = packetize(original, 956, SESSION);
    for (const wire of firstPass) {
      const p = decodePacket(wire, SESSION)!;
      if (p.payloadOffset === 16252) continue;
      ingest(state, wire);
    }
    const stillMissing = missing(state);
    expect(stillMissing.length).toBe(1);
    expect(stillMissing[0]!.offset).toBe(16252);
    expect(stillMissing[0]!.length).toBe(956);

    // Retransmit at lower capacity: 400-byte packets covering the missing
    // range. The boundary doesn't align with the original packet boundary
    // — that's the whole point.
    const gap = stillMissing[0]!;
    const retransmitSize = 400;
    let off = gap.offset;
    while (off < gap.offset + gap.length) {
      const end = Math.min(off + retransmitSize, gap.offset + gap.length);
      const slice = original.slice(off, end);
      expect(ingest(state, encodePacket(off, slice, SESSION))).toBe("accepted");
      off = end;
    }

    expect(isComplete(state)).toBe(true);
    expect(reassemble(state)).toEqual(original);
  });
});

describe("hello_world.png round-trips through shuffle + drop + restore", () => {
  it("reassembles byte-perfect when enough packets are present", () => {
    const png = readFileSync(new URL("../../hello_world.png", import.meta.url));
    const payload = new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
    const sentSha = sha256(payload);

    const packets = packetize(payload, 633, SESSION);
    expect(packets.length).toBeGreaterThan(40);

    const shuffled = shuffle(packets, 0xabcd);
    const dropped: Uint8Array[] = [];
    const delivered: Uint8Array[] = [];
    for (let i = 0; i < shuffled.length; i++) {
      if (i % 13 === 7) dropped.push(shuffled[i]!);
      else delivered.push(shuffled[i]!);
    }

    const state = newReassembly(SESSION, payload.length);
    for (const w of delivered) ingest(state, w);
    expect(isComplete(state)).toBe(false);
    expect(missing(state).length).toBeGreaterThan(0);

    for (const w of dropped) ingest(state, w);
    expect(isComplete(state)).toBe(true);

    const restored = reassemble(state);
    expect(restored.length).toBe(payload.length);
    expect(sha256(restored)).toBe(sentSha);
  });

  it("reports the exact missing byte ranges when packets are lost", () => {
    const png = readFileSync(new URL("../../hello_world.png", import.meta.url));
    const payload = new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
    const packetSize = 633;
    const packets = packetize(payload, packetSize, SESSION);

    const state = newReassembly(SESSION, payload.length);
    const dropIdx = new Set([3, 17, 41]);
    for (let i = 0; i < packets.length; i++) {
      if (dropIdx.has(i)) continue;
      ingest(state, packets[i]!);
    }

    expect(isComplete(state)).toBe(false);
    const gaps = missing(state);
    expect(gaps.length).toBe(3);
    const expectedOffsets = [...dropIdx].sort((a, b) => a - b).map((i) => i * packetSize);
    for (let i = 0; i < expectedOffsets.length; i++) {
      expect(gaps[i]!.offset).toBe(expectedOffsets[i]!);
    }
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
