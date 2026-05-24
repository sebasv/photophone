/**
 * Back-channel (receiver → sender) messages (M11–M14).
 *
 * The visual back-channel reuses the same physical layers as the main
 * data path: fiducials, calibration, payload cells, RS, magic-validated
 * orientation. What's different is *what* the bytes inside mean.
 *
 * A back-channel message is just a unicast wire packet whose payload
 * starts with a 1-byte message-type discriminator:
 *
 *   offset 0  | 16 | standard unicast packet header (transport.ts)
 *   offset 16 | 1  | msg_type
 *   offset 17 | N  | message body
 *
 * Routing this as a unicast packet means we get RS protection, magic
 * orientation, session_id filtering, and all the rest of the existing
 * pipeline for free. The `payload_offset` field is reused as a message
 * sequence number (sender can dedupe redundant message frames).
 */

import {
  HEADER_SIZE,
  decodePacket,
  encodePacket,
  type ParsedPacket,
  type SessionInfo,
} from "./transport";

export const BACKCHANNEL_BODY_OFFSET = HEADER_SIZE + 1;

export enum BackChannelMessageType {
  /** M11 done-when: receiver says hello so the sender can confirm the link. */
  Hello = 0x01,
  /** M12 handshake: receiver advertises its decoding capabilities. */
  Capabilities = 0x02,
  /** M13 ARQ: receiver reports byte ranges it already has. */
  Ack = 0x03,
  /** M13 ARQ: receiver lists byte ranges it still needs. */
  Nack = 0x04,
  /** M14 adaptation: receiver reports decode-quality stats. */
  Stats = 0x05,
}

export interface BackChannelMessage {
  type: BackChannelMessageType;
  /** Message-specific body bytes (msg-type-dependent layout). */
  body: Uint8Array;
}

/**
 * Build a wire-encoded back-channel frame ready to be RS-encoded and
 * rendered to a frame. `seq` is the message sequence number — used as
 * `payload_offset` in the underlying unicast header so the sender can
 * dedupe redundant message frames.
 */
export function encodeBackChannelFrame(
  msg: BackChannelMessage,
  session: SessionInfo,
  seq: number,
): Uint8Array {
  const payload = new Uint8Array(1 + msg.body.length);
  payload[0] = msg.type;
  payload.set(msg.body, 1);
  return encodePacket(seq >>> 0, payload, session);
}

/**
 * Parse a wire-decoded back-channel frame. Returns the message + the
 * unicast packet's sequence number (in `payloadOffset`).
 */
export function decodeBackChannelFrame(
  wire: Uint8Array,
  expectedSession: SessionInfo,
): { msg: BackChannelMessage; seq: number; parsed: ParsedPacket } | null {
  const parsed = decodePacket(wire, expectedSession);
  if (!parsed) return null;
  if (parsed.payload.length < 1) return null;
  const type = parsed.payload[0]! as BackChannelMessageType;
  const body = parsed.payload.slice(1);
  return { msg: { type, body }, seq: parsed.payloadOffset, parsed };
}

// -- M11 convenience: hello messages carry a UTF-8 string ----------------

export function encodeHello(text: string): BackChannelMessage {
  return { type: BackChannelMessageType.Hello, body: new TextEncoder().encode(text) };
}

export function decodeHello(msg: BackChannelMessage): string | null {
  if (msg.type !== BackChannelMessageType.Hello) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(msg.body);
}


// =========================================================================
// M12 — Capabilities message (handshake-time link negotiation)
// =========================================================================

/**
 * A receiver advertises what its decoder can comfortably handle, so the
 * sender can pick transmission parameters once at session start. After
 * M12 these values are static for the duration; M14 will allow them to
 * change mid-stream over the same back-channel.
 *
 * Wire body (12 bytes):
 *   offset 0 | 1 | max_cell_size_px   (u8)   largest cell pitch the camera resolves cleanly
 *   offset 1 | 1 | min_cell_size_px   (u8)   smallest pitch the camera still classifies reliably
 *   offset 2 | 1 | palette_id         (u8)   0=2-color, 1=4-color (2-bit), 2=8-color, ...
 *   offset 3 | 1 | preferred_fps      (u8)   sender shouldn't render faster than this
 *   offset 4 | 2 | preferred_cells_x  (u16)  grid width the receiver prefers
 *   offset 6 | 2 | preferred_cells_y  (u16)  grid height the receiver prefers
 *   offset 8 | 1 | rs_nsym_tier       (u8)   suggested NSYM (parity bytes per RS block)
 *   offset 9 | 1 | reserved           (u8)
 *   offset 10| 2 | reserved           (u16)
 */
export const CAPABILITIES_BODY_SIZE = 12;

export interface Capabilities {
  maxCellSizePx: number;
  minCellSizePx: number;
  paletteId: number;
  preferredFps: number;
  preferredCellsX: number;
  preferredCellsY: number;
  rsNsymTier: number;
}

export function encodeCapabilities(c: Capabilities): BackChannelMessage {
  const body = new Uint8Array(CAPABILITIES_BODY_SIZE);
  body[0] = c.maxCellSizePx & 0xff;
  body[1] = c.minCellSizePx & 0xff;
  body[2] = c.paletteId & 0xff;
  body[3] = c.preferredFps & 0xff;
  body[4] = (c.preferredCellsX >>> 8) & 0xff;
  body[5] = c.preferredCellsX & 0xff;
  body[6] = (c.preferredCellsY >>> 8) & 0xff;
  body[7] = c.preferredCellsY & 0xff;
  body[8] = c.rsNsymTier & 0xff;
  // bytes 9..11 reserved (zero-padded)
  return { type: BackChannelMessageType.Capabilities, body };
}

export function decodeCapabilities(msg: BackChannelMessage): Capabilities | null {
  if (msg.type !== BackChannelMessageType.Capabilities) return null;
  if (msg.body.length < CAPABILITIES_BODY_SIZE) return null;
  return {
    maxCellSizePx: msg.body[0]!,
    minCellSizePx: msg.body[1]!,
    paletteId: msg.body[2]!,
    preferredFps: msg.body[3]!,
    preferredCellsX: (msg.body[4]! << 8) | msg.body[5]!,
    preferredCellsY: (msg.body[6]! << 8) | msg.body[7]!,
    rsNsymTier: msg.body[8]!,
  };
}

/**
 * Sender-side helper: pick a concrete cell pitch from a receiver's
 * advertised range. We default to the midpoint, biased toward the smaller
 * side so we get more bits per frame when the receiver can handle it.
 */
export function pickCellSizeFromCapabilities(c: Capabilities): number {
  if (c.maxCellSizePx < c.minCellSizePx) return c.minCellSizePx;
  // Bias 40% from minimum toward max — more density when comfortable.
  const range = c.maxCellSizePx - c.minCellSizePx;
  return c.minCellSizePx + Math.floor(range * 0.4);
}


// =========================================================================
// M13 — ACK / NACK messages (bidirectional ARQ)
// =========================================================================

/**
 * Receiver tells the sender which byte ranges it already has (ACK) or
 * still needs (NACK). The sender uses ACKs to stop retransmitting bytes
 * the receiver already has, and uses NACKs to prioritize gaps.
 *
 * Wire body for both ACK and NACK:
 *   offset 0  | 1 | range_count (u8) — number of ranges that follow
 *   for each range:
 *     offset N   | 4 | offset (u32, big-endian)
 *     offset N+4 | 2 | length (u16, big-endian)
 *
 * Maximum ranges per frame is bounded by the underlying back-channel
 * frame's payload capacity. With u8 count + 6-byte entries, 32 ranges
 * fits comfortably under typical frame caps (193 bytes body). The TCP-
 * equivalent thinks of this as a SACK block list.
 */

import type { ByteRange } from "./transport";

const RANGE_ENTRY_SIZE = 6; // u32 offset + u16 length
export const MAX_ARQ_RANGES_PER_FRAME = 32;

function encodeRangeList(ranges: ReadonlyArray<ByteRange>): Uint8Array {
  if (ranges.length > 0xff) {
    throw new Error(`encodeRangeList: ${ranges.length} > 255 ranges per frame`);
  }
  const body = new Uint8Array(1 + ranges.length * RANGE_ENTRY_SIZE);
  body[0] = ranges.length;
  let off = 1;
  for (const r of ranges) {
    body[off] = (r.offset >>> 24) & 0xff;
    body[off + 1] = (r.offset >>> 16) & 0xff;
    body[off + 2] = (r.offset >>> 8) & 0xff;
    body[off + 3] = r.offset & 0xff;
    body[off + 4] = (r.length >>> 8) & 0xff;
    body[off + 5] = r.length & 0xff;
    off += RANGE_ENTRY_SIZE;
  }
  return body;
}

function decodeRangeList(body: Uint8Array): ByteRange[] | null {
  if (body.length < 1) return null;
  const n = body[0]!;
  if (body.length < 1 + n * RANGE_ENTRY_SIZE) return null;
  const out: ByteRange[] = [];
  let off = 1;
  for (let i = 0; i < n; i++) {
    const offset =
      ((body[off]! << 24) |
        (body[off + 1]! << 16) |
        (body[off + 2]! << 8) |
        body[off + 3]!) >>>
      0;
    const length = (body[off + 4]! << 8) | body[off + 5]!;
    out.push({ offset, length });
    off += RANGE_ENTRY_SIZE;
  }
  return out;
}

export function encodeAck(ranges: ReadonlyArray<ByteRange>): BackChannelMessage {
  return { type: BackChannelMessageType.Ack, body: encodeRangeList(ranges) };
}

export function decodeAck(msg: BackChannelMessage): ByteRange[] | null {
  if (msg.type !== BackChannelMessageType.Ack) return null;
  return decodeRangeList(msg.body);
}

export function encodeNack(ranges: ReadonlyArray<ByteRange>): BackChannelMessage {
  return { type: BackChannelMessageType.Nack, body: encodeRangeList(ranges) };
}

export function decodeNack(msg: BackChannelMessage): ByteRange[] | null {
  if (msg.type !== BackChannelMessageType.Nack) return null;
  return decodeRangeList(msg.body);
}

/**
 * Trim a list of byte ranges to the largest `MAX_ARQ_RANGES_PER_FRAME`
 * that fit in one back-channel frame. We keep the first N (longest
 * usually = highest-priority retransmission targets when callers sort
 * by gap size).
 */
export function trimRangesToFitFrame(
  ranges: ReadonlyArray<ByteRange>,
): ByteRange[] {
  if (ranges.length <= MAX_ARQ_RANGES_PER_FRAME) return ranges.slice();
  return ranges.slice(0, MAX_ARQ_RANGES_PER_FRAME);
}


// =========================================================================
// M14 — Stats message (continuous link adaptation)
// =========================================================================

/**
 * Receiver continuously reports decode-quality stats so the sender can
 * adapt density on the fly. We send a single 8-byte body:
 *
 *   offset 0 | 3 | frame_error_rate_ppm (u24)  — frames-failed-RS / total, in parts per million (0..1_000_000)
 *   offset 3 | 1 | mean_otsu_threshold  (u8)   — proxy for ambient lighting
 *   offset 4 | 1 | mean_classify_conf   (u8)   — 0=barely classifiable, 255=clean cells
 *   offset 5 | 2 | window_frames        (u16)  — over how many recent frames the stats average
 *   offset 7 | 1 | reserved
 *
 * Send these continuously at ~1 Hz; the sender's controller runs on
 * each one.
 */

export const STATS_BODY_SIZE = 8;

export interface DecodeStats {
  /** FER ratio expressed as parts per million (0..1_000_000). */
  ferPpm: number;
  meanOtsuThreshold: number;
  meanClassifyConfidence: number;
  windowFrames: number;
}

export function encodeStats(s: DecodeStats): BackChannelMessage {
  // ferPpm is up to 1_000_000 — needs 24 bits, not 16.
  const body = new Uint8Array(STATS_BODY_SIZE);
  body[0] = (s.ferPpm >>> 16) & 0xff;
  body[1] = (s.ferPpm >>> 8) & 0xff;
  body[2] = s.ferPpm & 0xff;
  body[3] = s.meanOtsuThreshold & 0xff;
  body[4] = s.meanClassifyConfidence & 0xff;
  body[5] = (s.windowFrames >>> 8) & 0xff;
  body[6] = s.windowFrames & 0xff;
  return { type: BackChannelMessageType.Stats, body };
}

export function decodeStats(msg: BackChannelMessage): DecodeStats | null {
  if (msg.type !== BackChannelMessageType.Stats) return null;
  if (msg.body.length < STATS_BODY_SIZE) return null;
  return {
    ferPpm: ((msg.body[0]! << 16) | (msg.body[1]! << 8) | msg.body[2]!) >>> 0,
    meanOtsuThreshold: msg.body[3]!,
    meanClassifyConfidence: msg.body[4]!,
    windowFrames: (msg.body[5]! << 8) | msg.body[6]!,
  };
}

// =========================================================================
// M14 — Adaptive controller
// =========================================================================

export interface AdaptiveLinkParams {
  /** Effective cell pitch the sender renders at (and the receiver expects). */
  cellSizePx: number;
  /** Reed-Solomon parity bytes per 255-byte block. */
  rsNsym: number;
  /** Frames per second the sender renders. */
  fps: number;
}

export const DEFAULT_LINK_PARAMS: AdaptiveLinkParams = {
  cellSizePx: 12,
  rsNsym: 32,
  fps: 5,
};

/**
 * Discrete tiers we step through. Picking from a small ladder rather
 * than continuously avoids oscillation and keeps the encoder warm-cache-
 * friendly. Each tier is a (cellSizePx, rsNsym, fps) triple.
 *
 * Tier 0 is the most aggressive (densest, smallest cells, lowest
 * parity); tier N is the most conservative.
 */
export const LINK_TIERS: ReadonlyArray<AdaptiveLinkParams> = [
  { cellSizePx: 8,  rsNsym: 16, fps: 10 },
  { cellSizePx: 10, rsNsym: 24, fps: 8 },
  { cellSizePx: 12, rsNsym: 32, fps: 5 },
  { cellSizePx: 16, rsNsym: 40, fps: 4 },
  { cellSizePx: 20, rsNsym: 48, fps: 3 },
  { cellSizePx: 24, rsNsym: 56, fps: 2 },
];

export function tierIndexOf(p: AdaptiveLinkParams): number {
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < LINK_TIERS.length; i++) {
    const t = LINK_TIERS[i]!;
    const d =
      Math.abs(t.cellSizePx - p.cellSizePx) * 4 +
      Math.abs(t.rsNsym - p.rsNsym);
    if (d < bestDelta) {
      bestDelta = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Pick the next link parameter tier given recent decode stats. Simple
 * threshold controller:
 *   - FER > 30% → step UP (more conservative)
 *   - FER < 5%  → step DOWN (more aggressive, if we have headroom)
 *   - else      → hold
 *
 * Plus a confidence backstop: very low classify confidence forces a
 * conservative step regardless of FER (the few frames that did decode
 * were lucky).
 */
export function adaptiveStep(
  current: AdaptiveLinkParams,
  stats: DecodeStats,
): AdaptiveLinkParams {
  const idx = tierIndexOf(current);
  const ferFraction = stats.ferPpm / 1_000_000;
  const confidence = stats.meanClassifyConfidence / 255;
  let next = idx;
  if (ferFraction > 0.3 || confidence < 0.3) {
    next = Math.min(idx + 1, LINK_TIERS.length - 1);
  } else if (ferFraction < 0.05 && confidence > 0.7) {
    next = Math.max(idx - 1, 0);
  }
  return LINK_TIERS[next]!;
}


// =========================================================================
// M14 — Per-frame config indicator (the 16-cell strip in framing.ts)
// =========================================================================

/**
 * The 16-cell config strip at the top of every frame (DESIGN.md §4)
 * carries decoder parameters that may change mid-stream. The receiver
 * decodes this strip *first*, with worst-case classifier parameters,
 * then applies the indicated config to the rest of the frame.
 *
 * 16 cells × 1 bit/cell = 16 bits = 2 bytes. We use a high-contrast
 * 2-colour palette (black vs the brightest palette colour) when
 * rendering this strip, so it remains classifiable when the rest of
 * the frame is at the edge of usability.
 *
 * Bit layout (LSB-first within each byte for ease of bit-by-bit decode):
 *   bit  0     : mode (0=unicast, 1=broadcast)
 *   bit  1     : frame_type (0=payload, 1=bootstrap-only)
 *   bits 2..4  : palette_id (0..7)
 *   bits 5..7  : link_tier (index into LINK_TIERS)
 *   bits 8..15 : reserved
 */

export interface FrameConfigBits {
  mode: "unicast" | "broadcast";
  frameType: "payload" | "bootstrap-only";
  paletteId: number;
  linkTier: number;
}

export const CONFIG_STRIP_BYTES = 2;
export const CONFIG_STRIP_BITS = CONFIG_STRIP_BYTES * 8;

export function encodeFrameConfigBits(c: FrameConfigBits): Uint8Array {
  if (c.paletteId < 0 || c.paletteId > 7) {
    throw new Error(`encodeFrameConfigBits: paletteId out of range: ${c.paletteId}`);
  }
  if (c.linkTier < 0 || c.linkTier > 7) {
    throw new Error(`encodeFrameConfigBits: linkTier out of range: ${c.linkTier}`);
  }
  let b0 = 0;
  if (c.mode === "broadcast") b0 |= 0x01;
  if (c.frameType === "bootstrap-only") b0 |= 0x02;
  b0 |= (c.paletteId & 0x07) << 2;
  b0 |= (c.linkTier & 0x07) << 5;
  return new Uint8Array([b0, 0]);
}

export function decodeFrameConfigBits(bytes: Uint8Array): FrameConfigBits | null {
  if (bytes.length < CONFIG_STRIP_BYTES) return null;
  const b0 = bytes[0]!;
  return {
    mode: b0 & 0x01 ? "broadcast" : "unicast",
    frameType: b0 & 0x02 ? "bootstrap-only" : "payload",
    paletteId: (b0 >>> 2) & 0x07,
    linkTier: (b0 >>> 5) & 0x07,
  };
}

/** Convenience: convert 2 config bytes to a 16-bit array for rendering one
 *  cell per bit at the config-strip positions. */
export function configBitsToCellArray(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(CONFIG_STRIP_BITS);
  for (let i = 0; i < CONFIG_STRIP_BYTES; i++) {
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = (bytes[i]! >> b) & 1;
    }
  }
  return out;
}

/** Inverse of configBitsToCellArray — reconstruct 2 bytes from 16 sampled bits. */
export function cellArrayToConfigBits(cells: ArrayLike<number>): Uint8Array {
  if (cells.length < CONFIG_STRIP_BITS) {
    throw new Error(`cellArrayToConfigBits: need ${CONFIG_STRIP_BITS} cells, got ${cells.length}`);
  }
  const out = new Uint8Array(CONFIG_STRIP_BYTES);
  for (let i = 0; i < CONFIG_STRIP_BYTES; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) {
      b |= ((cells[i * 8 + k]! as number) & 1) << k;
    }
    out[i] = b;
  }
  return out;
}
