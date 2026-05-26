import { describe, expect, it } from "vitest";
import {
  BackChannelMessageType,
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  bytesToCells,
  cellsToBytes,
  decodeBackChannelFrame,
  decodeHello,
  encodeBackChannelFrame,
  encodeHello,
  payloadCellCount,
  rsDecodeFrame,
  rsEncodeFrame,
  type SessionInfo,
} from "./index";

const NSYM = 32;
const SESSION: SessionInfo = { sessionId: 0xb4cbac0c };

/**
 * Same pipeline a back-channel deployment runs:
 *   encodeBackChannelFrame -> rsEncode -> bytes-to-cells -> cells-to-bytes
 *   -> rsDecodeAll -> decodeBackChannelFrame
 * No camera, no rendering — proves the byte layer is sound.
 */
it("M11 back-channel hello message round-trips through the full byte pipeline", () => {
  const original = encodeHello("hello back");
  const wire = encodeBackChannelFrame(original, SESSION, 0);
  const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
  const capacityBytes = (capacityCells * 2) / 8;
  const framePayload = rsEncodeFrame(wire, capacityBytes, NSYM);
  const cells = bytesToCells(framePayload, PALETTE_2BIT);
  const sampled = cellsToBytes(cells, PALETTE_2BIT);
  const decoded = rsDecodeFrame(sampled.subarray(0, capacityBytes), capacityBytes, NSYM);

  const parsed = decodeBackChannelFrame(decoded, SESSION);
  expect(parsed).not.toBeNull();
  expect(parsed!.msg.type).toBe(BackChannelMessageType.Hello);
  expect(parsed!.seq).toBe(0);
  expect(decodeHello(parsed!.msg)).toBe("hello back");
});

describe("seq dedup contract", () => {
  it("two messages at different seqs decode to their own bodies", () => {
    const m1 = encodeBackChannelFrame(encodeHello("first"), SESSION, 1);
    const m2 = encodeBackChannelFrame(encodeHello("second"), SESSION, 2);
    const p1 = decodeBackChannelFrame(m1, SESSION)!;
    const p2 = decodeBackChannelFrame(m2, SESSION)!;
    expect(p1.seq).toBe(1);
    expect(p2.seq).toBe(2);
    expect(decodeHello(p1.msg)).toBe("first");
    expect(decodeHello(p2.msg)).toBe("second");
  });
});
