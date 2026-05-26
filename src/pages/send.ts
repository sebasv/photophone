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
  rsEncode,
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
 * - Every wire packet is RS-encoded via `rsEncode(packet, NSYM)` (no u16 length prefix — the wire packet self-describes via its `payload_len` header field, and the magic must remain at cell 0 for the orientation check)
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
const RS_BLOCKS = Math.floor(capacityBytes / 255);
const RS_ENCODED_BYTES = RS_BLOCKS * 255;
const RS_DATA_BYTES = RS_BLOCKS * (255 - NSYM);

// `rsEncode` keeps the message bytes at the start of the encoded
// stream (systematic encoding), so the wire packet's magic stays at
// cell 0 where the rotation check expects it. The wire packet is
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
const recentBits: number[] = [];
let bitsObserved = 0;
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
  recentBits.push(bit);
  if (recentBits.length > BC_DIAG_BITS) {
    recentBits.splice(0, recentBits.length - BC_DIAG_BITS);
  }
  bitsObserved++;
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
  const dominantTone =
    lastDiag.powerHigh > lastDiag.powerLow ? "HIGH (1)" : "LOW (0)";
  const bitsLine = recentBits.join("");
  // Try to spot the FSK preamble (0xAA = 10101010) by scanning the last 16
  // bits for an alternating run.
  let alternatingRun = 0;
  for (let i = recentBits.length - 1; i > 0; i--) {
    if (recentBits[i] !== recentBits[i - 1]) alternatingRun++;
    else break;
  }
  bcDiagOutput.textContent =
    `ctx=${bcListener.contextState()} sr=${bcListener.sampleRate} samples/bit=${bcListener.samplesPerBit}  bits observed=${bitsObserved}\n` +
    `mic RMS:   ${lastDiag.rms.toExponential(2)}  (${rmsDb.toFixed(1)} dBFS)\n` +
    `power LOW  (${800} Hz): ${lastDiag.powerLow.toExponential(2)}  (${lowDb.toFixed(1)} dB)\n` +
    `power HIGH (${1600} Hz): ${lastDiag.powerHigh.toExponential(2)}  (${highDb.toFixed(1)} dB)\n` +
    `→ dominant tone: ${dominantTone}\n` +
    `\n` +
    `last ${recentBits.length} bits (newest right):\n` +
    `  ${bitsLine}\n` +
    `trailing alternating run: ${alternatingRun} bits  (preamble = 16 alternating)`;
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
  const ecc = rsEncode(wirePacket, NSYM);
  if (ecc.length > RS_ENCODED_BYTES) {
    status.textContent = `internal error: ECC produced ${ecc.length} bytes > ${RS_ENCODED_BYTES} frame budget`;
    return;
  }
  // Pad the ECC output to the full frame byte capacity. The receiver
  // ignores anything past RS_ENCODED_BYTES, so the padding bytes (and
  // the cells they encode) are inert.
  const framePayload = new Uint8Array(capacityBytes);
  framePayload.set(ecc);
  const cells = bytesToCells(framePayload, PALETTE_2BIT);
  const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL_SIZE_PX);
  canvas.width = img.width;
  canvas.height = img.height;
  const out = ctx.createImageData(img.width, img.height);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
}
