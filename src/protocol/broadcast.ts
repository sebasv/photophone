/**
 * Broadcast wire frame (M10).
 *
 * One frame on the screen carries:
 *
 *   offset 0  | 4  | magic "PHOT"  (rotation discriminator — same as unicast)
 *   offset 4  | 1  | version_major (1)
 *   offset 5  | 1  | version_minor (0)
 *   offset 6  | 24 | bootstrap metadata (bootstrap.ts §4.1)
 *   offset 30 | 4  | fountain encoded-packet header (degree + seed)
 *   offset 34 | S  | XOR'd fountain payload (S = sourcePacketSize, fixed)
 *
 * The frame is the same total size that fits in the RS-protected region
 * (3 RS blocks × 223 data bytes = 669 data bytes, post-RS = 765). With
 * the 34-byte broadcast header, S_max = 635 bytes.
 *
 * Mode discrimination: the broadcast receive page expects every decoded
 * frame to be a broadcast frame; the unicast receive page expects every
 * decoded frame to be a unicast packet. Sharing the same magic gives
 * orientation discrimination for free; the magic is *not* a mode
 * discriminator — the receiver page knows its mode.
 */

import {
  BOOTSTRAP_SIZE,
  decodeBootstrap,
  encodeBootstrap,
  type BootstrapFields,
} from "./bootstrap";
import {
  ENCODED_HEADER_SIZE,
  deserializeEncoded,
  serializeEncoded,
  type EncodedPacket,
} from "./fountain";
import { MAGIC, VERSION_MAJOR, VERSION_MINOR } from "./transport";

export const BROADCAST_HEADER_SIZE =
  MAGIC.length + 2 + BOOTSTRAP_SIZE + ENCODED_HEADER_SIZE; // 4 + 2 + 24 + 4 = 34

export interface BroadcastFrame {
  bootstrap: BootstrapFields;
  encoded: EncodedPacket;
}

export function encodeBroadcastFrame(frame: BroadcastFrame): Uint8Array {
  const bootstrapBytes = encodeBootstrap(frame.bootstrap);
  const fountainBytes = serializeEncoded(frame.encoded);
  const out = new Uint8Array(BROADCAST_HEADER_SIZE + frame.encoded.xorPayload.length);
  out.set(MAGIC, 0);
  out[4] = VERSION_MAJOR;
  out[5] = VERSION_MINOR;
  out.set(bootstrapBytes, 6);
  out.set(fountainBytes, 6 + BOOTSTRAP_SIZE);
  return out;
}

/**
 * Parse a wire-decoded byte stream as a broadcast frame. `sourcePacketSize`
 * is the fixed source-packet size the session was bootstrapped with — the
 * receiver knows it from frame capacity, not from the wire (it's
 * implicit in the geometry × RS configuration).
 */
export function decodeBroadcastFrame(
  bytes: Uint8Array,
  sourcePacketSize: number,
): BroadcastFrame | null {
  if (bytes.length < BROADCAST_HEADER_SIZE + sourcePacketSize) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null;
  }
  if (bytes[4] !== VERSION_MAJOR) return null;
  const bootstrap = decodeBootstrap(bytes.subarray(6, 6 + BOOTSTRAP_SIZE));
  if (!bootstrap) return null;
  const fountainStart = 6 + BOOTSTRAP_SIZE;
  const fountainEnd = fountainStart + ENCODED_HEADER_SIZE + sourcePacketSize;
  if (bytes.length < fountainEnd) return null;
  const encoded = deserializeEncoded(bytes.subarray(fountainStart, fountainEnd));
  return { bootstrap, encoded };
}

/**
 * Source-packet size derivable from a frame geometry + NSYM. Both ends
 * of the broadcast pipeline must agree on this; computing from the same
 * formula on each side avoids transmitting it.
 *
 * = RS_DATA_BYTES − BROADCAST_HEADER_SIZE
 *
 * For the default 64×64 geometry and NSYM=32: 669 − 34 = 635 bytes.
 */
import { payloadCellCount, type FrameGeometry } from "./framing";
import { PALETTE_2BIT } from "./codec";
import { maxFrameDataBytes } from "./ecc";

export function sourcePacketSizeForGeometry(
  g: FrameGeometry,
  nsym: number,
): number {
  const capacityCells = payloadCellCount(g);
  const bitsPerCell = Math.log2(PALETTE_2BIT.colors.length);
  const capacityBytes = Math.floor((capacityCells * bitsPerCell) / 8);
  const rsDataBytes = maxFrameDataBytes(capacityBytes, nsym);
  return rsDataBytes - BROADCAST_HEADER_SIZE;
}
