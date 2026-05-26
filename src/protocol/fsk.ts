/**
 * FSK (frequency-shift keying) modem for the M11b audio back-channel
 * (DESIGN.md §6.1).
 *
 * Two tones encode binary symbols:
 *   bit 0 → MARK_LOW frequency
 *   bit 1 → MARK_HIGH frequency
 *
 * A frame on the air is:
 *   preamble (16 alternating bits) + sync byte (0x7E) + length byte
 *   + N body bytes + CRC16 (Modbus poly, 2 bytes)
 *
 * The data layer is symmetric: every back-channel message turns into a
 * BackChannelMessage → encodeBackChannelFrame bytes → fskFrame() bytes
 * → on-air audio → fskUnframe() → decodeBackChannelFrame. Browser code
 * wires the on-air step to OscillatorNode (TX) and AnalyserNode (RX).
 *
 * Goertzel filtering (rather than full FFT) detects the per-bit tone:
 * for a single known frequency it's O(N) and runs cheaply per bit.
 */

export interface FskParams {
  /** Bit-0 carrier frequency in Hz. */
  markLowHz: number;
  /** Bit-1 carrier frequency in Hz. */
  markHighHz: number;
  /** Symbol duration in seconds. */
  bitDurationSec: number;
}

// 1200 / 2200 Hz pair (Bell-103-ish): neither tone is a harmonic of the
// other, so speaker harmonic distortion on the bit-0 tone doesn't spuriously
// excite the bit-1 Goertzel filter. 800 / 1600 Hz (the previous defaults)
// were an octave apart, and the 2nd harmonic of 800 sits exactly on 1600 —
// in practice both Goertzel bins lit up identically and the bit decision
// became a coin toss.
export const DEFAULT_FSK_PARAMS: FskParams = {
  markLowHz: 1200,
  markHighHz: 2200,
  bitDurationSec: 0.01, // 100 baud — audible, easy to debug
};

export const PREAMBLE_BYTE = 0xaa;
export const SYNC_BYTE = 0x7e;
export const PREAMBLE_LEN = 2; // 16 bits

/**
 * Wrap arbitrary payload bytes in a frame ready for FSK on-air
 * transmission. The receiver locates the sync byte after a preamble run
 * and verifies the CRC.
 */
export function fskFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xff) {
    throw new Error(`fskFrame: payload ${payload.length} > 255`);
  }
  const out = new Uint8Array(PREAMBLE_LEN + 1 + 1 + payload.length + 2);
  let off = 0;
  for (let i = 0; i < PREAMBLE_LEN; i++) out[off++] = PREAMBLE_BYTE;
  out[off++] = SYNC_BYTE;
  out[off++] = payload.length;
  out.set(payload, off);
  off += payload.length;
  const c = crc16(out.subarray(PREAMBLE_LEN + 1, PREAMBLE_LEN + 1 + 1 + payload.length));
  out[off++] = (c >>> 8) & 0xff;
  out[off++] = c & 0xff;
  return out;
}

/**
 * Find a sync byte in `frame`, parse the following length byte, then
 * verify the CRC. Returns the payload bytes or null if the frame is
 * incomplete or corrupt.
 *
 * Tolerant of leading garbage (the on-air receiver might catch noise
 * before the preamble).
 */
export function fskUnframe(frame: Uint8Array): Uint8Array | null {
  for (let start = 0; start < frame.length; start++) {
    if (frame[start] !== SYNC_BYTE) continue;
    if (start + 2 > frame.length) return null;
    const len = frame[start + 1]!;
    const bodyStart = start + 2;
    const bodyEnd = bodyStart + len;
    if (bodyEnd + 2 > frame.length) continue;
    const declaredCrc = (frame[bodyEnd]! << 8) | frame[bodyEnd + 1]!;
    const actualCrc = crc16(frame.subarray(start + 1, bodyEnd));
    if (declaredCrc !== actualCrc) continue;
    return frame.slice(bodyStart, bodyEnd);
  }
  return null;
}

// -- Modulation: bytes → bits → tone schedule -----------------------------

/**
 * Expand frame bytes to a bit array (MSB first). Useful when scheduling
 * tones on an OscillatorNode in the browser.
 */
export function bytesToBits(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = (bytes[i]! >> (7 - b)) & 1;
    }
  }
  return out;
}

export function bitsToBytes(bits: ArrayLike<number>): Uint8Array {
  const len = Math.floor(bits.length / 8);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) {
      b = (b << 1) | (bits[i * 8 + k]! & 1);
    }
    out[i] = b;
  }
  return out;
}

// -- Goertzel filter: detect a single frequency in a sample buffer -------

/**
 * Power of frequency `targetHz` in `samples` (sampled at `sampleRateHz`).
 * Uses the Goertzel algorithm — O(N), no FFT needed for a known target.
 */
export function goertzelPower(
  samples: ArrayLike<number>,
  sampleRateHz: number,
  targetHz: number,
): number {
  const N = samples.length;
  const k = Math.round((targetHz * N) / sampleRateHz);
  const w = (2 * Math.PI * k) / N;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let n = 0; n < N; n++) {
    s0 = (samples[n]! as number) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Demodulate one FSK bit from `samples`: returns 1 if bit-1 tone has more
 * energy than bit-0 tone, else 0.
 */
export function demodBit(
  samples: ArrayLike<number>,
  sampleRateHz: number,
  params: FskParams = DEFAULT_FSK_PARAMS,
): 0 | 1 {
  const p0 = goertzelPower(samples, sampleRateHz, params.markLowHz);
  const p1 = goertzelPower(samples, sampleRateHz, params.markHighHz);
  return p1 > p0 ? 1 : 0;
}

/**
 * Gated demodulation: in addition to the bit decision, estimate whether
 * the sample window actually contained a carrier tone. Used by the live
 * audio path to suppress random bits during silent intervals (where
 * `demodBit` would still emit 0/1 based on whichever ambient-noise bin
 * happens to be higher).
 *
 * Noise floor is the median of Goertzel power at `controlHz` — bins
 * chosen to not contain either mark tone, its harmonics, or the
 * harmonics of the other mark. A median is robust to one rogue control
 * bin sitting on a hum or interferer.
 */
export interface DemodGateParams {
  /**
   * Frequencies (Hz) at which to sample for the noise-floor estimate.
   * Should be at least 2; 3 is a good default. Pick bins clear of the
   * mark tones and their first few harmonics.
   */
  controlHz: ReadonlyArray<number>;
  /** Multiplicative SNR threshold: `max(p0,p1) > floor × this`. */
  snrThreshold: number;
  /**
   * Absolute floor: `max(p0,p1) > this`. Guards against false
   * carrier-detect when *everything* is near zero and the SNR ratio
   * becomes meaningless (small / small ≈ random).
   */
  absoluteMin: number;
}

export const DEFAULT_DEMOD_GATE: DemodGateParams = {
  // 600 / 1700 / 3000 Hz: below the mark band, between the marks (not a
  // harmonic of either 1200 or 2200), and well above either mark's first
  // few harmonics. Together they sample the noise across the relevant
  // spectrum.
  controlHz: [600, 1700, 3000],
  snrThreshold: 4, // ~6 dB headroom over the floor estimate
  absoluteMin: 1e-6,
};

export interface GatedBit {
  bit: 0 | 1;
  hasCarrier: boolean;
  powerLow: number;
  powerHigh: number;
  /** Median of Goertzel power at the control frequencies. */
  noiseFloor: number;
  /** `max(powerLow, powerHigh) / noiseFloor`, or +Infinity if floor=0. */
  snr: number;
}

export function demodBitGated(
  samples: ArrayLike<number>,
  sampleRateHz: number,
  params: FskParams = DEFAULT_FSK_PARAMS,
  gate: DemodGateParams = DEFAULT_DEMOD_GATE,
): GatedBit {
  const powerLow = goertzelPower(samples, sampleRateHz, params.markLowHz);
  const powerHigh = goertzelPower(samples, sampleRateHz, params.markHighHz);
  const controlPowers = gate.controlHz.map((f) =>
    goertzelPower(samples, sampleRateHz, f),
  );
  const noiseFloor = median(controlPowers);
  const peak = Math.max(powerLow, powerHigh);
  const snr = noiseFloor > 0 ? peak / noiseFloor : Number.POSITIVE_INFINITY;
  const hasCarrier =
    peak > gate.absoluteMin && snr > gate.snrThreshold;
  return {
    bit: powerHigh > powerLow ? 1 : 0,
    hasCarrier,
    powerLow,
    powerHigh,
    noiseFloor,
    snr,
  };
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Demodulate a contiguous tone schedule. Splits `samples` into bit-sized
 * chunks (`bitDurationSec × sampleRateHz` each) and emits the per-chunk
 * winning tone. Caller is responsible for any clock-recovery alignment
 * (browser TX/RX both lock to OscillatorNode/AudioContext clocks, which
 * are precise enough; unit tests align by construction).
 */
export function demodBitstream(
  samples: ArrayLike<number>,
  sampleRateHz: number,
  params: FskParams = DEFAULT_FSK_PARAMS,
): Uint8Array {
  const samplesPerBit = Math.round(params.bitDurationSec * sampleRateHz);
  if (samplesPerBit === 0) {
    throw new Error("demodBitstream: zero samples per bit (params invalid?)");
  }
  const nBits = Math.floor(samples.length / samplesPerBit);
  const out = new Uint8Array(nBits);
  for (let i = 0; i < nBits; i++) {
    const chunk = sliceAL(samples, i * samplesPerBit, (i + 1) * samplesPerBit);
    out[i] = demodBit(chunk, sampleRateHz, params);
  }
  return out;
}

function sliceAL(a: ArrayLike<number>, start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(a[i]! as number);
  return out;
}

// -- CRC-16 (Modbus polynomial, init 0xFFFF, no reflection in our use) ----

export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]! << 8;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

// -- Tone-synthesis helper (browser-side too, plain JS) -------------------

/**
 * Synthesize `n` samples of FSK audio at the given parameters for `bits`.
 * For each bit, generate `bitDurationSec × sampleRateHz` samples of the
 * appropriate tone. Used in Node unit tests; the browser path uses
 * OscillatorNode for sample-accurate scheduling instead.
 */
export function synthSignal(
  bits: ArrayLike<number>,
  sampleRateHz: number,
  params: FskParams = DEFAULT_FSK_PARAMS,
): Float32Array {
  const samplesPerBit = Math.round(params.bitDurationSec * sampleRateHz);
  const out = new Float32Array(bits.length * samplesPerBit);
  let phase = 0;
  for (let i = 0; i < bits.length; i++) {
    const f = bits[i]! === 1 ? params.markHighHz : params.markLowHz;
    const dPhase = (2 * Math.PI * f) / sampleRateHz;
    for (let n = 0; n < samplesPerBit; n++) {
      out[i * samplesPerBit + n] = Math.sin(phase);
      phase += dPhase;
    }
  }
  return out;
}
