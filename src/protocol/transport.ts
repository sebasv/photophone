/**
 * Transport (unicast).
 *
 * Each packet identifies itself by its **byte offset into the original
 * payload**, not by a sequence number. Same model TCP uses: the receiver
 * places each packet's bytes at the right slot of a pre-allocated buffer,
 * tracks received byte ranges as a sparse interval set, and reports gaps as
 * `{offset, length}` ranges.
 *
 * Why offsets instead of sequence numbers: link adaptation can change frame
 * byte capacity mid-transfer. Re-sending a "missing packet" at lower
 * capacity then requires multiple smaller packets to cover the original
 * byte range — which works automatically when packets address by offset.
 * If we instead used seq numbers, a single missing seq couldn't be split.
 *
 * Wire format (16-byte header, same total size as before):
 *
 *   offset 0  | 4 | magic "PHOT"
 *   offset 4  | 1 | version_major
 *   offset 5  | 1 | version_minor
 *   offset 6  | 4 | session_id (u32)
 *   offset 10 | 4 | payload_offset (u32) — byte index into the payload
 *   offset 14 | 2 | payload_len (u16) — bytes in this packet
 *   offset 16 | N | payload
 *
 * Broadcast / fountain mode (M9+) will reinterpret `payload_offset` as a
 * fountain encoded-packet header (degree + PRNG seed), selected by the
 * frame's `mode` bit. The header field is otherwise identical.
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
 * front. Useful for tests and for the static-config case. M12 (adaptation)
 * will add a streaming packetizer that produces one packet at a time sized
 * to the current frame's capacity.
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
  | "out-of-bounds"
  | "rejected-malformed"
  | "rejected-session"
  | "rejected-version";

export interface ReassemblyState {
  session: SessionInfo;
  /** Total payload size in bytes; from bootstrap metadata in production. */
  payloadSize: number;
  /** Pre-allocated receive buffer, sized to payloadSize. */
  buffer: Uint8Array;
  /** Contiguous received byte ranges, sorted by offset, non-overlapping. */
  received: ByteRange[];
}

export function newReassembly(
  session: SessionInfo,
  payloadSize: number,
): ReassemblyState {
  if (payloadSize < 0 || payloadSize > MAX_PAYLOAD_SIZE) {
    throw new Error(`payloadSize out of range: ${payloadSize}`);
  }
  return {
    session,
    payloadSize,
    buffer: new Uint8Array(payloadSize),
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
  if (payloadOffset + payloadLen > state.payloadSize) return "out-of-bounds";

  // Fully-covered incoming range → no-op duplicate.
  if (rangeIsCovered(state.received, payloadOffset, payloadLen)) {
    return "duplicate";
  }

  // Copy bytes into the buffer. Re-copying overlapping bytes is fine —
  // for a given session_id, those bytes are identical by construction.
  for (let i = 0; i < payloadLen; i++) {
    state.buffer[payloadOffset + i] = wire[HEADER_SIZE + i]!;
  }
  state.received = mergeRange(state.received, payloadOffset, payloadLen);
  return "accepted";
}

export function isComplete(state: ReassemblyState): boolean {
  if (state.payloadSize === 0) return true;
  return (
    state.received.length === 1 &&
    state.received[0]!.offset === 0 &&
    state.received[0]!.length === state.payloadSize
  );
}

/** Gaps between received ranges, including any gap at the tail. */
export function missing(state: ReassemblyState): ByteRange[] {
  const gaps: ByteRange[] = [];
  let cursor = 0;
  for (const r of state.received) {
    if (r.offset > cursor) {
      gaps.push({ offset: cursor, length: r.offset - cursor });
    }
    cursor = r.offset + r.length;
  }
  if (cursor < state.payloadSize) {
    gaps.push({ offset: cursor, length: state.payloadSize - cursor });
  }
  return gaps;
}

export function reassemble(state: ReassemblyState): Uint8Array {
  if (!isComplete(state)) {
    const gaps = missing(state)
      .map((g) => `[${g.offset}+${g.length}]`)
      .join(", ");
    throw new Error(`cannot reassemble: missing ranges ${gaps}`);
  }
  return state.buffer;
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
