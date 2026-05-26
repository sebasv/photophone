/**
 * Browser glue for the M11b audio back-channel.
 *
 * Two surfaces:
 *   - `startAudioBackchannelListener` opens the mic, polls Goertzel filters
 *     at the bit rate, slides over recent bits looking for an FSK frame,
 *     and fires a callback per decoded BackChannelMessage.
 *   - `transmitAudioBackchannelMessage` schedules OscillatorNode frequency
 *     changes for one back-channel frame.
 *
 * Kept here (not in `src/protocol/`) because both depend on browser-only
 * APIs (AudioContext, MediaStream). The protocol layer stays node-testable.
 *
 * Used by:
 *   - send.ts        (visual sender, listens for back-channel)
 *   - receive.ts     (visual receiver, transmits back-channel)
 *   - audio-bc-tx.ts (standalone test page — transmit only)
 *   - audio-bc-rx.ts (standalone test page — listen only)
 */

import {
  DEFAULT_FSK_PARAMS,
  audioBackChannelDecode,
  audioBackChannelEncode,
  bitsToBytes,
  bytesToBits,
  demodBit,
  fskUnframe,
  goertzelPower,
  type BackChannelMessage,
  type FskParams,
  type SessionInfo,
} from "../protocol";

export interface DecodedBackchannelFrame {
  msg: BackChannelMessage;
  seq: number;
  /** ms since the listener started (monotonic). */
  atMs: number;
}

export interface ListenerHandle {
  /** Tear down: close stream tracks and stop the poll loop. */
  stop(): void;
  /** Sample rate of the underlying AudioContext, in Hz. */
  sampleRate: number;
  /** Number of audio samples consumed per FSK bit at that sample rate. */
  samplesPerBit: number;
  /** Live AudioContext state ("running" / "suspended" / "closed"). */
  contextState(): AudioContextState;
}

export interface ListenerDiagnostics {
  /** RMS of the most recent sampled chunk. Use as a level meter. */
  rms: number;
  /** Goertzel power at MARK_LOW (bit-0 tone) over the same chunk. */
  powerLow: number;
  /** Goertzel power at MARK_HIGH (bit-1 tone). */
  powerHigh: number;
}

export interface ListenerOptions {
  session: SessionInfo;
  onMessage: (frame: DecodedBackchannelFrame) => void;
  /**
   * Per-bit callback with acoustic diagnostics. Fires at the same cadence
   * as the bit-poll loop (every `bitDurationSec`, ~100 Hz by default).
   * Pages should rate-limit DOM updates from this callback themselves.
   */
  onBit?: (bit: 0 | 1, diag: ListenerDiagnostics) => void;
  /** Defaults to `DEFAULT_FSK_PARAMS`. */
  fsk?: FskParams;
}

/**
 * Open the microphone and start decoding FSK back-channel frames. Returns
 * a handle the caller can later stop. Resolves once the stream + analyser
 * are wired up; rejects if `getUserMedia` fails.
 */
export async function startAudioBackchannelListener(
  opts: ListenerOptions,
): Promise<ListenerHandle> {
  const fsk = opts.fsk ?? DEFAULT_FSK_PARAMS;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  const audioCtx = new AudioContext();
  // Safari (and Safari iOS in particular) often leaves the context
  // suspended after an awaited getUserMedia, because the original button-
  // click gesture token doesn't survive the await. With a suspended
  // context, AnalyserNode sees no samples and the listener silently
  // captures zeros forever. Resume explicitly.
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(stream);
  const sampleRate = audioCtx.sampleRate;
  const samplesPerBit = Math.round(fsk.bitDurationSec * sampleRate);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = nearestPow2(samplesPerBit * 2);
  src.connect(analyser);
  const timeBuf = new Float32Array(analyser.fftSize);
  const bitBuffer: number[] = [];
  const startedAt = performance.now();
  const intervalMs = fsk.bitDurationSec * 1000;
  const handle = setInterval(() => {
    analyser.getFloatTimeDomainData(timeBuf);
    const chunk = timeBuf.subarray(timeBuf.length - samplesPerBit);
    const bit = demodBit(chunk, sampleRate, fsk);
    bitBuffer.push(bit);
    if (bitBuffer.length > 2048) bitBuffer.splice(0, bitBuffer.length - 1024);
    if (opts.onBit) {
      const powerLow = goertzelPower(chunk, sampleRate, fsk.markLowHz);
      const powerHigh = goertzelPower(chunk, sampleRate, fsk.markHighHz);
      let sumSq = 0;
      for (let i = 0; i < chunk.length; i++) sumSq += chunk[i]! * chunk[i]!;
      const rms = Math.sqrt(sumSq / chunk.length);
      opts.onBit(bit, { rms, powerLow, powerHigh });
    }
    tryDecode(bitBuffer, opts.session, startedAt, opts.onMessage);
  }, intervalMs);
  return {
    sampleRate,
    samplesPerBit,
    contextState: () => audioCtx.state,
    stop(): void {
      clearInterval(handle);
      for (const track of stream.getTracks()) track.stop();
      void audioCtx.close();
    },
  };
}

function tryDecode(
  bitBuffer: number[],
  session: SessionInfo,
  startedAt: number,
  onMessage: (frame: DecodedBackchannelFrame) => void,
): void {
  if (bitBuffer.length < 64) return;
  const minStart = Math.max(0, bitBuffer.length - 1024);
  for (let bitOffset = minStart; bitOffset + 32 <= bitBuffer.length; bitOffset++) {
    const slice = bitBuffer.slice(bitOffset);
    const bytes = bitsToBytes(slice);
    if (bytes.length < 5) continue;
    if (bytes[0] !== 0xaa) continue;
    const payload = fskUnframe(bytes);
    if (!payload) continue;
    const consumedBits = (5 + payload.length) * 8 + 16;
    bitBuffer.splice(0, bitOffset + consumedBits);
    const parsed = audioBackChannelDecode(bytes, session);
    if (parsed) {
      onMessage({
        msg: parsed.msg,
        seq: parsed.seq,
        atMs: Math.round(performance.now() - startedAt),
      });
    }
    return;
  }
}

function nearestPow2(n: number): number {
  let p = 32;
  while (p < n) p <<= 1;
  return p;
}

export interface TransmitOptions {
  session: SessionInfo;
  seq: number;
  msg: BackChannelMessage;
  /** Defaults to `DEFAULT_FSK_PARAMS`. */
  fsk?: FskParams;
  /** Peak gain on the carrier. Default 0.3. */
  gain?: number;
}

/**
 * Schedule one back-channel frame as FSK tones on `audioCtx`. Returns
 * `{ durationSec }` so the caller can throttle subsequent transmissions
 * without overlapping.
 *
 * Resumes the context if suspended (autoplay policy) — caller still needs
 * to have constructed it in a user gesture path.
 */
export async function transmitAudioBackchannelMessage(
  audioCtx: AudioContext,
  opts: TransmitOptions,
): Promise<{ durationSec: number; bits: number }> {
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const fsk = opts.fsk ?? DEFAULT_FSK_PARAMS;
  const gainPeak = opts.gain ?? 0.3;
  const onAir = audioBackChannelEncode(opts.msg, opts.session, opts.seq);
  const bits = bytesToBits(onAir);

  const t0 = audioCtx.currentTime + 0.05;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, t0 - 0.005);
  gain.gain.linearRampToValueAtTime(gainPeak, t0);
  osc.connect(gain).connect(audioCtx.destination);

  const dt = fsk.bitDurationSec;
  for (let i = 0; i < bits.length; i++) {
    const f = bits[i]! ? fsk.markHighHz : fsk.markLowHz;
    osc.frequency.setValueAtTime(f, t0 + i * dt);
  }
  const tEnd = t0 + bits.length * dt;
  gain.gain.setValueAtTime(gainPeak, tEnd - 0.01);
  gain.gain.linearRampToValueAtTime(0, tEnd);
  osc.start(t0 - 0.005);
  osc.stop(tEnd + 0.02);

  return { durationSec: bits.length * dt, bits: bits.length };
}

/**
 * Play a constant test tone — no encoding, no framing. Used by the
 * diagnostics path: if the listener sees Goertzel power at this frequency,
 * the acoustic round-trip is working and any FSK decode failure is in the
 * bit-recovery / framing layer, not the speakers-to-mic path.
 */
export async function transmitTestTone(
  audioCtx: AudioContext,
  freqHz: number,
  durationSec: number,
  gainPeak = 0.3,
): Promise<{ durationSec: number; freqHz: number }> {
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const t0 = audioCtx.currentTime + 0.05;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.setValueAtTime(freqHz, t0);
  gain.gain.setValueAtTime(0, t0 - 0.005);
  gain.gain.linearRampToValueAtTime(gainPeak, t0);
  const tEnd = t0 + durationSec;
  gain.gain.setValueAtTime(gainPeak, tEnd - 0.01);
  gain.gain.linearRampToValueAtTime(0, tEnd);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0 - 0.005);
  osc.stop(tEnd + 0.02);
  return { durationSec, freqHz };
}

// =========================================================================
// Decoded message → human-readable summary
// =========================================================================

/**
 * Render a BackChannelMessage as a single line for UI log output. Shared
 * between the integrated sender UI (which only ever sees decoded messages
 * coming in) and any future debug views.
 */
export function describeBackchannelMessage(msg: BackChannelMessage): string {
  // Avoid pulling in every decoder inside this hot helper; we duplicate
  // tiny amounts of parsing rather than ship a giant import surface to the
  // pages.
  const type = msg.type;
  if (type === 0x01) {
    // Hello: body is UTF-8 text
    const text = new TextDecoder("utf-8", { fatal: false }).decode(msg.body);
    return `hello "${text}"`;
  }
  if (type === 0x02) {
    // Capabilities — 12-byte body, see backchannel.ts
    if (msg.body.length < 12) return `capabilities (truncated, ${msg.body.length}B)`;
    const max = msg.body[0]!;
    const min = msg.body[1]!;
    const pal = msg.body[2]!;
    const fps = msg.body[3]!;
    const cx = (msg.body[4]! << 8) | msg.body[5]!;
    const cy = (msg.body[6]! << 8) | msg.body[7]!;
    const nsym = msg.body[8]!;
    return `capabilities cells=${cx}×${cy} pitch=${min}..${max}px palette=${pal} fps=${fps} nsym=${nsym}`;
  }
  if (type === 0x03 || type === 0x04) {
    const label = type === 0x03 ? "ack" : "nack";
    if (msg.body.length < 1) return `${label} (empty)`;
    const n = msg.body[0]!;
    const ranges: string[] = [];
    for (let i = 0; i < n && 1 + (i + 1) * 6 <= msg.body.length; i++) {
      const off = 1 + i * 6;
      const offset =
        ((msg.body[off]! << 24) |
          (msg.body[off + 1]! << 16) |
          (msg.body[off + 2]! << 8) |
          msg.body[off + 3]!) >>>
        0;
      const length = (msg.body[off + 4]! << 8) | msg.body[off + 5]!;
      ranges.push(`[${offset}+${length}]`);
    }
    return `${label} ${ranges.join(" ")}`;
  }
  if (type === 0x05) {
    if (msg.body.length < 7) return `stats (truncated, ${msg.body.length}B)`;
    const fer = ((msg.body[0]! << 16) | (msg.body[1]! << 8) | msg.body[2]!) >>> 0;
    const otsu = msg.body[3]!;
    const conf = msg.body[4]!;
    const window = (msg.body[5]! << 8) | msg.body[6]!;
    return `stats fer=${(fer / 10_000).toFixed(2)}% otsu=${otsu} conf=${conf} window=${window}`;
  }
  return `unknown msg type 0x${(type as number).toString(16)} (${msg.body.length}B)`;
}
