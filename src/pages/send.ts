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
