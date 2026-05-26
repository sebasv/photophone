import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  bootstrapReady,
  bytesToCells,
  cellsToBytes,
  decodeBroadcastFrame,
  decodeFilename,
  encodeBroadcastFrame,
  encodeOnePacket,
  fountainComplete,
  ingestBootstrap,
  ingestEncodedPacket,
  newBootstrapAccumulator,
  newFountainDecoder,
  payloadCellCount,
  recoverPayload,
  rsDecodeFrame,
  rsEncodeFrame,
  sourcePacketSizeForGeometry,
  type BootstrapFields,
  EXTENDED_SLOT_TOTAL,
  SHA256_SLOT_COUNT,
  FILENAME_MAX,
  mimeIndexFor,
} from "./index";

const NSYM = 32;

function sha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(b).digest());
}

describe("M10 broadcast end-to-end (no camera, byte pipeline only)", () => {
  it("two late-joining receivers each reconstruct hello_world.png byte-perfect", () => {
    const png = readFileSync(new URL("../../hello_world.png", import.meta.url));
    const payload = new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
    const sentSha = sha256(payload);

    const S = sourcePacketSizeForGeometry(DEFAULT_GEOMETRY, NSYM);
    const K = Math.ceil(payload.length / S);
    const padded = new Uint8Array(K * S);
    padded.set(payload);
    const sources: Uint8Array[] = [];
    for (let i = 0; i < K; i++) sources.push(padded.subarray(i * S, (i + 1) * S));

    const filename = "hello_world.png";
    const filenameBytes = new Uint8Array(FILENAME_MAX);
    filenameBytes.set(new TextEncoder().encode(filename));
    const filenameHashFull = sha256(new TextEncoder().encode(filename));
    const filenameHash =
      ((filenameHashFull[0]! << 24) |
        (filenameHashFull[1]! << 16) |
        (filenameHashFull[2]! << 8) |
        filenameHashFull[3]!) >>>
      0;
    const sessionId = 0xc0ffee00 >>> 0;

    const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
    const capacityBytes = (capacityCells * 2) / 8;

    // Generate a long stream of broadcast frames (more than enough for decoding).
    const totalFrames = 4 * K;
    const wires: Uint8Array[] = [];
    for (let f = 0; f < totalFrames; f++) {
      const seed = (sessionId ^ (f * 0x9e3779b1)) >>> 0;
      const degree = 1 + (f % 5); // simple varied degree sequence
      const encoded = encodeOnePacket(sources, degree, seed);
      const slot = f % EXTENDED_SLOT_TOTAL;
      const data =
        slot < SHA256_SLOT_COUNT
          ? sentSha.subarray(slot * 4, slot * 4 + 4)
          : filenameBytes.subarray((slot - SHA256_SLOT_COUNT) * 4, (slot - SHA256_SLOT_COUNT) * 4 + 4);
      const bootstrap: BootstrapFields = {
        sessionId,
        sourceCount: K,
        payloadSize: payload.length,
        filenameHash,
        mimeIndex: mimeIndexFor(filename),
        extendedSlot: slot,
        extendedData: data,
      };
      const wire = encodeBroadcastFrame({ bootstrap, encoded });
      const framePayload = rsEncodeFrame(wire, capacityBytes, NSYM);
      // Round-trip through cells too, to catch any framing-cell mismatch.
      const cells = bytesToCells(framePayload, PALETTE_2BIT);
      const sampled = cellsToBytes(cells, PALETTE_2BIT);
      wires.push(sampled.subarray(0, capacityBytes));
    }

    // Receiver A tunes in at frame 0; receiver B tunes in at frame K (a bit
    // past the start, after some sha256 slots have already gone by).
    const reconstructed = (startIdx: number): Uint8Array => {
      let acc: ReturnType<typeof newBootstrapAccumulator> | null = null;
      let dec: ReturnType<typeof newFountainDecoder> | null = null;
      for (let i = startIdx; i < wires.length; i++) {
        const dataBytes = rsDecodeFrame(wires[i]!, capacityBytes, NSYM);
        const frame = decodeBroadcastFrame(dataBytes, S);
        expect(frame).not.toBeNull();
        if (!acc || !dec) {
          acc = newBootstrapAccumulator(frame!.bootstrap);
          dec = newFountainDecoder(frame!.bootstrap.sourceCount, S);
        }
        ingestBootstrap(acc, frame!.bootstrap);
        ingestEncodedPacket(dec, frame!.encoded);
        if (fountainComplete(dec) && bootstrapReady(acc)) break;
      }
      expect(acc).not.toBeNull();
      expect(dec).not.toBeNull();
      expect(fountainComplete(dec!)).toBe(true);
      expect(bootstrapReady(acc!)).toBe(true);

      const recovered = recoverPayload(dec!);
      const cat = new Uint8Array(recovered.length * S);
      let off = 0;
      for (const sp of recovered) {
        cat.set(sp, off);
        off += sp.length;
      }
      const trimmed = cat.slice(0, acc!.payloadSize);
      // Filename + sha256 verification.
      expect(decodeFilename(acc!)).toBe(filename);
      expect(sha256(trimmed)).toEqual(sentSha);
      return trimmed;
    };

    expect(reconstructed(0)).toEqual(payload);
    expect(reconstructed(K)).toEqual(payload);
  });

  it("non-image binary (plain text bytes) reconstructs byte-perfect too", () => {
    // Use raw bytes that aren't an image: a deterministic byte sequence
    // that's nothing but a "non-image binary" file from the receiver's POV.
    const payload = new Uint8Array(3000);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (i * 37 + 13) & 0xff;
    }
    const sentSha = sha256(payload);
    const filename = "lorem.txt";

    const S = sourcePacketSizeForGeometry(DEFAULT_GEOMETRY, NSYM);
    const K = Math.ceil(payload.length / S);
    const padded = new Uint8Array(K * S);
    padded.set(payload);
    const sources: Uint8Array[] = [];
    for (let i = 0; i < K; i++) sources.push(padded.subarray(i * S, (i + 1) * S));

    const filenameBytes = new Uint8Array(FILENAME_MAX);
    filenameBytes.set(new TextEncoder().encode(filename));
    const filenameHashFull = sha256(new TextEncoder().encode(filename));
    const filenameHash =
      ((filenameHashFull[0]! << 24) |
        (filenameHashFull[1]! << 16) |
        (filenameHashFull[2]! << 8) |
        filenameHashFull[3]!) >>>
      0;
    const sessionId = 0xfeedfeed >>> 0;
    const mimeIndex = mimeIndexFor(filename);

    const acc = newBootstrapAccumulator({
      sessionId, sourceCount: K, payloadSize: payload.length,
      filenameHash, mimeIndex, extendedSlot: 0, extendedData: new Uint8Array(4),
    });
    const dec = newFountainDecoder(K, S);

    // Stream until both completion criteria hit.
    let f = 0;
    while (!(fountainComplete(dec) && bootstrapReady(acc)) && f < 10 * K) {
      const seed = (sessionId ^ (f * 0x9e3779b1)) >>> 0;
      const degree = 1 + (f % 5);
      const encoded = encodeOnePacket(sources, degree, seed);
      const slot = f % EXTENDED_SLOT_TOTAL;
      const data =
        slot < SHA256_SLOT_COUNT
          ? sentSha.subarray(slot * 4, slot * 4 + 4)
          : filenameBytes.subarray((slot - SHA256_SLOT_COUNT) * 4, (slot - SHA256_SLOT_COUNT) * 4 + 4);
      ingestBootstrap(acc, {
        sessionId, sourceCount: K, payloadSize: payload.length,
        filenameHash, mimeIndex, extendedSlot: slot, extendedData: data,
      });
      ingestEncodedPacket(dec, encoded);
      f++;
    }
    expect(fountainComplete(dec)).toBe(true);
    expect(bootstrapReady(acc)).toBe(true);

    const recovered = recoverPayload(dec);
    const cat = new Uint8Array(recovered.length * S);
    let off = 0;
    for (const sp of recovered) {
      cat.set(sp, off);
      off += sp.length;
    }
    const trimmed = cat.slice(0, acc.payloadSize);
    expect(decodeFilename(acc)).toBe(filename);
    expect(sha256(trimmed)).toEqual(sentSha);
    expect(trimmed).toEqual(payload);
  });
});
