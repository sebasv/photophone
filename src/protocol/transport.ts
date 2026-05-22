/**
 * Transport (unicast / source packets).
 *
 * Splits a payload into numbered packets, serializes each with a fixed 16-byte
 * header, and reassembles them on the receiver side regardless of arrival
 * order. Tolerates duplicates, drops, and reorderings — the receiver can
 * always report which `seq` numbers it's still missing.
 *
 * This is the unicast mode. M9 adds a fountain-coded variant (broadcast).
 */

export const MAGIC = new Uint8Array([0x50, 0x48, 0x4f, 0x54]); // "PHOT"
export const VERSION_MAJOR = 1;
export const VERSION_MINOR = 0;
export const HEADER_SIZE = 16;

export const MAX_PACKET_PAYLOAD = 0xffff;
export const MAX_PACKETS = 0xffff;

export interface SessionInfo {
  /** u32, random per transfer. Distinguishes this session from any other. */
  sessionId: number;
}

export interface ParsedPacket {
  sessionId: number;
  seq: number;
  total: number;
  payload: Uint8Array;
}

export function encodePacket(
  seq: number,
  total: number,
  payload: Uint8Array,
  session: SessionInfo,
): Uint8Array {
  if (payload.length > MAX_PACKET_PAYLOAD) {
    throw new Error(`payload too large: ${payload.length} > ${MAX_PACKET_PAYLOAD}`);
  }
  if (seq < 0 || seq > 0xffff) throw new Error(`seq out of range: ${seq}`);
  if (total < 0 || total > 0xffff) throw new Error(`total out of range: ${total}`);

  const wire = new Uint8Array(HEADER_SIZE + payload.length);
  wire.set(MAGIC, 0);
  wire[4] = VERSION_MAJOR;
  wire[5] = VERSION_MINOR;
  writeU32BE(wire, 6, session.sessionId);
  writeU16BE(wire, 10, seq);
  writeU16BE(wire, 12, total);
  writeU16BE(wire, 14, payload.length);
  wire.set(payload, HEADER_SIZE);
  return wire;
}

/**
 * Decode and validate a wire packet. Returns null if the packet is malformed,
 * has the wrong magic / version, or belongs to a different session.
 *
 * The `expectedSession` filter is what prevents crosstalk between simultaneous
 * Photophone sessions in the same physical space.
 */
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
  const seq = readU16BE(wire, 10);
  const total = readU16BE(wire, 12);
  const payloadLen = readU16BE(wire, 14);
  if (wire.length < HEADER_SIZE + payloadLen) return null;
  return {
    sessionId,
    seq,
    total,
    payload: wire.slice(HEADER_SIZE, HEADER_SIZE + payloadLen),
  };
}

export function packetize(
  payload: Uint8Array,
  packetPayloadSize: number,
  session: SessionInfo,
): Uint8Array[] {
  if (packetPayloadSize <= 0 || packetPayloadSize > MAX_PACKET_PAYLOAD) {
    throw new Error(`packetPayloadSize out of range: ${packetPayloadSize}`);
  }
  if (payload.length === 0) return [];
  const total = Math.ceil(payload.length / packetPayloadSize);
  if (total > MAX_PACKETS) {
    throw new Error(
      `payload too large: ${total} packets exceeds maximum ${MAX_PACKETS}`,
    );
  }
  const packets: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const start = i * packetPayloadSize;
    const end = Math.min(start + packetPayloadSize, payload.length);
    packets.push(encodePacket(i, total, payload.slice(start, end), session));
  }
  return packets;
}

export type IngestResult =
  | "accepted"
  | "duplicate"
  | "rejected-malformed"
  | "rejected-session"
  | "rejected-version"
  | "rejected-inconsistent-total";

export interface ReassemblyState {
  session: SessionInfo;
  expectedTotal: number | null;
  received: Map<number, Uint8Array>;
}

export function newReassembly(session: SessionInfo): ReassemblyState {
  return { session, expectedTotal: null, received: new Map() };
}

export function ingest(state: ReassemblyState, wire: Uint8Array): IngestResult {
  if (wire.length < HEADER_SIZE) return "rejected-malformed";
  for (let i = 0; i < MAGIC.length; i++) {
    if (wire[i] !== MAGIC[i]) return "rejected-malformed";
  }
  if (wire[4] !== VERSION_MAJOR) return "rejected-version";
  const sessionId = readU32BE(wire, 6);
  if (sessionId !== state.session.sessionId) return "rejected-session";

  const seq = readU16BE(wire, 10);
  const total = readU16BE(wire, 12);
  const payloadLen = readU16BE(wire, 14);
  if (wire.length < HEADER_SIZE + payloadLen) return "rejected-malformed";

  if (state.expectedTotal === null) {
    state.expectedTotal = total;
  } else if (state.expectedTotal !== total) {
    return "rejected-inconsistent-total";
  }

  if (state.received.has(seq)) return "duplicate";
  state.received.set(seq, wire.slice(HEADER_SIZE, HEADER_SIZE + payloadLen));
  return "accepted";
}

export function isComplete(state: ReassemblyState): boolean {
  return (
    state.expectedTotal !== null && state.received.size === state.expectedTotal
  );
}

/** Sequence numbers known to be missing. Empty if no packet has been seen yet. */
export function missing(state: ReassemblyState): number[] {
  if (state.expectedTotal === null) return [];
  const out: number[] = [];
  for (let i = 0; i < state.expectedTotal; i++) {
    if (!state.received.has(i)) out.push(i);
  }
  return out;
}

export function reassemble(state: ReassemblyState): Uint8Array {
  if (!isComplete(state)) {
    throw new Error(
      `cannot reassemble: missing seq numbers ${missing(state).join(",")}`,
    );
  }
  const total = state.expectedTotal!;
  let totalLen = 0;
  for (let i = 0; i < total; i++) totalLen += state.received.get(i)!.length;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < total; i++) {
    const part = state.received.get(i)!;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

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
