import { bench, describe } from "vitest";
import {
  encodeOnePacket,
  ingestEncodedPacket,
  newFountainDecoder,
} from "../protocol";

const K = 64;
const S = 635;
const sources: Uint8Array[] = [];
for (let i = 0; i < K; i++) {
  const buf = new Uint8Array(S);
  for (let j = 0; j < S; j++) buf[j] = (i * 13 + j) & 0xff;
  sources.push(buf);
}
import type { EncodedPacket } from "../protocol";
const packets: EncodedPacket[] = [];
for (let f = 0; f < K * 2; f++) {
  packets.push(encodeOnePacket(sources, 1 + (f % 5), (0x1234 + f) >>> 0));
}

describe("Fountain", () => {
  bench("encodeOnePacket(K=64, S=635, deg=3)", () => {
    encodeOnePacket(sources, 3, (Math.random() * 0xffffff) >>> 0);
  });
  bench("decode K=64 to completion", () => {
    const dec = newFountainDecoder(K, S);
    for (const p of packets) {
      ingestEncodedPacket(dec, p);
      if (dec.recovered.size === K) break;
    }
  });
});
