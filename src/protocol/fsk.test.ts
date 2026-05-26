import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEMOD_GATE,
  DEFAULT_FSK_PARAMS,
  bitsToBytes,
  bytesToBits,
  crc16,
  demodBitGated,
  demodBitstream,
  fskFrame,
  fskUnframe,
  synthSignal,
} from "./fsk";

describe("framing + CRC", () => {
  it("frame -> unframe round-trips", () => {
    const payload = new TextEncoder().encode("hello back");
    const framed = fskFrame(payload);
    const recovered = fskUnframe(framed);
    expect(recovered).toEqual(payload);
  });

  it("rejects frames with a bad CRC", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const framed = fskFrame(payload);
    framed[framed.length - 1] = (framed[framed.length - 1]! ^ 0x01) & 0xff;
    expect(fskUnframe(framed)).toBeNull();
  });

  it("locates sync byte despite leading garbage", () => {
    const payload = new Uint8Array([42]);
    const framed = fskFrame(payload);
    const noisy = new Uint8Array(framed.length + 3);
    noisy.set([0x55, 0x99, 0xfe]);
    noisy.set(framed, 3);
    expect(fskUnframe(noisy)).toEqual(payload);
  });

  it("CRC differs when any single bit flips", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(crc16(a)).not.toBe(crc16(b));
  });
});

describe("bits/bytes round-trip", () => {
  it("MSB-first bit packing inverts", () => {
    const bytes = new Uint8Array([0x55, 0xaa, 0x7e, 0x00, 0xff]);
    const bits = bytesToBits(bytes);
    expect(bits.length).toBe(40);
    expect(bitsToBytes(bits)).toEqual(bytes);
  });
});

describe("synthSignal -> demodBitstream round-trip", () => {
  it("recovers a known bit pattern at 44.1 kHz, 100 baud", () => {
    const bits = new Uint8Array([1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 0, 1]);
    const sampleRate = 44100;
    const signal = synthSignal(bits, sampleRate, DEFAULT_FSK_PARAMS);
    const recovered = demodBitstream(signal, sampleRate, DEFAULT_FSK_PARAMS);
    expect(Array.from(recovered)).toEqual(Array.from(bits));
  });

  it("recovers a full framed payload at 44.1 kHz", () => {
    const payload = new TextEncoder().encode("hello back");
    const framed = fskFrame(payload);
    const bits = bytesToBits(framed);
    const sampleRate = 44100;
    const signal = synthSignal(bits, sampleRate);
    const recoveredBits = demodBitstream(signal, sampleRate);
    const recoveredFrame = bitsToBytes(recoveredBits);
    expect(fskUnframe(recoveredFrame)).toEqual(payload);
  });
});

describe("demodBitGated", () => {
  const sampleRate = 44100;
  const samplesPerBit = Math.round(DEFAULT_FSK_PARAMS.bitDurationSec * sampleRate);

  it("reports hasCarrier=true on a clean mark-high tone", () => {
    const signal = synthSignal(new Uint8Array([1]), sampleRate);
    const result = demodBitGated(signal.subarray(0, samplesPerBit), sampleRate);
    expect(result.bit).toBe(1);
    expect(result.hasCarrier).toBe(true);
    expect(result.snr).toBeGreaterThan(DEFAULT_DEMOD_GATE.snrThreshold);
  });

  it("reports hasCarrier=false on pure noise", () => {
    // Pseudo-random low-amplitude noise, no concentrated tone energy
    // anywhere in the bin grid. We seed with a fixed value to keep the
    // test deterministic.
    let seed = 0x12345;
    const noise = new Float32Array(samplesPerBit);
    for (let i = 0; i < noise.length; i++) {
      // simple LCG → [-amp, amp]
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i] = ((seed / 0xffffffff) * 2 - 1) * 1e-3;
    }
    const result = demodBitGated(noise, sampleRate);
    expect(result.hasCarrier).toBe(false);
  });

  it("reports hasCarrier=false on silence (below absoluteMin)", () => {
    const silent = new Float32Array(samplesPerBit);
    const result = demodBitGated(silent, sampleRate);
    expect(result.hasCarrier).toBe(false);
  });

  it("rejects mixed-tone broadband signal via coherence check", () => {
    // Simulate something like a drum hit on the desk: strong energy at
    // both mark frequencies simultaneously. SNR vs floor would pass, but
    // the coherence (peak/valley) ratio is near 1 so the gate should
    // reject this as not-real-FSK.
    const samples = new Float32Array(samplesPerBit);
    for (let i = 0; i < samples.length; i++) {
      const t = i / sampleRate;
      samples[i] =
        0.3 * Math.sin(2 * Math.PI * DEFAULT_FSK_PARAMS.markLowHz * t) +
        0.3 * Math.sin(2 * Math.PI * DEFAULT_FSK_PARAMS.markHighHz * t);
    }
    const result = demodBitGated(samples, sampleRate);
    // Both bins should be roughly equal → coherence near 1.
    expect(result.coherence).toBeLessThan(DEFAULT_DEMOD_GATE.coherenceThreshold);
    expect(result.hasCarrier).toBe(false);
  });
});
