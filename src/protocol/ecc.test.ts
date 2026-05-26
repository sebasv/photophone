import { describe, expect, it } from "vitest";
import { rsDecode, rsDecodeBlock, rsDecodeWireBytes, rsEncode, rsEncodeBlock, rsEncodeWireBytes, _gf } from "./ecc";

describe("GF(256) arithmetic", () => {
  it("multiplication is commutative and associative on a few samples", () => {
    expect(_gf.mul(3, 5)).toBe(_gf.mul(5, 3));
    expect(_gf.mul(_gf.mul(7, 11), 13)).toBe(_gf.mul(7, _gf.mul(11, 13)));
  });

  it("division reverses multiplication", () => {
    for (const a of [1, 2, 7, 11, 100, 255]) {
      for (const b of [1, 3, 13, 200]) {
        expect(_gf.div(_gf.mul(a, b), b)).toBe(a);
      }
    }
  });

  it("inv(x) * x === 1", () => {
    for (const x of [1, 2, 17, 100, 255]) {
      expect(_gf.mul(x, _gf.inv(x))).toBe(1);
    }
  });

  it("0 absorbs in multiplication; throws on inverse", () => {
    expect(_gf.mul(0, 42)).toBe(0);
    expect(() => _gf.inv(0)).toThrow();
  });
});

describe("rsEncodeBlock / rsDecodeBlock — single codeword", () => {
  it("round-trips a clean codeword (no errors)", () => {
    const msg = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const nsym = 8;
    const enc = rsEncodeBlock(msg, nsym);
    expect(enc.length).toBe(msg.length + nsym);
    expect(enc.subarray(0, msg.length)).toEqual(msg);
    const dec = rsDecodeBlock(enc, nsym);
    expect(dec).toEqual(msg);
  });

  it("corrects one byte error per codeword with nsym=4 (corrects up to 2)", () => {
    const msg = new Uint8Array([0x50, 0x48, 0x4f, 0x54, 1, 2, 3, 4, 5, 6, 7, 8]);
    const nsym = 4;
    const enc = rsEncodeBlock(msg, nsym);
    // Flip one byte.
    enc[5]! ^= 0xff;
    const dec = rsDecodeBlock(enc, nsym);
    expect(dec).toEqual(msg);
  });

  it("corrects two byte errors with nsym=4", () => {
    const msg = new Uint8Array([0x50, 0x48, 0x4f, 0x54, 1, 2, 3, 4, 5, 6, 7, 8]);
    const nsym = 4;
    const enc = rsEncodeBlock(msg, nsym);
    enc[3]! ^= 0x33;
    enc[9]! ^= 0xa5;
    const dec = rsDecodeBlock(enc, nsym);
    expect(dec).toEqual(msg);
  });

  it("throws when too many errors injected (nsym=4, 3 errors)", () => {
    const msg = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const nsym = 4;
    const enc = rsEncodeBlock(msg, nsym);
    enc[0]! ^= 0x11;
    enc[3]! ^= 0x22;
    enc[7]! ^= 0x33;
    expect(() => rsDecodeBlock(enc, nsym)).toThrow();
  });

  it("corrects errors in the parity bytes too", () => {
    const msg = new Uint8Array([10, 20, 30, 40]);
    const nsym = 6;
    const enc = rsEncodeBlock(msg, nsym);
    // Flip both a data byte and a parity byte.
    enc[1]! ^= 0xaa;
    enc[msg.length + 2]! ^= 0x55;
    const dec = rsDecodeBlock(enc, nsym);
    expect(dec).toEqual(msg);
  });

  it("handles 200-byte messages with nsym=32 → 16 correctable errors", () => {
    const msg = randomBytes(200, 0xc0de);
    const nsym = 32;
    const enc = rsEncodeBlock(msg, nsym);
    expect(enc.length).toBe(232);

    // Inject 12 byte errors (within the 16-correctable budget).
    const rng = makeRng(0xa1b2);
    const positions = new Set<number>();
    while (positions.size < 12) positions.add(rng() % enc.length);
    for (const p of positions) enc[p]! ^= (rng() % 254) + 1;

    const dec = rsDecodeBlock(enc, nsym);
    expect(dec).toEqual(msg);
  });
});

describe("rsEncode / rsDecode — chunked for arbitrary length", () => {
  it("round-trips a 500-byte message (chunked into 3 RS blocks at nsym=32)", () => {
    const msg = randomBytes(500, 0xbeef);
    const nsym = 32;
    const enc = rsEncode(msg, nsym);
    // 500 bytes / (255 - 32 = 223) = ceil(2.24) = 3 blocks; 3 * 255 = 765
    expect(enc.length).toBe(765);
    const dec = rsDecode(enc, nsym, msg.length);
    expect(dec).toEqual(msg);
  });

  it("M7 done-when: 500-byte message survives up to 12 byte errors per 255-byte block", () => {
    // With nsym=32, each 255-byte block tolerates up to 16 byte errors.
    // We inject 12 errors per block to guarantee correctability without
    // relying on uniform random distribution across blocks. 12/255 ≈ 4.7%
    // per-block byte error rate; for the equivalent cell error rate
    // figure see the M7 PR description.
    const msg = randomBytes(500, 0xdead);
    const nsym = 32;
    const enc = rsEncode(msg, nsym);
    const blockSize = 255;
    const errorsPerBlock = 12;

    const rng = makeRng(0xfeed);
    for (let blockStart = 0; blockStart < enc.length; blockStart += blockSize) {
      const positions = new Set<number>();
      while (positions.size < errorsPerBlock) {
        positions.add(blockStart + (rng() % blockSize));
      }
      for (const p of positions) enc[p]! ^= (rng() % 254) + 1;
    }

    const dec = rsDecode(enc, nsym, msg.length);
    expect(dec).toEqual(msg);
  });

  it("throws when a block exceeds the correction budget", () => {
    const msg = randomBytes(100, 0xbabe);
    const nsym = 4; // can correct 2 errors per block
    const enc = rsEncode(msg, nsym);
    // Inject 3 errors in the first block — exceeds capacity.
    enc[0]! ^= 0x11;
    enc[5]! ^= 0x22;
    enc[10]! ^= 0x33;
    expect(() => rsDecode(enc, nsym, msg.length)).toThrow();
  });
});



describe("M7 integration: wire packet → RS → simulated cell errors → RS recover", () => {
  it("recovers a transport-layer wire packet after ~5% byte corruption per block", async () => {
    const { encodePacket, decodePacket } = await import("./transport");
    const session = { sessionId: 0xdeadbeef };
    const payload = randomBytes(400, 0x1234);
    const wire = encodePacket(0, payload, session);

    const nsym = 32;
    const ecc = rsEncodeWireBytes(wire, nsym);

    // ECC is a multiple of 255. Each 255-byte block tolerates up to
    // 16 byte errors (nsym/2). Inject 12 per block, well within budget.
    const rng = makeRng(0x5a5a);
    const blockSize = 255;
    const errorsPerBlock = 12;
    for (let blockStart = 0; blockStart < ecc.length; blockStart += blockSize) {
      const positions = new Set<number>();
      while (positions.size < errorsPerBlock) {
        positions.add(blockStart + (rng() % blockSize));
      }
      for (const p of positions) ecc[p]! ^= (rng() % 254) + 1;
    }

    const recoveredWire = rsDecodeWireBytes(ecc, nsym);
    expect(recoveredWire).toEqual(wire);

    const packet = decodePacket(recoveredWire, session);
    expect(packet).not.toBeNull();
    expect(packet!.payload).toEqual(payload);
    expect(packet!.payloadOffset).toBe(0);
  });

  it("throws when a block's error count exceeds the correction budget", async () => {
    const { encodePacket } = await import("./transport");
    const session = { sessionId: 0xcafebabe };
    const wire = encodePacket(100, new Uint8Array([1, 2, 3, 4, 5]), session);

    const nsym = 4; // can correct 2 errors per 255-byte block
    const ecc = rsEncodeWireBytes(wire, nsym);
    // Inject 3 errors in the first 255-byte block — over budget.
    ecc[0]! ^= 0xaa;
    ecc[10]! ^= 0xbb;
    ecc[20]! ^= 0xcc;

    expect(() => rsDecodeWireBytes(ecc, nsym)).toThrow();
  });
});

function randomBytes(n: number, seed: number): Uint8Array {
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

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}


import {
  maxFrameDataBytes,
  rsDecodeFrame,
  rsEncodeFrame,
} from "./ecc";

describe("rsEncodeFrame / rsDecodeFrame — partial last block", () => {
  it("maxFrameDataBytes: full-multiple capacity matches rsEncode behaviour", () => {
    // 3 × 255 = 765 capacity with NSYM=32 → 3 full blocks, no partial.
    expect(maxFrameDataBytes(765, 32)).toBe(3 * (255 - 32));
  });

  it("maxFrameDataBytes: partial block adds (remaining - nsym) data bytes", () => {
    // 939 capacity (the default geometry) with NSYM=32:
    //   3 full blocks → 765 bytes
    //   174 partial   → 142 data + 32 parity
    //   total data    → 3*223 + 142 = 811
    expect(maxFrameDataBytes(939, 32)).toBe(3 * 223 + 142);
  });

  it("maxFrameDataBytes: partial smaller than nsym contributes zero", () => {
    // 765 + 20 capacity, NSYM=32: 20-byte tail has no room for data.
    expect(maxFrameDataBytes(785, 32)).toBe(3 * 223);
  });

  it("round-trip: 939-byte frame at default geometry — 811 data bytes recoverable", () => {
    const data = new Uint8Array(811);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff;
    const encoded = rsEncodeFrame(data, 939, 32);
    expect(encoded.length).toBe(939);
    const decoded = rsDecodeFrame(encoded, 939, 32);
    expect(decoded.length).toBe(811);
    expect(decoded).toEqual(data);
  });

  it("round-trip: partial-only short frame (no full blocks at all)", () => {
    // 100-byte capacity with NSYM=32: 0 full blocks + 100-byte partial
    // = 68 data bytes.
    const cap = 100;
    const data = new Uint8Array(maxFrameDataBytes(cap, 32));
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const encoded = rsEncodeFrame(data, cap, 32);
    expect(encoded.length).toBe(cap);
    expect(rsDecodeFrame(encoded, cap, 32)).toEqual(data);
  });

  it("round-trip: msg shorter than capacity gets zero-padded internally", () => {
    const data = new Uint8Array(50);
    for (let i = 0; i < data.length; i++) data[i] = 0xa5;
    const encoded = rsEncodeFrame(data, 939, 32);
    const decoded = rsDecodeFrame(encoded, 939, 32);
    expect(decoded.length).toBe(811);
    expect(decoded.subarray(0, 50)).toEqual(data);
    // rest is zero-padded.
    for (let i = 50; i < decoded.length; i++) expect(decoded[i]).toBe(0);
  });

  it("corrects up to nsym/2 errors per block, including the partial block", () => {
    const data = new Uint8Array(811);
    for (let i = 0; i < data.length; i++) data[i] = (i * 53) & 0xff;
    const encoded = rsEncodeFrame(data, 939, 32);
    // Inject 8 errors into each block. NSYM=32 corrects up to 16 errors.
    const corrupted = new Uint8Array(encoded);
    const errorOffsets = [
      0, 30, 60, 90, 120, 150, 180, 210,           // block 0 (255)
      256, 280, 300, 330, 360, 390, 420, 450,      // block 1
      512, 540, 570, 600, 630, 660, 690, 720,      // block 2
      770, 800, 830, 860, 880, 900, 920, 935,      // partial block (174 bytes, indices 765..938)
    ];
    for (const off of errorOffsets) corrupted[off]! ^= 0xff;
    const decoded = rsDecodeFrame(corrupted, 939, 32);
    expect(decoded).toEqual(data);
  });

  it("rejects when encoded length doesn't match capacity", () => {
    const encoded = new Uint8Array(900);
    expect(() => rsDecodeFrame(encoded, 939, 32)).toThrow();
  });

  it("rejects when msg exceeds frame capacity", () => {
    const tooBig = new Uint8Array(maxFrameDataBytes(939, 32) + 1);
    expect(() => rsEncodeFrame(tooBig, 939, 32)).toThrow();
  });
});
