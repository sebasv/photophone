import { bench, describe } from "vitest";
import {
  maxFrameDataBytes,
  rsDecodeAll,
  rsDecodeFrame,
  rsEncode,
  rsEncodeFrame,
} from "../protocol";

const NSYM = 32;
const DATA = new Uint8Array(3 * (255 - NSYM));
for (let i = 0; i < DATA.length; i++) DATA[i] = (i * 17 + 5) & 0xff;
const ECC = rsEncode(DATA, NSYM);

// Frame-shaped capacity: matches what send.ts / broadcast-send.ts use.
const CAPACITY = 939; // default geometry, 2-bit palette
const FRAME_DATA = new Uint8Array(maxFrameDataBytes(CAPACITY, NSYM)); // 811
for (let i = 0; i < FRAME_DATA.length; i++) FRAME_DATA[i] = (i * 17 + 5) & 0xff;
const FRAME_ECC = rsEncodeFrame(FRAME_DATA, CAPACITY, NSYM);

describe("Reed-Solomon", () => {
  bench("rsEncode (3 full blocks × 223 data bytes)", () => {
    rsEncode(DATA, NSYM);
  });
  bench("rsDecodeAll (3 full blocks, clean)", () => {
    rsDecodeAll(ECC, NSYM);
  });
  bench("rsEncodeFrame (3 full + 1 partial → 811 data bytes / 939 capacity)", () => {
    rsEncodeFrame(FRAME_DATA, CAPACITY, NSYM);
  });
  bench("rsDecodeFrame (3 full + 1 partial, clean)", () => {
    rsDecodeFrame(FRAME_ECC, CAPACITY, NSYM);
  });
});
