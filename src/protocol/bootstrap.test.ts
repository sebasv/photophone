import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_SIZE,
  EXTENDED_SLOT_TOTAL,
  FILENAME_SLOT_COUNT,
  MIME_TABLE,
  SHA256_SIZE,
  SHA256_SLOT_COUNT,
  bootstrapMime,
  bootstrapReady,
  crc32,
  decodeBootstrap,
  decodeFilename,
  encodeBootstrap,
  filenameComplete,
  ingestBootstrap,
  mimeIndexFor,
  newBootstrapAccumulator,
  sha256Complete,
  type BootstrapFields,
} from "./bootstrap";

const BASE: BootstrapFields = {
  sessionId: 0xdeadbeef,
  sourceCount: 42,
  payloadSize: 26802,
  filenameHash: 0xcafef00d,
  mimeIndex: 1,
  extendedSlot: 0,
  extendedData: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
};

describe("encode/decode round-trip", () => {
  it("preserves every field", () => {
    const wire = encodeBootstrap(BASE);
    expect(wire.length).toBe(BOOTSTRAP_SIZE);
    const parsed = decodeBootstrap(wire);
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe(BASE.sessionId);
    expect(parsed!.sourceCount).toBe(BASE.sourceCount);
    expect(parsed!.payloadSize).toBe(BASE.payloadSize);
    expect(parsed!.filenameHash).toBe(BASE.filenameHash);
    expect(parsed!.mimeIndex).toBe(BASE.mimeIndex);
    expect(parsed!.extendedSlot).toBe(BASE.extendedSlot);
    expect(parsed!.extendedData).toEqual(BASE.extendedData);
  });

  it("rejects when CRC doesn't validate", () => {
    const wire = encodeBootstrap(BASE);
    wire[7] = (wire[7]! ^ 0x01) & 0xff; // flip one bit in source_count
    expect(decodeBootstrap(wire)).toBeNull();
  });

  it("rejects short input", () => {
    expect(decodeBootstrap(new Uint8Array(BOOTSTRAP_SIZE - 1))).toBeNull();
  });
});

describe("CRC32", () => {
  it("empty input is 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
  it("flipping one input bit changes the output", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(crc32(a)).not.toBe(crc32(b));
  });
  it("is deterministic across calls", () => {
    const data = new TextEncoder().encode("photophone");
    expect(crc32(data)).toBe(crc32(data));
  });
});

describe("BootstrapAccumulator", () => {
  it("ingests sha256 slots out of order and reports completion", () => {
    const acc = newBootstrapAccumulator({ ...BASE, extendedSlot: 0, extendedData: new Uint8Array([0, 0, 0, 0]) });
    const sha256 = new Uint8Array(SHA256_SIZE);
    for (let i = 0; i < SHA256_SIZE; i++) sha256[i] = (i * 7 + 3) & 0xff;

    const order = [3, 0, 7, 5, 2, 6, 1, 4];
    for (const slot of order) {
      const data = sha256.subarray(slot * 4, slot * 4 + 4);
      const r = ingestBootstrap(acc, { ...BASE, extendedSlot: slot, extendedData: data });
      expect(r).toBe("slot-updated");
    }
    expect(sha256Complete(acc)).toBe(true);
    expect(acc.sha256).toEqual(sha256);
  });

  it("ingests filename slots and recovers the UTF-8 name", () => {
    const acc = newBootstrapAccumulator(BASE);
    const filename = "héllo wörld.png";
    const fnBytes = new TextEncoder().encode(filename);
    const padded = new Uint8Array(64);
    padded.set(fnBytes);

    const slotsNeeded = Math.ceil(fnBytes.length / 4);
    for (let i = 0; i < slotsNeeded; i++) {
      ingestBootstrap(acc, {
        ...BASE,
        extendedSlot: SHA256_SLOT_COUNT + i,
        extendedData: padded.subarray(i * 4, i * 4 + 4),
      });
    }
    // Plus one slot of trailing zeros to mark termination.
    ingestBootstrap(acc, {
      ...BASE,
      extendedSlot: SHA256_SLOT_COUNT + slotsNeeded,
      extendedData: new Uint8Array(4),
    });

    expect(filenameComplete(acc)).toBe(true);
    expect(decodeFilename(acc)).toBe(filename);
  });

  it("treats every-slot-seen as terminator even without a zero byte", () => {
    const acc = newBootstrapAccumulator(BASE);
    for (let i = 0; i < FILENAME_SLOT_COUNT; i++) {
      ingestBootstrap(acc, {
        ...BASE,
        extendedSlot: SHA256_SLOT_COUNT + i,
        extendedData: new Uint8Array([0x41, 0x41, 0x41, 0x41]), // 'A'
      });
    }
    expect(filenameComplete(acc)).toBe(true);
    expect(decodeFilename(acc).length).toBe(64);
  });

  it("rejects packets from a different session_id", () => {
    const acc = newBootstrapAccumulator(BASE);
    expect(
      ingestBootstrap(acc, { ...BASE, sessionId: 0x12345678 }),
    ).toBe("session-mismatch");
  });

  it("rejects packets that disagree on the fixed fields", () => {
    const acc = newBootstrapAccumulator(BASE);
    expect(
      ingestBootstrap(acc, { ...BASE, payloadSize: 99999 }),
    ).toBe("fixed-field-mismatch");
  });

  it("bootstrapReady waits for both sha256 and filename to fill", () => {
    const acc = newBootstrapAccumulator(BASE);
    expect(bootstrapReady(acc)).toBe(false);
    // Fill sha256 only.
    for (let s = 0; s < SHA256_SLOT_COUNT; s++) {
      ingestBootstrap(acc, { ...BASE, extendedSlot: s, extendedData: new Uint8Array(4) });
    }
    expect(bootstrapReady(acc)).toBe(false);
    // Fill filename slot 0 with a zero byte (terminator).
    ingestBootstrap(acc, { ...BASE, extendedSlot: SHA256_SLOT_COUNT, extendedData: new Uint8Array(4) });
    expect(bootstrapReady(acc)).toBe(true);
  });
});

describe("mimeIndexFor", () => {
  it("maps common extensions to known indices", () => {
    expect(MIME_TABLE[mimeIndexFor("hello.png")]).toBe("image/png");
    expect(MIME_TABLE[mimeIndexFor("foo.JPEG")]).toBe("image/jpeg");
    expect(MIME_TABLE[mimeIndexFor("report.pdf")]).toBe("application/pdf");
    expect(MIME_TABLE[mimeIndexFor("notes.txt")]).toBe("text/plain");
    expect(MIME_TABLE[mimeIndexFor("anything.unknown")]).toBe("application/octet-stream");
  });

  it("falls back to fallback mime if extension is unknown but fallback is in the table", () => {
    expect(MIME_TABLE[mimeIndexFor("file.weird", "application/pdf")]).toBe("application/pdf");
  });
});

describe("integration: extended slot total covers sha256 + filename", () => {
  it("EXTENDED_SLOT_TOTAL = SHA256_SLOT_COUNT + FILENAME_SLOT_COUNT", () => {
    expect(EXTENDED_SLOT_TOTAL).toBe(SHA256_SLOT_COUNT + FILENAME_SLOT_COUNT);
  });
});

describe("bootstrapMime", () => {
  it("returns the MIME for the accumulator's index", () => {
    const acc = newBootstrapAccumulator({ ...BASE, mimeIndex: 2 });
    expect(bootstrapMime(acc)).toBe(MIME_TABLE[2]);
  });
});
