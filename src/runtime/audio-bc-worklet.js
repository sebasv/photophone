/**
 * AudioWorklet processor for the FSK back-channel demodulator (M11b).
 *
 * Runs on the audio rendering thread, processing every input sample in
 * lockstep with the audio clock. No setInterval, no AnalyserNode polling,
 * no drift — bit-clock boundaries are sample-accurate.
 *
 * Maintains a ring buffer of the most recent `samplesPerBit` mic samples.
 * Every `samplesPerBit / oversample` samples (after the buffer is full),
 * computes Goertzel power at MARK_LOW, MARK_HIGH, and each control bin,
 * then posts the raw measurements back to the main thread via the port.
 * The main thread applies the gate (SNR + coherence + absolute floor) and
 * runs the framing search — that logic stays in TS for testability.
 *
 * Worklet code lives in AudioWorkletGlobalScope, which has no module
 * loader, no DOM, no `window`. Globals available here:
 *   - `sampleRate`        (Hz of the AudioContext)
 *   - `currentTime`       (audio-thread time)
 *   - `AudioWorkletProcessor`, `registerProcessor`
 * `goertzelPower` is duplicated here from src/protocol/fsk.ts because
 * we can't import across the worklet boundary; the two implementations
 * are the same arithmetic and tested via the same default constants.
 *
 * processorOptions:
 *   samplesPerBit  — Goertzel window length, in samples
 *   markLowHz      — bit-0 mark frequency (Hz)
 *   markHighHz     — bit-1 mark frequency (Hz)
 *   controlHz      — array of noise-floor control bin Hz values
 *   oversample     — bit-emission rate multiplier (1 = emit once per bit
 *                    duration; 2 = twice; etc.). 1 by default.
 */

class BackchannelDemodProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.samplesPerBit = opts.samplesPerBit;
    this.markLowHz = opts.markLowHz;
    this.markHighHz = opts.markHighHz;
    this.controlHz = opts.controlHz || [];
    this.ring = new Float32Array(this.samplesPerBit);
    this.writeIdx = 0;
    this.samplesFilled = 0;
    this.samplesSinceLastEmit = 0;
    const oversample = Math.max(1, Math.floor(opts.oversample || 1));
    this.emitEverySamples = Math.max(
      1,
      Math.floor(this.samplesPerBit / oversample),
    );
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.ring[this.writeIdx] = channel[i];
      this.writeIdx = (this.writeIdx + 1) % this.ring.length;
      if (this.samplesFilled < this.ring.length) this.samplesFilled++;
      this.samplesSinceLastEmit++;
      if (
        this.samplesSinceLastEmit >= this.emitEverySamples &&
        this.samplesFilled === this.ring.length
      ) {
        this.samplesSinceLastEmit = 0;
        this.emit();
      }
    }
    return true;
  }

  emit() {
    const N = this.ring.length;
    // Linearize the ring buffer into a contiguous array starting from
    // the oldest sample. We need this contiguity because the Goertzel
    // recurrence depends on the strict sample order.
    const samples = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      samples[i] = this.ring[(this.writeIdx + i) % N];
    }
    const powerLow = goertzelPower(samples, sampleRate, this.markLowHz);
    const powerHigh = goertzelPower(samples, sampleRate, this.markHighHz);
    const controls = new Array(this.controlHz.length);
    for (let i = 0; i < this.controlHz.length; i++) {
      controls[i] = goertzelPower(samples, sampleRate, this.controlHz[i]);
    }
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    const rms = Math.sqrt(sumSq / samples.length);
    this.port.postMessage({ powerLow, powerHigh, controls, rms });
  }
}

function goertzelPower(samples, sampleRateHz, targetHz) {
  const N = samples.length;
  const k = Math.round((targetHz * N) / sampleRateHz);
  const w = (2 * Math.PI * k) / N;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < N; n++) {
    const s0 = samples[n] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

registerProcessor("bc-demod", BackchannelDemodProcessor);
