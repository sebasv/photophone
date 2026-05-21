import "../style.css";
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  bytesToCells,
  encodePacket,
  HEADER_SIZE,
  payloadCellCount,
  renderFrame,
  type SessionInfo,
} from "../protocol";

/**
 * M4 sender: renders the first chunk of the chosen PNG into a single
 * Photophone frame on the canvas. Real streaming + ARQ lands later — M4 is
 * just "can the receiver pick this up at all".
 */

// Hardcoded for M4; a proper handshake lands in M11+.
const M4_SESSION: SessionInfo = { sessionId: 0xdeadbeef };
const CELL_SIZE_PX = 12;

const fileInput = document.querySelector<HTMLInputElement>("#payload-input")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const canvas = document.querySelector<HTMLCanvasElement>("#frame-canvas")!;
const ctx = canvas.getContext("2d")!;

let payload: Uint8Array | null = null;

const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
const capacityBytes = (capacityCells * 2) / 8; // 2 bits/cell, 8 bits/byte
const maxPayloadPerFrame = capacityBytes - HEADER_SIZE;

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  payload = new Uint8Array(await file.arrayBuffer());
  startButton.disabled = false;
  status.textContent = `Loaded ${file.name} (${payload.length} bytes). First ${Math.min(
    payload.length,
    maxPayloadPerFrame,
  )} bytes will fit in this frame.`;
});

startButton.addEventListener("click", () => {
  if (!payload) return;
  const chunk = payload.slice(0, maxPayloadPerFrame);
  const wirePacket = encodePacket(0, 1, chunk, M4_SESSION);

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

  status.textContent = `Frame rendered (session 0x${M4_SESSION.sessionId.toString(16)}). Hold steady — point the receiver's camera at this canvas.`;
});
