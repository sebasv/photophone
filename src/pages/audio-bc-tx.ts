import "../style.css";
if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
import {
  DEFAULT_FSK_PARAMS,
  audioBackChannelEncode,
  bytesToBits,
  encodeHello,
  type SessionInfo,
} from "../protocol";

/**
 * Audio back-channel transmitter (M11b). Schedules OscillatorNode
 * frequency changes per bit. AudioContext.currentTime gives sample-
 * accurate timing — no jitter between bits.
 */

const SESSION: SessionInfo = { sessionId: 0xb4cbac0c };
const LOOP_INTERVAL_MS = 3000;
const messageInput = document.querySelector<HTMLInputElement>("#bc-message")!;
const sendButton = document.querySelector<HTMLButtonElement>("#bc-send")!;
const loopButton = document.querySelector<HTMLButtonElement>("#bc-loop")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;

let audioCtx: AudioContext | null = null;
let seq = 0;
let loopHandle: ReturnType<typeof setInterval> | null = null;

sendButton.addEventListener("click", async () => {
  await transmitOnce();
});

loopButton.addEventListener("click", async () => {
  if (loopHandle !== null) {
    clearInterval(loopHandle);
    loopHandle = null;
    loopButton.textContent = "Start loop";
    status.textContent = "loop stopped";
    return;
  }
  await transmitOnce();
  loopHandle = setInterval(() => {
    void transmitOnce();
  }, LOOP_INTERVAL_MS);
  loopButton.textContent = "Stop loop";
});

async function transmitOnce(): Promise<void> {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const text = messageInput.value || "hello back";
  const onAir = audioBackChannelEncode(encodeHello(text), SESSION, seq);
  seq++;
  const bits = bytesToBits(onAir);

  const t0 = audioCtx.currentTime + 0.05;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0, t0 - 0.005);
  gain.gain.linearRampToValueAtTime(0.3, t0);
  osc.connect(gain).connect(audioCtx.destination);

  const dt = DEFAULT_FSK_PARAMS.bitDurationSec;
  for (let i = 0; i < bits.length; i++) {
    const f = bits[i]! ? DEFAULT_FSK_PARAMS.markHighHz : DEFAULT_FSK_PARAMS.markLowHz;
    osc.frequency.setValueAtTime(f, t0 + i * dt);
  }
  const tEnd = t0 + bits.length * dt;
  gain.gain.setValueAtTime(0.3, tEnd - 0.01);
  gain.gain.linearRampToValueAtTime(0, tEnd);

  osc.start(t0 - 0.005);
  osc.stop(tEnd + 0.02);

  status.textContent = `transmitting "${text}" (frame #${seq}, ${bits.length} bits, ${(bits.length * dt).toFixed(2)}s)`;
}
