import "../style.css";
// PWA service-worker registration. send.html and receive.html don't
// import main.ts, so without this each page would keep serving stale
// assets from the SW cache forever after a deploy (autoUpdate's reload
// trigger only fires from pages that called registerSW).
if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  bytesToCells,
  HEADER_SIZE,
  packetize,
  payloadCellCount,
  renderFrame,
  rsEncodeFrame,
  maxFrameDataBytes,
  type SessionInfo,
} from "../protocol";
import {
  describeBackchannelMessage,
  startAudioBackchannelListener,
  type DecodedBackchannelFrame,
  type ListenerDiagnostics,
  type ListenerHandle,
} from "../runtime/audio-backchannel";

/**
 * Sender — M4 single-frame render + M6 continuous streaming + M8 wire-byte
 * Reed-Solomon protection.
 *
 * - "Render first frame" displays just the first packet (the original M4
 *   manual-test flow).
 * - "Start streaming" cycles through every packet of the payload at a
 *   fixed frame rate, looping indefinitely so a continuously-watching
 *   receiver can collect missing packets across multiple passes.
 * - Every wire packet is RS-encoded via `rsEncodeFrame(packet, capacityBytes, NSYM)` (no u16 length prefix — the wire packet self-describes via its `payload_len` header field, and the magic must remain at cell 0 for the orientation check). rsEncodeFrame fills exactly capacityBytes via N full RS blocks + one partial block — uses every byte of frame budget
 *   before going onto the cells, so a handful of cell-classification
 *   errors per frame can be corrected by the receiver. Without this the
 *   u32 `payload_offset` in the header gets corrupted by a single
 *   misclassified cell and `ingest` rejects with `out-of-bounds`.
 *
 * NSYM is intentionally hardcoded to match the receiver side (see
 * `receive.ts`). When we change the value, change it in both places.
 */

const SESSION: SessionInfo = { sessionId: 0xdeadbeef };
const CELL_SIZE_PX = 12;
const STREAM_FRAME_INTERVAL_MS = 200; // 5 fps default

const fileInput = document.querySelector<HTMLInputElement>("#payload-input")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const streamButton = document.querySelector<HTMLButtonElement>("#stream-button")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const canvas = document.querySelector<HTMLCanvasElement>("#frame-canvas")!;
const ctx = canvas.getContext("2d")!;

let payload: Uint8Array | null = null;
let streamIntervalId: ReturnType<typeof setInterval> | null = null;

const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
const capacityBytes = (capacityCells * 2) / 8;

// Reed-Solomon protection parameters. NSYM bytes of parity per 255-byte
// codeword; corrects up to NSYM/2 byte errors per block. The number of
// blocks is whatever fits in the frame; remaining cells are filled with
// zeros and ignored by the receiver.
const NSYM = 32;
const RS_DATA_BYTES = maxFrameDataBytes(capacityBytes, NSYM);

// rsEncodeFrame's underlying RS encoder is systematic — message
// bytes come first in each block, so the wire packet's magic stays
// at cell 0 where the rotation check expects it. The wire packet is
// self-describing via its `payload_len` field; no external length
// prefix needed.
const maxWirePerFrame = RS_DATA_BYTES;
const maxPayloadPerFrame = maxWirePerFrame - HEADER_SIZE;

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  payload = new Uint8Array(await file.arrayBuffer());
  startButton.disabled = false;
  streamButton.disabled = false;
  const numPackets = Math.ceil(payload.length / maxPayloadPerFrame);
  status.textContent =
    `Loaded ${file.name} (${payload.length} bytes). ` +
    `Will fit in ${numPackets} packet${numPackets === 1 ? "" : "s"} of ` +
    `up to ${maxPayloadPerFrame} bytes each.`;
});

startButton.addEventListener("click", () => {
  if (!payload) return;
  stopStreaming();
  const packets = packetize(payload, maxPayloadPerFrame, SESSION);
  const firstPacket = packets[0];
  if (!firstPacket) {
    status.textContent = "payload is empty";
    return;
  }
  renderWirePacket(firstPacket);
  status.textContent =
    `Frame rendered (session 0x${SESSION.sessionId.toString(16)}, ` +
    `packet 1 of ${packets.length}). Hold steady — point the receiver's ` +
    `camera at this canvas.`;
});

streamButton.addEventListener("click", () => {
  if (!payload) return;
  if (streamIntervalId !== null) {
    stopStreaming();
    return;
  }
  startStreaming();
});

function startStreaming(): void {
  if (!payload) return;
  const packets = packetize(payload, maxPayloadPerFrame, SESSION);
  if (packets.length === 0) {
    status.textContent = "payload is empty";
    return;
  }
  let idx = 0;
  // Render the first frame immediately so the receiver has something to
  // see before the first interval fires.
  renderWirePacket(packets[idx]!);
  status.textContent =
    `Streaming session 0x${SESSION.sessionId.toString(16)} — ` +
    `packet 1/${packets.length} @ ${1000 / STREAM_FRAME_INTERVAL_MS} fps`;
  streamButton.textContent = "Stop streaming";
  streamIntervalId = setInterval(() => {
    idx = (idx + 1) % packets.length;
    renderWirePacket(packets[idx]!);
    status.textContent =
      `Streaming session 0x${SESSION.sessionId.toString(16)} — ` +
      `packet ${idx + 1}/${packets.length} @ ${1000 / STREAM_FRAME_INTERVAL_MS} fps`;
  }, STREAM_FRAME_INTERVAL_MS);
}

function stopStreaming(): void {
  if (streamIntervalId !== null) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
  streamButton.textContent = "Start streaming";
}

// -------------------------------------------------------------------------
// Audio back-channel listener — integrated with the sender so the user
// doesn't have to flip between pages to see what the receiver is saying.
// The visual data path (sender → receiver) uses screen + camera; the
// back-channel runs in the opposite direction via mic + speaker. Same
// session id so the receiver's transmitter and our listener line up
// without configuration.
// -------------------------------------------------------------------------

const bcStartButton = document.querySelector<HTMLButtonElement>("#bc-start")!;
const bcStatus = document.querySelector<HTMLSpanElement>("#bc-status")!;
const bcLog = document.querySelector<HTMLPreElement>("#bc-log")!;
const bcDiagToggle = document.querySelector<HTMLInputElement>("#bc-diag")!;
const bcDiagPanel = document.querySelector<HTMLElement>("#bc-diag-panel")!;
const bcDiagOutput = document.querySelector<HTMLPreElement>("#bc-diag-output")!;
const BC_LOG_MAX = 20;
const BC_DIAG_BITS = 128;
const BC_DIAG_REFRESH_MS = 100;
const BC_DIAG_STORAGE_KEY = "photophone.bc.diagEnabled";
let bcListener: ListenerHandle | null = null;
const bcMessages: { atMs: number; seq: number; line: string }[] = [];
// One bit history per oversampling phase. We don't know the phase count
// at parse time, so initialize lazily on the first onBit callback.
let recentBitsByPhase: number[][] = [];
let pollsObserved = 0;
let bitsAccepted = 0;
let lastDiag: ListenerDiagnostics | null = null;
let lastDiagPaintAt = 0;

bcDiagToggle.checked = loadBcDiagEnabled();
bcDiagPanel.hidden = !bcDiagToggle.checked;
bcDiagToggle.addEventListener("change", () => {
  saveBcDiagEnabled(bcDiagToggle.checked);
  bcDiagPanel.hidden = !bcDiagToggle.checked;
});

bcStartButton.addEventListener("click", async () => {
  if (bcListener) {
    bcListener.stop();
    bcListener = null;
    bcStartButton.textContent = "Listen for back-channel";
    bcStatus.textContent = "back-channel idle";
    return;
  }
  bcStartButton.disabled = true;
  bcStatus.textContent = "requesting microphone…";
  try {
    bcListener = await startAudioBackchannelListener({
      session: SESSION,
      onMessage: handleBackchannelMessage,
      onBit: handleBackchannelBit,
    });
    bcStatus.textContent =
      `listening (sr=${bcListener.sampleRate}, ${bcListener.samplesPerBit} samples/bit)`;
    bcStartButton.textContent = "Stop listening";
  } catch (err) {
    bcStatus.textContent = `mic error: ${(err as Error).message}`;
  } finally {
    bcStartButton.disabled = false;
  }
});

function handleBackchannelBit(bit: 0 | 1, diag: ListenerDiagnostics): void {
  pollsObserved++;
  if (recentBitsByPhase.length !== diag.numPhases) {
    recentBitsByPhase = Array.from({ length: diag.numPhases }, () => []);
  }
  if (diag.hasCarrier) {
    const buf = recentBitsByPhase[diag.phase]!;
    buf.push(bit);
    if (buf.length > BC_DIAG_BITS) {
      buf.splice(0, buf.length - BC_DIAG_BITS);
    }
    bitsAccepted++;
  }
  lastDiag = diag;
  if (!bcDiagToggle.checked) return;
  const now = performance.now();
  if (now - lastDiagPaintAt < BC_DIAG_REFRESH_MS) return;
  lastDiagPaintAt = now;
  paintBackchannelDiagnostics();
}

function paintBackchannelDiagnostics(): void {
  if (!lastDiag || !bcListener) {
    bcDiagOutput.textContent = "(no diagnostics yet — start listening first)";
    return;
  }
  // Power readings come out of Goertzel as a sum-of-squared accumulator;
  // a log scale is the only sane way to read them by eye.
  const rmsDb = 20 * Math.log10(Math.max(lastDiag.rms, 1e-9));
  const lowDb = 10 * Math.log10(Math.max(lastDiag.powerLow, 1e-9));
  const highDb = 10 * Math.log10(Math.max(lastDiag.powerHigh, 1e-9));
  const floorDb = 10 * Math.log10(Math.max(lastDiag.noiseFloor, 1e-9));
  const snrDb = 10 * Math.log10(Math.max(lastDiag.snr, 1e-9));
  const cohDb = 10 * Math.log10(Math.max(lastDiag.coherence, 1e-9));
  const dominantTone =
    lastDiag.powerHigh > lastDiag.powerLow ? "HIGH (1)" : "LOW (0)";
  // Score each phase by trailing-alternating-run length — that's our
  // preamble-lock indicator. Show all phases plus the best one's bits.
  type PhaseScore = { phase: number; bits: number[]; run: number };
  const scores: PhaseScore[] = recentBitsByPhase.map((bits, phase) => {
    let run = 0;
    for (let i = bits.length - 1; i > 0; i--) {
      if (bits[i] !== bits[i - 1]) run++;
      else break;
    }
    return { phase, bits, run };
  });
  let best: PhaseScore = scores[0] ?? { phase: 0, bits: [], run: 0 };
  for (const s of scores) {
    if (s.run > best.run) best = s;
  }
  const perPhaseRunLine = scores
    .map((s) => `p${s.phase}=${String(s.run).padStart(2)}`)
    .join("  ");
  const bestBitsLine =
    best.bits.join("") || "(no carrier-confident bits yet)";
  const carrierBadge = lastDiag.hasCarrier ? "● CARRIER" : "○ silent";
  bcDiagOutput.textContent =
    `ctx=${bcListener.contextState()} sr=${bcListener.sampleRate} samples/bit=${bcListener.samplesPerBit}  phases=${lastDiag.numPhases} (AudioWorklet)\n` +
    `polls observed=${pollsObserved}  bits with carrier=${bitsAccepted}  (${((bitsAccepted / Math.max(1, pollsObserved)) * 100).toFixed(1)}%)\n` +
    `mic RMS:   ${lastDiag.rms.toExponential(2)}  (${rmsDb.toFixed(1)} dBFS)\n` +
    `power LOW  (${1200} Hz): ${lastDiag.powerLow.toExponential(2)}  (${lowDb.toFixed(1)} dB)\n` +
    `power HIGH (${2200} Hz): ${lastDiag.powerHigh.toExponential(2)}  (${highDb.toFixed(1)} dB)\n` +
    `noise floor (median of [${lastDiag.controlHz.join(", ")}] Hz): ` +
    `${lastDiag.noiseFloor.toExponential(2)}  (${floorDb.toFixed(1)} dB)\n` +
    `SNR (peak/floor): ${lastDiag.snr.toExponential(2)}  (${snrDb.toFixed(1)} dB)\n` +
    `coherence (peak/valley): ${lastDiag.coherence.toExponential(2)}  (${cohDb.toFixed(1)} dB)\n` +
    `${carrierBadge}\n` +
    `→ dominant tone (if carrier): ${dominantTone}\n` +
    `\n` +
    `per-phase trailing alternating run: ${perPhaseRunLine}   (preamble = 16 alternating)\n` +
    `best phase: p${best.phase} (${best.run} alternating bits)\n` +
    `last ${best.bits.length} carrier-confident bits on best phase (newest right):\n` +
    `  ${bestBitsLine}`;
}

function loadBcDiagEnabled(): boolean {
  try {
    return localStorage.getItem(BC_DIAG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
function saveBcDiagEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(BC_DIAG_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* localStorage unavailable; silent fallback */
  }
}

function handleBackchannelMessage(frame: DecodedBackchannelFrame): void {
  const line = describeBackchannelMessage(frame.msg);
  bcMessages.push({ atMs: frame.atMs, seq: frame.seq, line });
  if (bcMessages.length > BC_LOG_MAX) {
    bcMessages.splice(0, bcMessages.length - BC_LOG_MAX);
  }
  bcLog.textContent = bcMessages
    .map((m) => `[+${formatMs(m.atMs)}, seq ${m.seq}] ${m.line}`)
    .join("\n");
  bcStatus.textContent = `last: ${line}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function renderWirePacket(wirePacket: Uint8Array): void {
  // rsEncodeFrame returns exactly `capacityBytes` of RS-protected output:
  // N full 255-byte blocks plus a partial last block sized to the
  // remaining capacity. Uses every byte of frame budget (~21% more data
  // than a "floor to full blocks" layout would carry).
  const framePayload = rsEncodeFrame(wirePacket, capacityBytes, NSYM);
  const cells = bytesToCells(framePayload, PALETTE_2BIT);
  const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL_SIZE_PX);
  canvas.width = img.width;
  canvas.height = img.height;
  const out = ctx.createImageData(img.width, img.height);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
}
