import "../style.css";
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  cellsToBytes,
  decodeFrameWarpedWithDiagnostics,
  decodePacket,
  type SessionInfo,
  type DecodeFrameWarpedDiagnostics,
  type PDPCandidate,
  type Point,
} from "../protocol";

/**
 * M4 + M4.5 receiver. Snaps one frame from the live camera, runs the M3.5
 * detect + unwarp + decode pipeline with full diagnostics, validates the
 * wire packet, and dumps the payload. A toggleable diagnostics panel
 * surfaces the detector's intermediates (Otsu threshold, all PDP
 * candidates, per-rotation magic bytes) and overlays the chosen PDP
 * centroids on the captured frame.
 */

const M4_SESSION: SessionInfo = { sessionId: 0xdeadbeef };
const DIAGNOSTICS_STORAGE_KEY = "photophone.diagnostics.enabled";

const startButton = document.querySelector<HTMLButtonElement>("#start-camera")!;
const captureButton = document.querySelector<HTMLButtonElement>("#capture-frame")!;
const video = document.querySelector<HTMLVideoElement>("#camera-video")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const output = document.querySelector<HTMLPreElement>("#decoded-output")!;
const previewCanvas = document.querySelector<HTMLCanvasElement>("#capture-preview")!;
const diagnosticsToggle = document.querySelector<HTMLInputElement>("#diagnostics-toggle")!;
const diagnosticsPanel = document.querySelector<HTMLElement>("#diagnostics-panel")!;
const diagnosticsOutput = document.querySelector<HTMLPreElement>("#diagnostics-output")!;
const paletteSwatchCanvas = document.querySelector<HTMLCanvasElement>("#palette-swatches")!;

// Hold the last successful capture so toggling diagnostics on/off can
// re-render the overlay without re-capturing.
interface LastCapture {
  imageData: ImageData;
  diagnostics: DecodeFrameWarpedDiagnostics;
}
let lastCapture: LastCapture | null = null;

// -------------------------------------------------------------------------
// Diagnostics toggle wiring
// -------------------------------------------------------------------------

function loadDiagnosticsEnabled(): boolean {
  try {
    return localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveDiagnosticsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* localStorage unavailable (private mode / SSR / disabled) — silent fallback */
  }
}

diagnosticsToggle.checked = loadDiagnosticsEnabled();
diagnosticsPanel.hidden = !diagnosticsToggle.checked;

diagnosticsToggle.addEventListener("change", () => {
  saveDiagnosticsEnabled(diagnosticsToggle.checked);
  diagnosticsPanel.hidden = !diagnosticsToggle.checked;
  if (lastCapture) renderCapture(lastCapture);
});

// -------------------------------------------------------------------------
// Camera and capture
// -------------------------------------------------------------------------

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  status.textContent = "requesting camera…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    status.textContent = "camera live — point at the sender's canvas, then Capture";
    captureButton.disabled = false;
  } catch (err) {
    status.textContent = `camera error: ${(err as Error).message}`;
    startButton.disabled = false;
  }
});

captureButton.addEventListener("click", () => {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) {
    status.textContent = "camera frame not ready yet — try again in a sec";
    return;
  }

  status.textContent = "capturing…";

  const offscreen = document.createElement("canvas");
  offscreen.width = w;
  offscreen.height = h;
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true })!;
  offCtx.drawImage(video, 0, 0);
  const imageData = offCtx.getImageData(0, 0, w, h);

  const rawImage = { data: imageData.data, width: w, height: h };
  const diagnostics = decodeFrameWarpedWithDiagnostics(
    DEFAULT_GEOMETRY,
    PALETTE_2BIT,
    rawImage,
    8,
  );

  lastCapture = { imageData, diagnostics };
  renderCapture(lastCapture);
});

// -------------------------------------------------------------------------
// Rendering: preview + overlay + output text + diagnostics panel
// -------------------------------------------------------------------------

function renderCapture(capture: LastCapture): void {
  const { imageData, diagnostics } = capture;

  // Repaint the preview canvas from scratch so toggling diagnostics off
  // wipes any overlay we drew earlier.
  previewCanvas.width = imageData.width;
  previewCanvas.height = imageData.height;
  const previewCtx = previewCanvas.getContext("2d")!;
  previewCtx.putImageData(imageData, 0, 0);

  if (diagnosticsToggle.checked) {
    drawOverlay(previewCtx, diagnostics);
    diagnosticsOutput.textContent = formatDiagnostics(diagnostics);
    if (diagnostics.result) {
      drawPaletteSwatches(diagnostics.result.learnedPalette);
      paletteSwatchCanvas.hidden = false;
    } else {
      paletteSwatchCanvas.hidden = true;
    }
  }

  renderOutputText(diagnostics);
}

/** Colours used to mark the four image-corner PDP centroids. */
const CORNER_COLOURS = ["#ff5544", "#44ff66", "#4499ff", "#ffaa33"];

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  d: DecodeFrameWarpedDiagnostics,
): void {
  // Rejected candidates (anything detected that wasn't picked) — small
  // muted dots so they don't visually compete with the four chosen ones.
  if (d.detection.chosen) {
    const chosenSet = new Set<PDPCandidate>();
    // Match by reference where possible; otherwise by centroid identity.
    for (const c of d.detection.allCandidates) {
      const chosen = d.detection.chosen.some(
        (p) => Math.abs(p.x - c.centroid.x) < 0.5 && Math.abs(p.y - c.centroid.y) < 0.5,
      );
      if (chosen) chosenSet.add(c);
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    for (const c of d.detection.allCandidates) {
      if (chosenSet.has(c)) continue;
      drawDot(ctx, c.centroid, 4);
    }
  }

  // Chosen four — colour-coded by image-corner slot (TL/TR/BR/BL).
  if (d.detection.chosen) {
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = CORNER_COLOURS[i]!;
      ctx.fillStyle = CORNER_COLOURS[i]!;
      drawCross(ctx, d.detection.chosen[i]!, 14);
    }
  }
}

function drawCross(
  ctx: CanvasRenderingContext2D,
  p: Point,
  radius: number,
): void {
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(p.x - radius, p.y);
  ctx.lineTo(p.x + radius, p.y);
  ctx.moveTo(p.x, p.y - radius);
  ctx.lineTo(p.x, p.y + radius);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawDot(
  ctx: CanvasRenderingContext2D,
  p: Point,
  radius: number,
): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function renderOutputText(d: DecodeFrameWarpedDiagnostics): void {
  const result = d.result;
  if (!result) {
    output.textContent =
      `Capture failed: ${d.failureReason ?? "unknown"}.\n\n` +
      `Likely cause: fiducial detection failed or the magic didn't decode in any rotation. ` +
      `Try aiming the camera so all four corners of the sender canvas are visible, ` +
      `fill more of the frame, and hold steady.`;
    status.textContent = "capture failed";
    return;
  }

  const bytes = cellsToBytes(result.cells, PALETTE_2BIT);
  const packet = decodePacket(bytes, M4_SESSION);

  if (!packet) {
    output.textContent =
      `Decoded ${bytes.length} bytes, but packet header is invalid ` +
      `(wrong magic, version, or session_id).\n\n` +
      `Try recapturing — usually means a cell got misclassified.\n\n` +
      `First 32 raw bytes:\n${formatHex(bytes.slice(0, 32))}`;
    status.textContent = "decode failed";
    return;
  }

  const looksLikePng = isPngHeader(packet.payload);
  const orientationLabel =
    ["upright", "90° CW", "180°", "90° CCW"][result.orientation] ??
    `rotation ${result.orientation}`;
  const firstEight = formatHexInline(packet.payload.slice(0, 8));
  const pngLine = looksLikePng
    ? `   ✓ PNG file signature (89 50 4E 47 0D 0A 1A 0A) matched — payload looks intact`
    : `   ✗ Expected PNG file signature 89 50 4E 47 0D 0A 1A 0A; got ${firstEight} — some payload cells likely misclassified`;
  output.textContent =
    `✓ Packet accepted (camera held ${orientationLabel})\n` +
    `   • PHOT magic + version + session 0x${packet.sessionId.toString(16).padStart(8, "0")} all valid\n` +
    `   • Payload offset ${packet.payloadOffset}, length ${packet.payload.length} bytes\n` +
    `\nFile-content sanity check:\n` +
    `${pngLine}\n` +
    `\nFirst 64 bytes of payload:\n${formatHex(packet.payload.slice(0, 64))}`;
  status.textContent = "captured";
}

function formatDiagnostics(d: DecodeFrameWarpedDiagnostics): string {
  const lines: string[] = [];
  lines.push("=== Detection ===");
  lines.push(`Otsu threshold: ${d.detection.otsuThreshold}`);
  lines.push(`PDP candidates: ${d.detection.allCandidates.length}`);
  if (d.detection.allCandidates.length > 0) {
    lines.push("  #  centroid              area  ratio  role");
    const chosenSet = new Set<number>();
    if (d.detection.chosen) {
      for (let i = 0; i < d.detection.allCandidates.length; i++) {
        const c = d.detection.allCandidates[i]!;
        const isChosen = d.detection.chosen.some(
          (p) =>
            Math.abs(p.x - c.centroid.x) < 0.5 &&
            Math.abs(p.y - c.centroid.y) < 0.5,
        );
        if (isChosen) chosenSet.add(i);
      }
    }
    for (let i = 0; i < d.detection.allCandidates.length; i++) {
      const c = d.detection.allCandidates[i]!;
      const role = chosenSet.has(i) ? "chosen" : "rejected (not in highest-scoring 4-subset)";
      lines.push(
        `  ${String(i).padStart(2)} (${c.centroid.x.toFixed(1).padStart(7)}, ${c.centroid.y.toFixed(1).padStart(7)}) ` +
          `${String(c.whiteRingArea + c.blackCentreArea).padStart(5)}  ${c.areaRatio.toFixed(2).padStart(5)}  ${role}`,
      );
    }
  }
  lines.push("");
  lines.push("=== Rotation attempts ===");
  if (d.rotationsAttempted.length === 0) {
    lines.push("(none — detection failed before rotation check)");
  } else {
    lines.push("  rot   magic bytes      matched");
    const rotLabels = ["upright", "90° CW", "180°", "90° CCW"];
    for (const attempt of d.rotationsAttempted) {
      const hex = formatHexInline(attempt.magicBytes);
      lines.push(
        `  ${attempt.rotation} (${rotLabels[attempt.rotation]?.padEnd(7) ?? "?      "})  ${hex}   ${attempt.matched ? "✓ matched" : "✗"}`,
      );
    }
  }
  if (d.result) {
    lines.push("");
    lines.push("=== Learned palette (M5) ===");
    const canonical = PALETTE_2BIT.colors;
    for (let i = 0; i < d.result.learnedPalette.colors.length; i++) {
      const [lr, lg, lb] = d.result.learnedPalette.colors[i]!;
      const [cr, cg, cb] = canonical[i] ?? [0, 0, 0];
      const dr = Math.round(lr) - cr;
      const dg = Math.round(lg) - cg;
      const db = Math.round(lb) - cb;
      lines.push(
        `  palette[${i}] canonical (${pad3(cr)}, ${pad3(cg)}, ${pad3(cb)})` +
          `  →  learned (${pad3(Math.round(lr))}, ${pad3(Math.round(lg))}, ${pad3(Math.round(lb))})` +
          `  Δ (${signed(dr)}, ${signed(dg)}, ${signed(db)})`,
      );
    }
  }
  if (d.failureReason) {
    lines.push("");
    lines.push(`Failure reason: ${d.failureReason}`);
  }
  return lines.join("\n");
}

function pad3(n: number): string {
  return String(n).padStart(3, " ");
}
function signed(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${pad3(Math.abs(n))}`;
}

/**
 * Draw two rows of palette swatches into the diagnostics-panel canvas:
 *   top row = canonical RGB the sender renders,
 *   bottom row = observed RGB the receiver learned from this frame's
 *   calibration strip.
 *
 * Visual side-by-side makes "this colour got pulled down by white balance"
 * obvious in a way the text RGB triplets don't.
 */
function drawPaletteSwatches(learned: { colors: ReadonlyArray<readonly [number, number, number]> }): void {
  const canvas = paletteSwatchCanvas;
  const ctx = canvas.getContext("2d")!;
  const swatchSize = 56;
  const padding = 6;
  const labelWidth = 84;
  const numColors = learned.colors.length;
  canvas.width = labelWidth + numColors * (swatchSize + padding);
  canvas.height = 2 * swatchSize + padding;
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Swatches
  for (let i = 0; i < numColors; i++) {
    const x = labelWidth + i * (swatchSize + padding);
    const [cr, cg, cb] = PALETTE_2BIT.colors[i]!;
    ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
    ctx.fillRect(x, 0, swatchSize, swatchSize);
    const [lr, lg, lb] = learned.colors[i]!;
    ctx.fillStyle = `rgb(${Math.round(lr)}, ${Math.round(lg)}, ${Math.round(lb)})`;
    ctx.fillRect(x, swatchSize + padding, swatchSize, swatchSize);
  }

  // Labels
  ctx.fillStyle = "#bbb";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("canonical", 6, swatchSize / 2);
  ctx.fillText("learned", 6, swatchSize + padding + swatchSize / 2);

  // Index labels under each swatch column
  ctx.fillStyle = "#666";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < numColors; i++) {
    const x = labelWidth + i * (swatchSize + padding) + swatchSize / 2;
    ctx.fillText(`#${i}`, x, 2);
  }
}

function formatHexInline(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

function formatHex(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0")).join(" ");
    lines.push(hex);
  }
  return lines.join("\n");
}

function isPngHeader(bytes: Uint8Array): boolean {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}
