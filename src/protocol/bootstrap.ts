/**
 * Broadcast bootstrap metadata (DESIGN.md §4.1).
 *
 * A 24-byte block embedded in every broadcast frame so a receiver tuning
 * in mid-stream can sync without coordination:
 *
 *   offset 0  | 4 | session_id (u32)
 *   offset 4  | 2 | source_count K (u16)
 *   offset 6  | 4 | payload_size (u32)
 *   offset 10 | 4 | filename_hash (u32) — first 4 bytes of sha256(filename)
 *   offset 14 | 1 | mime_index (u8) — small enum into MIME_TABLE
 *   offset 15 | 1 | extended_slot (u8) — which extended-metadata frame this is
 *   offset 16 | 4 | extended_data (4 bytes of the rotating field)
 *   offset 20 | 4 | bootstrap_crc32 (u32) — CRC32 over bytes 0..19
 *
 * Extended slots rotate through 24 distinct frames per cycle:
 *   slots 0..7   carry the 32-byte sha256 of the payload (4 bytes per slot)
 *   slots 8..23  carry the UTF-8 filename, up to 64 bytes (4 bytes per slot)
 *
 * A receiver accumulates slots until both arrays are filled — once that's
 * done it can save the file with the correct name and verify integrity.
 * Until then it can still ingest fountain packets; it just can't save.
 */

export const BOOTSTRAP_SIZE = 24;
export const SHA256_SIZE = 32;
export const FILENAME_MAX = 64;
export const SHA256_SLOT_COUNT = 8; // slots 0..7
export const FILENAME_SLOT_COUNT = 16; // slots 8..23
export const EXTENDED_SLOT_TOTAL = SHA256_SLOT_COUNT + FILENAME_SLOT_COUNT;

/**
 * Tiny MIME enum. Sender picks the closest match; unknown types fall back
 * to index 0 (octet-stream). Receivers use this to pick a UI hint and a
 * download Content-Type — the trailing-dot filename gives the OS the
 * actual file-type cue.
 */
export const MIME_TABLE: ReadonlyArray<string> = [
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "application/json",
  "audio/mpeg",
  "audio/wav",
  "video/mp4",
];

export function mimeIndexFor(filename: string, fallback: string = ""): number {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const extMime: Record<string, number> = {
    png: 1, jpg: 2, jpeg: 2, gif: 3, webp: 4, svg: 5,
    pdf: 6, txt: 7, json: 8,
    mp3: 9, wav: 10, mp4: 11,
  };
  if (ext in extMime) return extMime[ext]!;
  if (fallback) {
    const fbIdx = MIME_TABLE.indexOf(fallback);
    if (fbIdx >= 0) return fbIdx;
  }
  return 0;
}

export interface BootstrapFields {
  sessionId: number;
  sourceCount: number;
  payloadSize: number;
  filenameHash: number;
  mimeIndex: number;
  extendedSlot: number;
  /** Exactly 4 bytes (rotating slot data). */
  extendedData: Uint8Array;
}

export function encodeBootstrap(f: BootstrapFields): Uint8Array {
  if (f.extendedData.length !== 4) {
    throw new Error(`encodeBootstrap: extendedData must be 4 bytes, got ${f.extendedData.length}`);
  }
  if (f.extendedSlot < 0 || f.extendedSlot >= EXTENDED_SLOT_TOTAL) {
    throw new Error(`encodeBootstrap: extendedSlot out of range: ${f.extendedSlot}`);
  }
  if (f.sourceCount < 0 || f.sourceCount > 0xffff) {
    throw new Error(`encodeBootstrap: sourceCount out of u16 range: ${f.sourceCount}`);
  }
  const out = new Uint8Array(BOOTSTRAP_SIZE);
  writeU32BE(out, 0, f.sessionId >>> 0);
  writeU16BE(out, 4, f.sourceCount);
  writeU32BE(out, 6, f.payloadSize >>> 0);
  writeU32BE(out, 10, f.filenameHash >>> 0);
  out[14] = f.mimeIndex & 0xff;
  out[15] = f.extendedSlot & 0xff;
  out.set(f.extendedData, 16);
  writeU32BE(out, 20, crc32(out.subarray(0, 20)));
  return out;
}

export function decodeBootstrap(bytes: Uint8Array): BootstrapFields | null {
  if (bytes.length < BOOTSTRAP_SIZE) return null;
  const claimedCrc = readU32BE(bytes, 20);
  const actualCrc = crc32(bytes.subarray(0, 20));
  if (claimedCrc !== actualCrc) return null;
  return {
    sessionId: readU32BE(bytes, 0),
    sourceCount: readU16BE(bytes, 4),
    payloadSize: readU32BE(bytes, 6),
    filenameHash: readU32BE(bytes, 10),
    mimeIndex: bytes[14]!,
    extendedSlot: bytes[15]!,
    extendedData: bytes.slice(16, 20),
  };
}

/**
 * Accumulates extended-metadata slots from successive frames of the same
 * session. Once `sha256Complete` and `filenameComplete` both flip true,
 * the receiver has enough to save the file with its real name and verify
 * the payload against the broadcast sha256.
 */
export interface BootstrapAccumulator {
  sessionId: number;
  sourceCount: number;
  payloadSize: number;
  filenameHash: number;
  mimeIndex: number;
  sha256: Uint8Array;
  sha256SlotSeen: boolean[];
  filename: Uint8Array;
  filenameSlotSeen: boolean[];
  /** Bytes of the filename received so far (in slot order). Excludes trailing zeros. */
  filenameLen: number;
}

export function newBootstrapAccumulator(seed: BootstrapFields): BootstrapAccumulator {
  return {
    sessionId: seed.sessionId,
    sourceCount: seed.sourceCount,
    payloadSize: seed.payloadSize,
    filenameHash: seed.filenameHash,
    mimeIndex: seed.mimeIndex,
    sha256: new Uint8Array(SHA256_SIZE),
    sha256SlotSeen: new Array(SHA256_SLOT_COUNT).fill(false),
    filename: new Uint8Array(FILENAME_MAX),
    filenameSlotSeen: new Array(FILENAME_SLOT_COUNT).fill(false),
    filenameLen: 0,
  };
}

export type BootstrapIngestResult =
  | "session-mismatch"
  | "fixed-field-mismatch"
  | "slot-updated"
  | "slot-duplicate";

export function ingestBootstrap(
  acc: BootstrapAccumulator,
  f: BootstrapFields,
): BootstrapIngestResult {
  if (f.sessionId !== acc.sessionId) return "session-mismatch";
  if (
    f.sourceCount !== acc.sourceCount ||
    f.payloadSize !== acc.payloadSize ||
    f.filenameHash !== acc.filenameHash ||
    f.mimeIndex !== acc.mimeIndex
  ) {
    return "fixed-field-mismatch";
  }
  const slot = f.extendedSlot;
  if (slot < SHA256_SLOT_COUNT) {
    if (acc.sha256SlotSeen[slot]) return "slot-duplicate";
    acc.sha256.set(f.extendedData, slot * 4);
    acc.sha256SlotSeen[slot] = true;
    return "slot-updated";
  }
  const fnSlot = slot - SHA256_SLOT_COUNT;
  if (fnSlot < FILENAME_SLOT_COUNT) {
    if (acc.filenameSlotSeen[fnSlot]) return "slot-duplicate";
    acc.filename.set(f.extendedData, fnSlot * 4);
    acc.filenameSlotSeen[fnSlot] = true;
    // Recompute trimmed length: first run of zeros from the end of seen slots.
    let maxSeen = 0;
    for (let i = 0; i < FILENAME_SLOT_COUNT; i++) {
      if (acc.filenameSlotSeen[i]) maxSeen = (i + 1) * 4;
    }
    let trimmed = maxSeen;
    while (trimmed > 0 && acc.filename[trimmed - 1] === 0) trimmed--;
    acc.filenameLen = trimmed;
    return "slot-updated";
  }
  return "slot-duplicate";
}

export function sha256Complete(acc: BootstrapAccumulator): boolean {
  return acc.sha256SlotSeen.every(Boolean);
}

export function filenameComplete(acc: BootstrapAccumulator): boolean {
  // Filename can be shorter than the maximum; we consider it complete once
  // we've seen a slot containing a null terminator OR all 16 slots.
  if (acc.filenameSlotSeen.every(Boolean)) return true;
  for (let i = 0; i < FILENAME_SLOT_COUNT; i++) {
    if (!acc.filenameSlotSeen[i]) continue;
    // Slot data is at filename[i*4 .. i*4+4]. If it contains a zero, that's
    // the terminator and all later slots aren't meaningful for the name.
    for (let j = 0; j < 4; j++) {
      if (acc.filename[i * 4 + j] === 0) return true;
    }
  }
  return false;
}

export function bootstrapReady(acc: BootstrapAccumulator): boolean {
  return sha256Complete(acc) && filenameComplete(acc);
}

export function decodeFilename(acc: BootstrapAccumulator): string {
  if (acc.filenameLen === 0) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(
    acc.filename.subarray(0, acc.filenameLen),
  );
}

export function bootstrapMime(acc: BootstrapAccumulator): string {
  return MIME_TABLE[acc.mimeIndex] ?? MIME_TABLE[0]!;
}

// -- CRC32 (IEEE 802.3, table-driven) -------------------------------------

const CRC32_TABLE: Uint32Array = (function build() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// -- Big-endian I/O -------------------------------------------------------

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
