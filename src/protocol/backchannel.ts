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
