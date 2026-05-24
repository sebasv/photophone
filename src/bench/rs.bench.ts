import { bench, describe } from "vitest";
import { rsDecodeAll, rsEncode } from "../protocol";

const NSYM = 32;
const DATA = new Uint8Array(3 * (255 - NSYM));
for (let i = 0; i < DATA.length; i++) DATA[i] = (i * 17 + 5) & 0xff;
const ECC = rsEncode(DATA, NSYM);

describe("Reed-Solomon", () => {
  bench("rsEncode (3 blocks × 223 data bytes)", () => {
    rsEncode(DATA, NSYM);
  });
  bench("rsDecodeAll (clean, no errors)", () => {
    rsDecodeAll(ECC, NSYM);
  });
});
