import { describe, expect, it } from "vitest";
import {
  audioBackChannelDecode,
  audioBackChannelEncode,
  BackChannelMessageType,
  bitsToBytes,
  bytesToBits,
  decodeHello,
  demodBitstream,
  encodeHello,
  synthSignal,
  type SessionInfo,
} from "./index";

const SESSION: SessionInfo = { sessionId: 0xa1b2c3d4 };

describe("audio back-channel encode/decode", () => {
  it("hello message round-trips through the on-air byte layer", () => {
    const msg = encodeHello("hello back via audio");
    const onAir = audioBackChannelEncode(msg, SESSION, 11);
    const parsed = audioBackChannelDecode(onAir, SESSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.msg.type).toBe(BackChannelMessageType.Hello);
    expect(parsed!.seq).toBe(11);
    expect(decodeHello(parsed!.msg)).toBe("hello back via audio");
  });

  it("full pipeline including FSK signal synthesis + demodulation at 44.1 kHz", () => {
    const msg = encodeHello("hi");
    const onAir = audioBackChannelEncode(msg, SESSION, 0);
    const bits = bytesToBits(onAir);
    const sampleRate = 44100;
    const signal = synthSignal(bits, sampleRate);
    const recoveredBits = demodBitstream(signal, sampleRate);
    const recoveredAir = bitsToBytes(recoveredBits);
    const parsed = audioBackChannelDecode(recoveredAir, SESSION);
    expect(parsed).not.toBeNull();
    expect(decodeHello(parsed!.msg)).toBe("hi");
  });

  it("rejects on session mismatch even after a clean recovery", () => {
    const msg = encodeHello("x");
    const onAir = audioBackChannelEncode(msg, SESSION, 0);
    expect(audioBackChannelDecode(onAir, { sessionId: 0xdeadbeef })).toBeNull();
  });
});
