import { describe, expect, it } from "vitest";
import {
  BackChannelMessageType,
  decodeBackChannelFrame,
  decodeHello,
  encodeBackChannelFrame,
  encodeHello,
} from "./backchannel";
import type { SessionInfo } from "./transport";

const SESSION: SessionInfo = { sessionId: 0xdeadbeef };

describe("back-channel frame round-trip", () => {
  it("hello message round-trips through encode/decode", () => {
    const msg = encodeHello("hello back");
    const wire = encodeBackChannelFrame(msg, SESSION, 7);
    const parsed = decodeBackChannelFrame(wire, SESSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.msg.type).toBe(BackChannelMessageType.Hello);
    expect(parsed!.seq).toBe(7);
    expect(decodeHello(parsed!.msg)).toBe("hello back");
  });

  it("rejects when session mismatches", () => {
    const wire = encodeBackChannelFrame(encodeHello("x"), SESSION, 0);
    expect(decodeBackChannelFrame(wire, { sessionId: 0x12345678 })).toBeNull();
  });

  it("returns null when payload is empty (no msg-type byte)", () => {
    // Manually craft a packet with empty payload — that's an invalid
    // back-channel frame even though the unicast header is valid.
    const wire = encodeBackChannelFrame({ type: BackChannelMessageType.Hello, body: new Uint8Array(0) }, SESSION, 0);
    // The hello case has body length 0 but still includes the 1 msg-type
    // byte, so wire.length >= 17. To get an empty-payload wire we'd have
    // to corrupt the underlying length field — skip and just sanity-check
    // that a 16-byte wire (header-only) decodes as null.
    const shorter = wire.slice(0, 16);
    // We rely on the underlying transport.decodePacket to reject when
    // the header length doesn't match the buffer; here we forge a
    // header that says length=0 to exercise the empty case.
    shorter[14] = 0; shorter[15] = 0;
    const parsed = decodeBackChannelFrame(shorter, SESSION);
    expect(parsed).toBeNull();
  });
});
