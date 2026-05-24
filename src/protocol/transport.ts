/**
 * Transport (unicast).
 *
 * Each packet identifies itself by its **byte offset into the original
 * payload**, not by a sequence number. Same model TCP uses: the receiver
 * places each packet's bytes at the right slot of a growing buffer, tracks
 * received byte ranges as a sparse interval set, and reports gaps as
 * `{offset, length}` ranges.
 *
 * Why offsets instead of sequence numbers: link adaptation can change frame
 * byte capacity mid-transfer. Re-sending a "missing packet" at lower
 * capacity then requires multiple smaller packets to cover the original
 * byte range — which works automatically when packets address by offset.
 * If we instead used seq numbers, a single missing seq couldn't be split.
 *
 * No total-payload-size field. The receiver allocates dynamically (doubling
 * Uint8Array growth, amortized O(N)) and the user manually stops and saves
 * when their progress display matches what they expect. Auto-complete and
 * exact progress percentages will arrive with M11's back-channel or M12's
 * handshake — until then, manual save is the parsimonious answer. Broadcast
 * (M9) has its own termination signal: the fountain decoder peels until all
 * K source packets are recovered, with K carried in the bootstrap metadata
 * layer — unrelated to this header.
 *
 * Wire format (16-byte header):
 *
 *   offset 0  | 4 | magic "PHOT"
 *   offset 4  | 1 | version_major
 *   offset 5  | 1 | version_minor
 *   offset 6  | 4 | session_id (u32)
 *   offset 10 | 4 | payload_offset (u32) — byte index into the payload
 *   offset 14 | 2 | payload_len (u16) — bytes in this packet
 *   offset 16 | N | payload
 */

export const MAGIC = new Uint8Array([0x50, 0x48, 0x4f, 0x54]); // "PHOT"
export const VERSION_MAJOR = 1;
export const VERSION_MINOR = 0;
export const HEADER_SIZE = 16;

export const MAX_PACKET_PAYLOAD = 0xffff;
export const MAX_PAYLOAD_SIZE = 0xffffffff;

export interface SessionInfo {
  /** u32, random per transfer. Distinguishes this session from any other. */
  sessionId: number;
}

export interface ParsedPacket {
  sessionId: number;
  payloadOffset: number;
  payload: Uint8Array;
}

/** Half-open byte range [offset, offset + length). */
export interface ByteRange {
  offset: number;
  length: number;
}

export function encodePacket(
  payloadOffset: number,
  payload: Uint8Array,
  session: SessionInfo,
): Uint8Array {
  if (payload.length > MAX_PACKET_PAYLOAD) {
    throw new Error(
      `payload too large: ${payload.length} > ${MAX_PACKET_PAYLOAD}`,
    );
  }
  if (payloadOffset < 0 || payloadOffset > MAX_PAYLOAD_SIZE) {
    throw new Error(`payloadOffset out of range: ${payloadOffset}`);
  }
  if (payloadOffset + payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(
      `packet exceeds protocol max payload: ${payloadOffset}+${payload.length} > ${MAX_PAYLOAD_SIZE}`,
    );
  }

  const wire = new Uint8Array(HEADER_SIZE + payload.length);
  wire.set(MAGIC, 0);
  wire[4] = VERSION_MAJOR;
  wire[5] = VERSION_MINOR;
  writeU32BE(wire, 6, session.sessionId);
  writeU32BE(wire, 10, payloadOffset);
  writeU16BE(wire, 14, payload.length);
  wire.set(payload, HEADER_SIZE);
  return wire;
}

export function decodePacket(
  wire: Uint8Array,
  expectedSession: SessionInfo,
): ParsedPacket | null {
  if (wire.length < HEADER_SIZE) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (wire[i] !== MAGIC[i]) return null;
  }
  if (wire[4] !== VERSION_MAJOR) return null;
  const sessionId = readU32BE(wire, 6);
  if (sessionId !== expectedSession.sessionId) return null;
  const payloadOffset = readU32BE(wire, 10);
  const payloadLen = readU16BE(wire, 14);
  if (wire.length < HEADER_SIZE + payloadLen) return null;
  return {
    sessionId,
    payloadOffset,
    payload: wire.slice(HEADER_SIZE, HEADER_SIZE + payloadLen),
  };
}

/**
 * Eager packetization: split the whole payload into fixed-size packets up
 * front.
 */
export function packetize(
  payload: Uint8Array,
  packetPayloadSize: number,
  session: SessionInfo,
): Uint8Array[] {
  if (packetPayloadSize <= 0 || packetPayloadSize > MAX_PACKET_PAYLOAD) {
    throw new Error(`packetPayloadSize out of range: ${packetPayloadSize}`);
  }
  if (payload.length === 0) return [];

  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += packetPayloadSize) {
    const end = Math.min(offset + packetPayloadSize, payload.length);
    packets.push(encodePacket(offset, payload.slice(offset, end), session));
  }
  return packets;
}

export type IngestResult =
  | "accepted"
  | "duplicate"
  | "rejected-malformed"
  | "rejected-session"
  | "rejected-version";

export interface ReassemblyState {
  session: SessionInfo;
  /**
   * Dynamically-grown receive buffer. Capacity (.length) is always ≥
   * highestByte, but the meaningful prefix ends at highestByte.
   */
  buffer: Uint8Array;
  /** One past the highest byte index any received packet has touched. */
  highestByte: number;
  /** Contiguous received byte ranges, sorted by offset, non-overlapping. */
  received: ByteRange[];
}

/**
 * Build a reassembly state for `session`. The buffer grows on demand as
 * packets arrive; no upfront size is required because the protocol
 * doesn't carry one.
 */
export function newReassembly(session: SessionInfo): ReassemblyState {
  return {
    session,
    buffer: new Uint8Array(0),
    highestByte: 0,
    received: [],
  };
}

export function ingest(state: ReassemblyState, wire: Uint8Array): IngestResult {
  if (wire.length < HEADER_SIZE) return "rejected-malformed";
  for (let i = 0; i < MAGIC.length; i++) {
    if (wire[i] !== MAGIC[i]) return "rejected-malformed";
  }
  if (wire[4] !== VERSION_MAJOR) return "rejected-version";
  const sessionId = readU32BE(wire, 6);
  if (sessionId !== state.session.sessionId) return "rejected-session";

  const payloadOffset = readU32BE(wire, 10);
  const payloadLen = readU16BE(wire, 14);
  if (wire.length < HEADER_SIZE + payloadLen) return "rejected-malformed";
  if (payloadOffset + payloadLen > MAX_PAYLOAD_SIZE) return "rejected-malformed";

  if (rangeIsCovered(state.received, payloadOffset, payloadLen)) {
    return "duplicate";
  }

  // Grow the buffer (doubling) if the incoming bytes land past current capacity.
  const required = payloadOffset + payloadLen;
  if (required > state.buffer.length) {
    let newCap = Math.max(state.buffer.length * 2, 256);
    while (newCap < required) newCap *= 2;
    const grown = new Uint8Array(newCap);
    grown.set(state.buffer);
    state.buffer = grown;
  }
  if (required > state.highestByte) state.highestByte = required;

  for (let i = 0; i < payloadLen; i++) {
    state.buffer[payloadOffset + i] = wire[HEADER_SIZE + i]!;
  }
  state.received = mergeRange(state.received, payloadOffset, payloadLen);
  return "accepted";
}

/**
 * True when the received ranges form one contiguous run from offset 0 to
 * `highestByte`. This is the strongest "complete" claim we can make
 * without knowing the original payload size: every byte we've ever seen
 * the address of, we now have.
 */
export function isComplete(state: ReassemblyState): boolean {
  if (state.highestByte === 0) return false;
  return (
    state.received.length === 1 &&
    state.received[0]!.offset === 0 &&
    state.received[0]!.length === state.highestByte
  );
}

/**
 * Gaps between received ranges, below `highestByte`. No tail gap is
 * reported because the total payload size is unknown — any range past
 * `highestByte` is invisible until a packet lands there.
 */
export function missing(state: ReassemblyState): ByteRange[] {
  const gaps: ByteRange[] = [];
  let cursor = 0;
  for (const r of state.received) {
    if (r.offset > cursor) {
      gaps.push({ offset: cursor, length: r.offset - cursor });
    }
    cursor = r.offset + r.length;
  }
  return gaps;
}

/**
 * Return the contiguous prefix from offset 0. Throws if no packet at
 * offset 0 has been received yet.
 */
export function reassemble(state: ReassemblyState): Uint8Array {
  const first = state.received[0];
  if (!first || first.offset !== 0) {
    throw new Error("cannot reassemble: no contiguous prefix at offset 0");
  }
  return state.buffer.slice(0, first.length);
}

// -- Interval set helpers -------------------------------------------------

function rangeIsCovered(
  ranges: ByteRange[],
  offset: number,
  length: number,
): boolean {
  const end = offset + length;
  for (const r of ranges) {
    const rEnd = r.offset + r.length;
    if (r.offset <= offset && rEnd >= end) return true;
    if (rEnd <= offset) continue;
    return false;
  }
  return false;
}

/**
 * Merge [offset, offset+length) into the sorted, non-overlapping `ranges`.
 * Returns a fresh list (immutable update keeps the algorithm easy to reason
 * about and is cheap at the packet counts we deal with).
 */
function mergeRange(
  ranges: ByteRange[],
  offset: number,
  length: number,
): ByteRange[] {
  const merged: ByteRange[] = [];
  let curOffset = offset;
  let curEnd = offset + length;
  let placed = false;

  for (const r of ranges) {
    const rEnd = r.offset + r.length;
    if (rEnd < curOffset) {
      merged.push(r);
    } else if (curEnd < r.offset) {
      if (!placed) {
        merged.push({ offset: curOffset, length: curEnd - curOffset });
        placed = true;
      }
      merged.push(r);
    } else {
      curOffset = Math.min(curOffset, r.offset);
      curEnd = Math.max(curEnd, rEnd);
    }
  }
  if (!placed) {
    merged.push({ offset: curOffset, length: curEnd - curOffset });
  }
  return merged;
}

// -- Big-endian byte I/O --------------------------------------------------

function writeU16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function readU16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset]! << 8) | buf[offset + 1]!) & 0xffff;
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}
