import { describe, expect, it } from "vitest";
import {
  BROADCAST_HEADER_SIZE,
  encodeBroadcastFrame,
  decodeBroadcastFrame,
  type BroadcastFrame,
} from "./broadcast";

const S = 200; // source packet size for tests
const baseFrame: BroadcastFrame = {
  bootstrap: {
    sessionId: 0xdeadbeef,
    sourceCount: 10,
    payloadSize: 1900,
    filenameHash: 0xabcd1234,
    mimeIndex: 1,
    extendedSlot: 3,
    extendedData: new Uint8Array([0x11, 0x22, 0x33, 0x44]),
  },
  encoded: {
    degree: 3,
    seed: 0x1234,
    xorPayload: (() => {
      const p = new Uint8Array(S);
      for (let i = 0; i < S; i++) p[i] = (i * 13) & 0xff;
      return p;
    })(),
  },
};

describe("broadcast frame round-trip", () => {
  it("encode then decode preserves bootstrap and fountain header + payload", () => {
    const wire = encodeBroadcastFrame(baseFrame);
    expect(wire.length).toBe(BROADCAST_HEADER_SIZE + S);
    const parsed = decodeBroadcastFrame(wire, S);
    expect(parsed).not.toBeNull();
    expect(parsed!.bootstrap.sessionId).toBe(baseFrame.bootstrap.sessionId);
    expect(parsed!.bootstrap.sourceCount).toBe(baseFrame.bootstrap.sourceCount);
    expect(parsed!.bootstrap.payloadSize).toBe(baseFrame.bootstrap.payloadSize);
    expect(parsed!.bootstrap.extendedSlot).toBe(baseFrame.bootstrap.extendedSlot);
    expect(parsed!.bootstrap.extendedData).toEqual(baseFrame.bootstrap.extendedData);
    expect(parsed!.encoded.degree).toBe(baseFrame.encoded.degree);
    expect(parsed!.encoded.seed).toBe(baseFrame.encoded.seed);
    expect(parsed!.encoded.xorPayload).toEqual(baseFrame.encoded.xorPayload);
  });

  it("rejects on wrong magic", () => {
    const wire = encodeBroadcastFrame(baseFrame);
    wire[0] = 0;
    expect(decodeBroadcastFrame(wire, S)).toBeNull();
  });

  it("rejects on corrupted bootstrap CRC", () => {
    const wire = encodeBroadcastFrame(baseFrame);
    wire[6 + 5] = (wire[6 + 5]! ^ 0x10) & 0xff; // flip a payload-size byte
    expect(decodeBroadcastFrame(wire, S)).toBeNull();
  });

  it("rejects when frame is shorter than header + sourcePacketSize", () => {
    const wire = encodeBroadcastFrame(baseFrame);
    expect(decodeBroadcastFrame(wire.subarray(0, BROADCAST_HEADER_SIZE + S - 1), S)).toBeNull();
  });
});
