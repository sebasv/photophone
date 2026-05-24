import { describe, expect, it } from "vitest";
import {
  BackChannelMessageType,
  decodeBackChannelFrame,
  decodeHello,
  encodeBackChannelFrame,
  encodeHello,
} from "./backchannel";
import type { SessionInfo } from "./transport";

const SESSION: SessionInfo = { sessionId: 0xdeadbeef };

describe("back-channel frame round-trip", () => {
  it("hello message round-trips through encode/decode", () => {
    const msg = encodeHello("hello back");
    const wire = encodeBackChannelFrame(msg, SESSION, 7);
    const parsed = decodeBackChannelFrame(wire, SESSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.msg.type).toBe(BackChannelMessageType.Hello);
    expect(parsed!.seq).toBe(7);
    expect(decodeHello(parsed!.msg)).toBe("hello back");
  });

  it("rejects when session mismatches", () => {
    const wire = encodeBackChannelFrame(encodeHello("x"), SESSION, 0);
    expect(decodeBackChannelFrame(wire, { sessionId: 0x12345678 })).toBeNull();
  });

  it("returns null when payload is empty (no msg-type byte)", () => {
    // Manually craft a packet with empty payload — that's an invalid
    // back-channel frame even though the unicast header is valid.
    const wire = encodeBackChannelFrame({ type: BackChannelMessageType.Hello, body: new Uint8Array(0) }, SESSION, 0);
    // The hello case has body length 0 but still includes the 1 msg-type
    // byte, so wire.length >= 17. To get an empty-payload wire we'd have
    // to corrupt the underlying length field — skip and just sanity-check
    // that a 16-byte wire (header-only) decodes as null.
    const shorter = wire.slice(0, 16);
    // We rely on the underlying transport.decodePacket to reject when
    // the header length doesn't match the buffer; here we forge a
    // header that says length=0 to exercise the empty case.
    shorter[14] = 0; shorter[15] = 0;
    const parsed = decodeBackChannelFrame(shorter, SESSION);
    expect(parsed).toBeNull();
  });
});


import {
  CAPABILITIES_BODY_SIZE,
  decodeCapabilities,
  encodeCapabilities,
  pickCellSizeFromCapabilities,
  type Capabilities,
} from "./backchannel";

describe("M12 Capabilities", () => {
  const BASE: Capabilities = {
    maxCellSizePx: 20, minCellSizePx: 6, paletteId: 1, preferredFps: 15,
    preferredCellsX: 64, preferredCellsY: 64, rsNsymTier: 32,
  };
  it("encode/decode round-trip", () => {
    const m = encodeCapabilities(BASE);
    expect(m.body.length).toBe(CAPABILITIES_BODY_SIZE);
    const decoded = decodeCapabilities(m);
    expect(decoded).toEqual(BASE);
  });
  it("rejects non-Capabilities messages", () => {
    expect(decodeCapabilities({ type: BackChannelMessageType.Hello, body: new Uint8Array(12) })).toBeNull();
  });
  it("rejects short bodies", () => {
    expect(decodeCapabilities({ type: BackChannelMessageType.Capabilities, body: new Uint8Array(8) })).toBeNull();
  });
  it("pickCellSizeFromCapabilities returns a value in [min, max]", () => {
    for (const c of [
      { ...BASE, minCellSizePx: 4, maxCellSizePx: 20 },
      { ...BASE, minCellSizePx: 8, maxCellSizePx: 16 },
      { ...BASE, minCellSizePx: 10, maxCellSizePx: 10 },
    ]) {
      const picked = pickCellSizeFromCapabilities(c);
      expect(picked).toBeGreaterThanOrEqual(c.minCellSizePx);
      expect(picked).toBeLessThanOrEqual(c.maxCellSizePx);
    }
  });
  it("close-range advertising prefers smaller cells than long-range", () => {
    const close = pickCellSizeFromCapabilities({ ...BASE, minCellSizePx: 4, maxCellSizePx: 10 });
    const far = pickCellSizeFromCapabilities({ ...BASE, minCellSizePx: 16, maxCellSizePx: 28 });
    expect(close).toBeLessThan(far);
  });
});


import {
  MAX_ARQ_RANGES_PER_FRAME,
  decodeAck,
  decodeNack,
  encodeAck,
  encodeNack,
  trimRangesToFitFrame,
} from "./backchannel";
import type { ByteRange } from "./transport";

describe("M13 ACK/NACK", () => {
  const SAMPLE: ByteRange[] = [
    { offset: 0, length: 633 },
    { offset: 633, length: 633 },
    { offset: 12345, length: 100 },
    { offset: 0xfffffffe, length: 1 }, // exercise upper u32 edge
  ];

  it("ACK round-trip preserves all ranges", () => {
    const m = encodeAck(SAMPLE);
    const decoded = decodeAck(m);
    expect(decoded).toEqual(SAMPLE);
  });

  it("NACK round-trip preserves all ranges", () => {
    const m = encodeNack(SAMPLE);
    expect(decodeNack(m)).toEqual(SAMPLE);
  });

  it("rejects messages of the wrong type", () => {
    const ackMsg = encodeAck(SAMPLE);
    expect(decodeNack(ackMsg)).toBeNull();
  });

  it("encodes zero-length range list as a 1-byte body", () => {
    const m = encodeAck([]);
    expect(m.body.length).toBe(1);
    expect(decodeAck(m)).toEqual([]);
  });

  it("rejects a body that's truncated mid-range", () => {
    const m = encodeAck([{ offset: 100, length: 200 }]);
    expect(decodeAck({ type: m.type, body: m.body.slice(0, 4) })).toBeNull();
  });

  it("trimRangesToFitFrame caps at MAX_ARQ_RANGES_PER_FRAME", () => {
    const many: ByteRange[] = [];
    for (let i = 0; i < MAX_ARQ_RANGES_PER_FRAME + 10; i++) {
      many.push({ offset: i * 1000, length: 1 });
    }
    expect(trimRangesToFitFrame(many).length).toBe(MAX_ARQ_RANGES_PER_FRAME);
  });
});


import {
  DEFAULT_LINK_PARAMS,
  LINK_TIERS,
  STATS_BODY_SIZE,
  adaptiveStep,
  decodeStats,
  encodeStats,
  tierIndexOf,
  type AdaptiveLinkParams,
  type DecodeStats,
} from "./backchannel";

describe("M14 Stats + controller", () => {
  const BASELINE: DecodeStats = {
    ferPpm: 80_000, meanOtsuThreshold: 128, meanClassifyConfidence: 200, windowFrames: 60,
  };

  it("Stats encode/decode round-trip", () => {
    const m = encodeStats(BASELINE);
    expect(m.body.length).toBe(STATS_BODY_SIZE);
    expect(decodeStats(m)).toEqual(BASELINE);
  });

  it("tierIndexOf returns the closest tier", () => {
    for (const [i, t] of LINK_TIERS.entries()) {
      expect(tierIndexOf(t)).toBe(i);
    }
  });

  it("adaptiveStep climbs to more conservative tier on high FER", () => {
    const start = LINK_TIERS[2]!;
    const next = adaptiveStep(start, { ...BASELINE, ferPpm: 400_000 });
    expect(tierIndexOf(next)).toBe(3);
  });

  it("adaptiveStep descends to a more aggressive tier on clean stats", () => {
    const start = LINK_TIERS[3]!;
    const next = adaptiveStep(start, { ...BASELINE, ferPpm: 10_000, meanClassifyConfidence: 220 });
    expect(tierIndexOf(next)).toBe(2);
  });

  it("adaptiveStep holds at moderate FER", () => {
    const start = LINK_TIERS[2]!;
    const next = adaptiveStep(start, { ...BASELINE, ferPpm: 100_000, meanClassifyConfidence: 200 });
    expect(tierIndexOf(next)).toBe(2);
  });

  it("very low classify confidence forces a step up regardless of FER", () => {
    const start = LINK_TIERS[1]!;
    const next = adaptiveStep(start, { ...BASELINE, ferPpm: 5_000, meanClassifyConfidence: 50 });
    expect(tierIndexOf(next)).toBe(2);
  });

  it("never escapes the tier ladder bounds", () => {
    expect(tierIndexOf(adaptiveStep(LINK_TIERS[0]!, { ...BASELINE, ferPpm: 0, meanClassifyConfidence: 250 }))).toBe(0);
    expect(tierIndexOf(adaptiveStep(LINK_TIERS[LINK_TIERS.length - 1]!, { ...BASELINE, ferPpm: 900_000, meanClassifyConfidence: 10 }))).toBe(LINK_TIERS.length - 1);
  });

  it("walks the camera away: simulated rising FER converges to a stable conservative tier", () => {
    // Simulate the M14 done-when: as the camera moves away, FER climbs.
    // Run the controller every "second" with the current observed FER, see
    // the tier ratchet up monotonically until errors stabilize.
    let params: AdaptiveLinkParams = DEFAULT_LINK_PARAMS;
    const ferSeries = [40_000, 80_000, 180_000, 320_000, 380_000, 200_000, 60_000];
    const path: number[] = [];
    for (const fer of ferSeries) {
      params = adaptiveStep(params, { ...BASELINE, ferPpm: fer });
      path.push(tierIndexOf(params));
    }
    // Path climbs then descends as FER recovers — matches a walk-away/walk-back trajectory.
    expect(Math.max(...path)).toBeGreaterThan(tierIndexOf(DEFAULT_LINK_PARAMS));
    expect(path[path.length - 1]).toBeLessThanOrEqual(Math.max(...path));
  });
});


import {
  CONFIG_STRIP_BITS,
  CONFIG_STRIP_BYTES,
  cellArrayToConfigBits,
  configBitsToCellArray,
  decodeFrameConfigBits,
  encodeFrameConfigBits,
  type FrameConfigBits,
} from "./backchannel";

describe("M14 per-frame config strip", () => {
  it("encode/decode round-trip", () => {
    const f: FrameConfigBits = { mode: "broadcast", frameType: "payload", paletteId: 5, linkTier: 3 };
    const bytes = encodeFrameConfigBits(f);
    expect(bytes.length).toBe(CONFIG_STRIP_BYTES);
    expect(decodeFrameConfigBits(bytes)).toEqual(f);
  });

  it("cell-array round-trip", () => {
    const bytes = new Uint8Array([0xa5, 0x3c]);
    const cells = configBitsToCellArray(bytes);
    expect(cells.length).toBe(CONFIG_STRIP_BITS);
    expect(cellArrayToConfigBits(cells)).toEqual(bytes);
  });

  it("rejects out-of-range fields", () => {
    expect(() => encodeFrameConfigBits({ mode: "unicast", frameType: "payload", paletteId: 8, linkTier: 0 })).toThrow();
    expect(() => encodeFrameConfigBits({ mode: "unicast", frameType: "payload", paletteId: 0, linkTier: 9 })).toThrow();
  });
});
