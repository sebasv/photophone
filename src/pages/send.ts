import "../style.css";
import { DEFAULT_GEOMETRY, PALETTE_2BIT, payloadCapacity } from "../protocol";

const fileInput = document.querySelector<HTMLInputElement>("#payload-input")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const canvas = document.querySelector<HTMLCanvasElement>("#frame-canvas")!;
const ctx = canvas.getContext("2d")!;

let payload: Uint8Array | null = null;

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  payload = new Uint8Array(await file.arrayBuffer());
  startButton.disabled = false;
  drawPlaceholder(`Loaded ${file.name} — ${payload.length} bytes`);
});

startButton.addEventListener("click", () => {
  if (!payload) return;
  drawPlaceholder(
    `Would transmit ${payload.length} bytes. Frame capacity: ` +
      `${payloadCapacity(DEFAULT_GEOMETRY)} cells @ palette of ` +
      `${PALETTE_2BIT.colors.length}.`,
  );
});

function drawPlaceholder(message: string): void {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f9c846";
  ctx.font = "20px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, canvas.width / 2, canvas.height / 2);
}

drawPlaceholder("Pick a PNG to begin.");
