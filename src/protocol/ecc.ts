/**
 * Reed-Solomon error-correction codes over GF(2^8) (= GF(256)).
 *
 * Used by the transport layer to encode each packet's wire bytes with
 * `nsym` parity bytes appended; the receiver can correct up to `nsym/2`
 * byte errors per codeword, recovering the original packet even when
 * roughly 10% of cells in the frame were classified incorrectly.
 *
 * Maximum codeword length is 255 bytes (the GF(256) constraint). For
 * packets larger than that, the caller chunks (see encode/decode below).
 *
 * Field: GF(2^8) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
 * (0x11d). Generator: alpha = 2.
 *
 * Implementation follows the Wikiversity Reed-Solomon reference,
 * translated to TypeScript with strict-mode-friendly indexing.
 */

const GF_PRIMITIVE = 0x11d;
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGfTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_PRIMITIVE;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("ecc: GF division by zero");
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a]! + 255 - GF_LOG[b]!) % 255]!;
}

function gfPow(x: number, power: number): number {
  if (x === 0) return power === 0 ? 1 : 0;
  return GF_EXP[(((GF_LOG[x]! * power) % 255) + 255) % 255]!;
}

function gfInv(x: number): number {
  if (x === 0) throw new Error("ecc: GF inverse of 0");
  return GF_EXP[255 - GF_LOG[x]!]!;
}

// =========================================================================
// Polynomial operations (coefficients listed high-degree-first)
// =========================================================================

function polyScale(p: ReadonlyArray<number>, x: number): number[] {
  const out: number[] = new Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = gfMul(p[i]!, x);
  return out;
}

function polyAdd(p: ReadonlyArray<number>, q: ReadonlyArray<number>): number[] {
  const len = Math.max(p.length, q.length);
  const out: number[] = new Array(len).fill(0);
  for (let i = 0; i < p.length; i++) out[len - p.length + i] = p[i]!;
  for (let i = 0; i < q.length; i++) out[len - q.length + i]! ^= q[i]!;
  return out;
}

function polyMul(p: ReadonlyArray<number>, q: ReadonlyArray<number>): number[] {
  const out: number[] = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) {
      out[i + j]! ^= gfMul(p[i]!, q[j]!);
    }
  }
  return out;
}

function polyEval(p: ReadonlyArray<number>, x: number): number {
  let y = p[0]!;
  for (let i = 1; i < p.length; i++) {
    y = gfMul(y, x) ^ p[i]!;
  }
  return y;
}

// =========================================================================
// Reed-Solomon encode
// =========================================================================

function rsGeneratorPoly(nsym: number): number[] {
  let g: number[] = [1];
  for (let i = 0; i < nsym; i++) {
    g = polyMul(g, [1, GF_EXP[i]!]);
  }
  return g;
}

/**
 * Encode a single codeword. `msg.length + nsym` must be ≤ 255.
 * Returns a `Uint8Array` of length `msg.length + nsym` whose first
 * `msg.length` bytes are the original message and last `nsym` bytes
 * are the Reed-Solomon parity (systematic encoding).
 */
export function rsEncodeBlock(msg: Uint8Array, nsym: number): Uint8Array {
  if (msg.length + nsym > 255) {
    throw new Error(
      `rsEncodeBlock: codeword too long (${msg.length} + ${nsym} > 255)`,
    );
  }
  const gen = rsGeneratorPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  // Synthetic-division polynomial-long-division of the message (with nsym
  // trailing zero coefficients) by the generator polynomial. The remainder
  // is the parity.
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i]!;
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        out[i + j]! ^= gfMul(gen[j]!, coef);
      }
    }
  }
  // The above clobbered the message bytes in-place during division;
  // restore them so the codeword is systematic.
  out.set(msg);
  return out;
}

// =========================================================================
// Reed-Solomon decode (Berlekamp-Massey + Chien search + Forney)
// =========================================================================

function calcSyndromes(msg: Uint8Array, nsym: number): number[] {
  const synd: number[] = [0]; // index 0 is unused; placeholder for 1-based access
  const msgArr = Array.from(msg);
  for (let i = 0; i < nsym; i++) {
    synd.push(polyEval(msgArr, GF_EXP[i]!));
  }
  return synd;
}

function findErrorLocator(synd: ReadonlyArray<number>, nsym: number): number[] {
  // Berlekamp-Massey
  let errLoc: number[] = [1];
  let oldLoc: number[] = [1];
  for (let i = 0; i < nsym; i++) {
    oldLoc.push(0);
    let delta = synd[i + 1]!;
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j]!, synd[i + 1 - j]!);
    }
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length > 0 && errLoc[0] === 0) errLoc.shift();
  const numErrors = errLoc.length - 1;
  if (numErrors * 2 > nsym) {
    throw new Error(
      `rsDecode: too many errors to correct (${numErrors} > ${Math.floor(nsym / 2)})`,
    );
  }
  return errLoc;
}

function findErrorPositions(
  errLoc: ReadonlyArray<number>,
  nmsg: number,
): number[] {
  // Chien search: find positions where err_loc evaluates to zero
  const errs: number[] = [];
  for (let i = 0; i < nmsg; i++) {
    if (polyEval(errLoc, GF_EXP[255 - i]!) === 0) {
      errs.push(nmsg - 1 - i);
    }
  }
  return errs;
}

function correctErrata(
  msg: ReadonlyArray<number>,
  synd: ReadonlyArray<number>,
  errPos: ReadonlyArray<number>,
): number[] {
  const coefPos = errPos.map((p) => msg.length - 1 - p);

  // Build the errata locator polynomial Λ(x) = Π (1 + α^pos · x)
  let locator: number[] = [1];
  for (const pos of coefPos) {
    locator = polyMul(locator, polyAdd([1], [GF_EXP[pos]!, 0]));
  }

  // Errata evaluator polynomial Ω(x) = (S(x) · Λ(x)) mod x^(nsym)
  const reversedSynd = synd.slice(1).reverse();
  const product = polyMul(reversedSynd, locator);
  const evalLen = locator.length - 1;
  const evaluator = product.slice(product.length - evalLen);

  // Forney: correction values
  const corrected = [...msg];
  for (let i = 0; i < coefPos.length; i++) {
    const pos = coefPos[i]!;
    const xi = GF_EXP[pos]!;
    const xiInv = gfInv(xi);
    // Evaluator at x^-1
    const yi = polyEval(evaluator, xiInv);
    // Formal derivative of locator at x^-1
    // The derivative drops odd-indexed terms (in the alpha-power sense).
    // Simpler approach: differentiate and evaluate.
    let derEval = 0;
    for (let k = 1; k < locator.length; k++) {
      if ((locator.length - 1 - k) % 2 === 0) {
        derEval ^= gfMul(locator[locator.length - 1 - k - 1] ?? 0, gfPow(xiInv, locator.length - 1 - k - 1));
      }
    }
    // Actually, simpler: the derivative of a polynomial in GF(2^n) keeps
    // only the odd-power terms (since 2x = 0 in char-2). Build it explicitly.
    const der = locatorDerivative(locator);
    const zi = polyEval(der, xiInv);
    if (zi === 0) {
      throw new Error("rsDecode: Forney zero divisor — likely corrupted decode");
    }
    const magnitude = gfDiv(gfMul(xi, yi), zi);
    corrected[msg.length - 1 - pos]! ^= magnitude;
  }
  return corrected;
}

function locatorDerivative(locator: ReadonlyArray<number>): number[] {
  // In GF(2^n) the formal derivative of x^k is k·x^(k-1), but since
  // characteristic is 2, only odd-power terms survive (they become
  // even-power terms in the derivative).
  // Polynomial is high-degree-first; degree = locator.length - 1.
  const out: number[] = [];
  for (let i = 0; i < locator.length - 1; i++) {
    const degree = locator.length - 1 - i;
    if (degree % 2 === 1) {
      out.push(locator[i]!);
    } else {
      out.push(0);
    }
  }
  // Drop leading zeros if any.
  while (out.length > 0 && out[0] === 0) out.shift();
  return out.length === 0 ? [0] : out;
}

/**
 * Decode a Reed-Solomon codeword. Returns the corrected original message
 * (length `received.length - nsym`). Throws if the number of errors
 * exceeds the code's correction capacity (`nsym/2`).
 */
export function rsDecodeBlock(received: Uint8Array, nsym: number): Uint8Array {
  const synd = calcSyndromes(received, nsym);
  if (synd.slice(1).every((s) => s === 0)) {
    // No errors detected.
    return received.slice(0, received.length - nsym);
  }
  const errLoc = findErrorLocator(synd, nsym);
  const errPos = findErrorPositions(errLoc, received.length);
  if (errPos.length === 0 || errPos.length !== errLoc.length - 1) {
    throw new Error("rsDecode: could not locate all errors");
  }
  const corrected = correctErrata(Array.from(received), synd, errPos);
  return new Uint8Array(corrected).slice(0, received.length - nsym);
}

// =========================================================================
// Chunked encode/decode for arbitrary-length messages
// =========================================================================

/**
 * Encode a message of any length, chunking into Reed-Solomon blocks of
 * up to `(255 - nsym)` data bytes each. Each block is encoded
 * systematically and concatenated.
 *
 * The output length is `ceil(msg.length / (255 - nsym)) * 255`, i.e.,
 * fully padded — chunking is implicit in the block structure.
 *
 * `msg.length` is recorded by the caller (we don't add a length prefix).
 */
export function rsEncode(msg: Uint8Array, nsym: number): Uint8Array {
  if (nsym <= 0 || nsym >= 255) {
    throw new Error(`rsEncode: nsym must be in (0, 255), got ${nsym}`);
  }
  const dataPerBlock = 255 - nsym;
  const numBlocks = Math.max(1, Math.ceil(msg.length / dataPerBlock));
  const out = new Uint8Array(numBlocks * 255);
  for (let b = 0; b < numBlocks; b++) {
    const start = b * dataPerBlock;
    const end = Math.min(start + dataPerBlock, msg.length);
    const chunk = new Uint8Array(dataPerBlock);
    chunk.set(msg.subarray(start, end));
    // Remaining bytes of chunk stay zero — that's the padding for the
    // last block when msg.length isn't a multiple of dataPerBlock.
    const encoded = rsEncodeBlock(chunk, nsym);
    out.set(encoded, b * 255);
  }
  return out;
}

/**
 * Decode a chunked Reed-Solomon encoded message. `originalLength` is
 * how many bytes of the result to return (trims the zero padding from
 * the last block).
 *
 * Throws if any block has too many errors to correct.
 */
export function rsDecode(
  encoded: Uint8Array,
  nsym: number,
  originalLength: number,
): Uint8Array {
  if (encoded.length % 255 !== 0) {
    throw new Error(
      `rsDecode: encoded length ${encoded.length} not a multiple of 255`,
    );
  }
  const dataPerBlock = 255 - nsym;
  const numBlocks = encoded.length / 255;
  const expectedOriginal = (numBlocks - 1) * dataPerBlock + 1;
  if (originalLength < expectedOriginal - dataPerBlock || originalLength > numBlocks * dataPerBlock) {
    throw new Error(
      `rsDecode: originalLength ${originalLength} inconsistent with ${numBlocks} blocks`,
    );
  }
  const out = new Uint8Array(originalLength);
  for (let b = 0; b < numBlocks; b++) {
    const block = encoded.subarray(b * 255, (b + 1) * 255);
    const decoded = rsDecodeBlock(block, nsym);
    const start = b * dataPerBlock;
    const end = Math.min(start + dataPerBlock, originalLength);
    out.set(decoded.subarray(0, end - start), start);
  }
  return out;
}


// =========================================================================
// Wire-packet wrapper: length-prefixed Reed-Solomon for arbitrary blobs
// =========================================================================

/**
 * Wrap a transport-layer wire packet (or any byte blob ≤ 65535 bytes) in a
 * length-prefixed Reed-Solomon envelope:
 *
 *   protected = [ u16(wireBytes.length) ][ wireBytes ][ padding to block ]
 *   ecc = rsEncode(protected, nsym)
 *
 * The two-byte length prefix is part of the RS-protected payload, so it
 * gets the same error correction as the rest.
 *
 * Maximum wire length: 65535 bytes (the u16 prefix range).
 */
export function rsEncodeWireBytes(
  wireBytes: Uint8Array,
  nsym: number,
): Uint8Array {
  if (wireBytes.length > 0xffff) {
    throw new Error(
      `rsEncodeWireBytes: wire bytes too long for u16 length prefix (${wireBytes.length})`,
    );
  }
  const protectedData = new Uint8Array(wireBytes.length + 2);
  protectedData[0] = (wireBytes.length >>> 8) & 0xff;
  protectedData[1] = wireBytes.length & 0xff;
  protectedData.set(wireBytes, 2);
  return rsEncode(protectedData, nsym);
}

/**
 * Inverse of `rsEncodeWireBytes`. Decodes every RS block in `encoded`,
 * reads the u16 length prefix from the first two bytes of the decoded
 * data, and returns exactly that many bytes from offset 2.
 *
 * Throws if any block had too many errors to correct, or if the declared
 * length exceeds what's in the buffer.
 */
export function rsDecodeWireBytes(
  encoded: Uint8Array,
  nsym: number,
): Uint8Array {
  const allData = rsDecodeAll(encoded, nsym);
  if (allData.length < 2) {
    throw new Error("rsDecodeWireBytes: decoded data too short for length prefix");
  }
  const wireLen = (allData[0]! << 8) | allData[1]!;
  if (wireLen + 2 > allData.length) {
    throw new Error(
      `rsDecodeWireBytes: declared wire length ${wireLen} exceeds decoded buffer (${allData.length - 2} available)`,
    );
  }
  return allData.slice(2, 2 + wireLen);
}

/**
 * Decode every RS block in `encoded` and return all data bytes (including
 * any zero-padding from the last block). Useful when the original length
 * is recovered from the decoded contents themselves (see
 * `rsDecodeWireBytes`).
 */
export function rsDecodeAll(encoded: Uint8Array, nsym: number): Uint8Array {
  if (encoded.length % 255 !== 0) {
    throw new Error(
      `rsDecodeAll: encoded length ${encoded.length} not a multiple of 255`,
    );
  }
  const dataPerBlock = 255 - nsym;
  const numBlocks = encoded.length / 255;
  const out = new Uint8Array(numBlocks * dataPerBlock);
  for (let b = 0; b < numBlocks; b++) {
    const block = encoded.subarray(b * 255, (b + 1) * 255);
    const decoded = rsDecodeBlock(block, nsym);
    out.set(decoded, b * dataPerBlock);
  }
  return out;
}

// Re-export for tests / diagnostics.
export const _gf = {
  mul: gfMul,
  div: gfDiv,
  pow: gfPow,
  inv: gfInv,
};
