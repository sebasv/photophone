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
