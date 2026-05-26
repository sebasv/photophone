/**
 * Browser glue for the M11b audio back-channel.
 *
 * Two surfaces:
 *   - `startAudioBackchannelListener` opens the mic, runs an AudioWorklet
 *     processor that emits per-bit Goertzel power measurements in lockstep
 *     with the audio clock, applies the carrier-detect gate on the main
 *     thread, slides over recovered bits looking for an FSK frame, and
 *     fires a callback per decoded BackChannelMessage.
 *   - `transmitAudioBackchannelMessage` schedules OscillatorNode frequency
 *     changes for one back-channel frame.
 *
 * Kept here (not in `src/protocol/`) because both depend on browser-only
 * APIs (AudioContext, MediaStream, AudioWorklet). The protocol layer
 * (including the gate logic via `applyDemodGate`) stays node-testable.
 *
 * Used by:
 *   - send.ts        (visual sender, listens for back-channel)
 *   - receive.ts     (visual receiver, transmits back-channel)
 *   - audio-bc-tx.ts (standalone test page — transmit only)
 *   - audio-bc-rx.ts (standalone test page — listen only)
 */

import {
  DEFAULT_DEMOD_GATE,
  DEFAULT_FSK_PARAMS,
  applyDemodGate,
  audioBackChannelDecode,
  audioBackChannelEncode,
  bitsToBytes,
  bytesToBits,
  fskUnframe,
  type BackChannelMessage,
  type DemodGateParams,
  type FskParams,
  type SessionInfo,
} from "../protocol";

// Vite recognizes `new URL('./file.js', import.meta.url)` and bundles the
// referenced file as a separate asset. The resulting URL is suitable for
// AudioWorklet.addModule().
const workletUrl = new URL("./audio-bc-worklet.js", import.meta.url);

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
  /** Median of Goertzel power at the gate control frequencies. */
  noiseFloor: number;
  /** SNR estimate: max(powerLow, powerHigh) / noiseFloor. */
  snr: number;
  /** Tone-pair coherence: max(powerLow, powerHigh) / min(powerLow, powerHigh). */
  coherence: number;
  /** True if SNR, coherence, and absolute-min thresholds all pass. */
  hasCarrier: boolean;
  /** Control-frequency Hz values used for the noise-floor estimate. */
  controlHz: ReadonlyArray<number>;
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
  /** Defaults to `DEFAULT_DEMOD_GATE`. */
  gate?: DemodGateParams;
}

/**
 * Open the microphone and start decoding FSK back-channel frames using an
 * AudioWorkletProcessor for sample-accurate bit-clock timing (no
 * setInterval drift, no AnalyserNode polling). Resolves once the stream +
 * worklet are wired up; rejects if `getUserMedia` or the worklet load
 * fails.
 */
export async function startAudioBackchannelListener(
  opts: ListenerOptions,
): Promise<ListenerHandle> {
  const fsk = opts.fsk ?? DEFAULT_FSK_PARAMS;
  const gate = opts.gate ?? DEFAULT_DEMOD_GATE;
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
  // context, the worklet receives no samples and the listener silently
  // captures zeros forever. Resume explicitly.
  if (audioCtx.state === "suspended") await audioCtx.resume();
  await audioCtx.audioWorklet.addModule(workletUrl);
  const src = audioCtx.createMediaStreamSource(stream);
  const sampleRate = audioCtx.sampleRate;
  const samplesPerBit = Math.round(fsk.bitDurationSec * sampleRate);
  const node = new AudioWorkletNode(audioCtx, "bc-demod", {
    processorOptions: {
      samplesPerBit,
      markLowHz: fsk.markLowHz,
      markHighHz: fsk.markHighHz,
      controlHz: [...gate.controlHz],
      oversample: 1,
    },
  });
  src.connect(node);
  // No connect to destination — we don't want to play the mic input back.
  const bitBuffer: number[] = [];
  const startedAt = performance.now();
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as {
      powerLow: number;
      powerHigh: number;
      controls: number[];
      rms: number;
    };
    const gated = applyDemodGate(
      data.powerLow,
      data.powerHigh,
      data.controls,
      gate,
    );
    if (gated.hasCarrier) {
      bitBuffer.push(gated.bit);
      if (bitBuffer.length > 2048) bitBuffer.splice(0, bitBuffer.length - 1024);
      tryDecode(bitBuffer, opts.session, startedAt, opts.onMessage);
    }
    if (opts.onBit) {
      opts.onBit(gated.bit, {
        rms: data.rms,
        powerLow: data.powerLow,
        powerHigh: data.powerHigh,
        noiseFloor: gated.noiseFloor,
        snr: gated.snr,
        coherence: gated.coherence,
        hasCarrier: gated.hasCarrier,
        controlHz: gate.controlHz,
      });
    }
  };
  return {
    sampleRate,
    samplesPerBit,
    contextState: () => audioCtx.state,
    stop(): void {
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
      src.disconnect();
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
