import "../style.css";
if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
import {
  DEFAULT_FSK_PARAMS,
  audioBackChannelDecode,
  bitsToBytes,
  decodeHello,
  demodBit,
  fskUnframe,
  type SessionInfo,
} from "../protocol";

/**
 * Audio back-channel receiver (M11b). MediaStream → analyser-buffer
 * polling at the bit rate. Each chunk runs two Goertzel filters; the
 * winning tone is the bit value. We slide a window over the
 * accumulated bits looking for the FSK preamble + sync, then attempt
 * to unframe and decode.
 *
 * No proper clock recovery — relies on the transmitter being far enough
 * apart between frames that we re-sync each time.
 */

const SESSION: SessionInfo = { sessionId: 0xb4cbac0c };

const startButton = document.querySelector<HTMLButtonElement>("#start-mic")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const log = document.querySelector<HTMLPreElement>("#bc-log")!;

const bitBuffer: number[] = [];
const messages: { atMs: number; text: string; seq: number }[] = [];
let firstSampleAt = 0;

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  status.textContent = "requesting microphone…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const sampleRate = audioCtx.sampleRate;
    const samplesPerBit = Math.round(DEFAULT_FSK_PARAMS.bitDurationSec * sampleRate);
    // Pull `samplesPerBit` samples each time.
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = nearestPow2(samplesPerBit * 2);
    src.connect(analyser);
    const timeBuf = new Float32Array(analyser.fftSize);
    status.textContent = `mic live (sr=${sampleRate}, ${samplesPerBit} samples/bit)`;
    firstSampleAt = performance.now();
    const intervalMs = DEFAULT_FSK_PARAMS.bitDurationSec * 1000;
    setInterval(() => {
      analyser.getFloatTimeDomainData(timeBuf);
      // Use the last `samplesPerBit` samples — the most recent bit window.
      const chunk = timeBuf.subarray(timeBuf.length - samplesPerBit);
      const bit = demodBit(chunk, sampleRate, DEFAULT_FSK_PARAMS);
      bitBuffer.push(bit);
      if (bitBuffer.length > 2048) bitBuffer.splice(0, bitBuffer.length - 1024);
      tryDecode();
    }, intervalMs);
  } catch (err) {
    status.textContent = `mic error: ${(err as Error).message}`;
    startButton.disabled = false;
  }
});

function tryDecode(): void {
  // Look for the FSK preamble (0xAA repeated) followed by sync byte 0x7E.
  // Slide over the bit buffer, take bytes at this offset, run fskUnframe.
  if (bitBuffer.length < 64) return;
  const minStart = Math.max(0, bitBuffer.length - 1024);
  for (let bitOffset = minStart; bitOffset + 32 <= bitBuffer.length; bitOffset++) {
    // Need at least 8*5 = 40 bits to test preamble+sync+length, plus enough body.
    const slice = bitBuffer.slice(bitOffset);
    const bytes = bitsToBytes(slice);
    if (bytes.length < 5) continue;
    if (bytes[0] !== 0xaa) continue; // cheap fast-reject
    const payload = fskUnframe(bytes);
    if (!payload) continue;
    // We got a valid frame at this offset; trim the buffer past the consumed bits.
    const consumedBits = (5 + payload.length) * 8 + 16; // sync+len+body+crc+preamble
    bitBuffer.splice(0, bitOffset + consumedBits);
    const parsed = audioBackChannelDecode(bytes, SESSION);
    if (parsed) {
      const text = decodeHello(parsed.msg) ?? "<non-hello>";
      const atMs = Math.round(performance.now() - firstSampleAt);
      messages.push({ atMs, text, seq: parsed.seq });
      renderLog();
      status.textContent = `decoded "${text}" at +${atMs} ms (seq ${parsed.seq})`;
    }
    return;
  }
}

function renderLog(): void {
  log.textContent = messages
    .slice(-20)
    .map((m) => `[+${m.atMs} ms, seq ${m.seq}] ${m.text}`)
    .join("\n");
}

function nearestPow2(n: number): number {
  let p = 32;
  while (p < n) p <<= 1;
  return p;
}
