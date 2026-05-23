import "../style.css";
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  bytesToCells,
  HEADER_SIZE,
  packetize,
  payloadCellCount,
  renderFrame,
  type SessionInfo,
} from "../protocol";

/**
 * Sender — M4 single-frame render + M6 continuous streaming.
 *
 * - "Render first frame" displays just the first packet (the original M4
 *   manual-test flow).
 * - "Start streaming" cycles through every packet of the payload at a
 *   fixed frame rate, looping indefinitely so a continuously-watching
 *   receiver can collect missing packets across multiple passes. This is
 *   the M6 sender side.
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
const maxPayloadPerFrame = capacityBytes - HEADER_SIZE;

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
  const cells = bytesToCells(wirePacket, PALETTE_2BIT);
  if (cells.length > capacityCells) {
    status.textContent = `internal error: ${cells.length} cells > ${capacityCells} capacity`;
    return;
  }
  const padded = new Uint8Array(capacityCells);
  padded.set(cells);
  const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, padded, CELL_SIZE_PX);
  canvas.width = img.width;
  canvas.height = img.height;
  const out = ctx.createImageData(img.width, img.height);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
}
