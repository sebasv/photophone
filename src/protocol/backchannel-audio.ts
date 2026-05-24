/**
 * Audio back-channel transport (M11b).
 *
 * Wraps a back-channel message in an FSK on-air frame:
 *   BackChannelMessage  →  encodeBackChannelFrame (transport.ts wire)
 *                        →  fskFrame (preamble + sync + length + body + CRC)
 *
 * The visual back-channel (M11) wraps the same BackChannelMessage in
 * RS + cells. Both share the same data layer; only the physical layer
 * differs. M12-M14 don't care which modality is in use.
 */

import {
  decodeBackChannelFrame,
  encodeBackChannelFrame,
  type BackChannelMessage,
} from "./backchannel";
import { fskFrame, fskUnframe } from "./fsk";
import type { SessionInfo } from "./transport";

/** Serialise a back-channel message to on-air FSK bytes. */
export function audioBackChannelEncode(
  msg: BackChannelMessage,
  session: SessionInfo,
  seq: number,
): Uint8Array {
  const wire = encodeBackChannelFrame(msg, session, seq);
  return fskFrame(wire);
}

/** Parse FSK-recovered bytes back into a back-channel message. */
export function audioBackChannelDecode(
  airBytes: Uint8Array,
  expectedSession: SessionInfo,
): ReturnType<typeof decodeBackChannelFrame> {
  const wire = fskUnframe(airBytes);
  if (!wire) return null;
  return decodeBackChannelFrame(wire, expectedSession);
}
