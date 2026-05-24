import "../style.css";
if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  bytesToCells,
  encodeBackChannelFrame,
  encodeHello,
  payloadCellCount,
  renderFrame,
  rsEncode,
  type SessionInfo,
} from "../protocol";

/**
 * Back-channel transmitter (M11). Renders a single hello message as a
 * back-channel frame: standard unicast wire layout, msg-type byte at the
 * head of the payload, same RS protection + rotation discriminator as
 * the main data path.
 *
 * Uses the same DEFAULT_GEOMETRY as the main path but with a smaller
 * cell size so the rendered frame fits a corner of the receiver's screen.
 * The sender page can capture it with a separate camera.
 */

const CELL_SIZE_PX = 6;
const NSYM = 32;
const LOOP_INTERVAL_MS = 200;
const SESSION: SessionInfo = { sessionId: 0xb4cbac0c };

const messageInput = document.querySelector<HTMLInputElement>("#bc-message")!;
const renderButton = document.querySelector<HTMLButtonElement>("#bc-render")!;
const loopButton = document.querySelector<HTMLButtonElement>("#bc-loop")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const canvas = document.querySelector<HTMLCanvasElement>("#bc-canvas")!;
const ctx = canvas.getContext("2d")!;

const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
const capacityBytes = (capacityCells * 2) / 8;
const RS_BLOCKS = Math.floor(capacityBytes / 255);
const RS_ENCODED_BYTES = RS_BLOCKS * 255;

let seq = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;

renderButton.addEventListener("click", () => {
  renderMessage();
});

loopButton.addEventListener("click", () => {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    loopButton.textContent = "Start loop (5 fps)";
    status.textContent = "loop stopped";
    return;
  }
  renderMessage();
  intervalId = setInterval(renderMessage, LOOP_INTERVAL_MS);
  loopButton.textContent = "Stop loop";
});

function renderMessage(): void {
  const text = messageInput.value || "hello back";
  const msg = encodeHello(text);
  const wire = encodeBackChannelFrame(msg, SESSION, seq);
  seq++;
  const ecc = rsEncode(wire, NSYM);
  if (ecc.length > RS_ENCODED_BYTES) {
    status.textContent = `internal error: ecc ${ecc.length} > ${RS_ENCODED_BYTES}`;
    return;
  }
  const framePayload = new Uint8Array(capacityBytes);
  framePayload.set(ecc);
  const cells = bytesToCells(framePayload, PALETTE_2BIT);
  const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL_SIZE_PX);
  canvas.width = img.width;
  canvas.height = img.height;
  const out = ctx.createImageData(img.width, img.height);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
  status.textContent = `frame #${seq} rendered (${text.length} char${text.length === 1 ? "" : "s"})`;
}
