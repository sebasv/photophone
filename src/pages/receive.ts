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
  cellsToBytes,
  decodeFrameWarpedWithDiagnostics,
  decodePacket,
  ingest,
  missing,
  newReassembly,
  payloadCellCount,
  rsDecodeAll,
  type DecodeFrameWarpedDiagnostics,
  type PDPCandidate,
  type Point,
  type ReassemblyState,
  type SessionInfo,
} from "../protocol";

/**
 * Receiver — single-frame capture (M4) + streaming reassembly (M6).
 *
 * Single capture: snap one frame, decode it, dump the decoded packet's
 * payload. Useful for verifying alignment and lighting before streaming.
 *
 * Streaming: loop on the camera at ~10 fps, ingest every decodable
 * packet into a reassembly state, surface progress against the user-
 * supplied total payload size. Stops automatically when the buffer is
 * complete; the user can save the result as a downloaded file.
 */

const SESSION: SessionInfo = { sessionId: 0xdeadbeef };
const DIAGNOSTICS_STORAGE_KEY = "photophone.diagnostics.enabled";
const STREAM_INTERVAL_MS = 100; // 10 fps decode cadence

// Reed-Solomon protection parameters. Must match the sender (send.ts).
const NSYM = 32;
const RS_BLOCKS = Math.floor((payloadCellCount(DEFAULT_GEOMETRY) * 2 / 8) / 255);
const RS_ENCODED_BYTES = RS_BLOCKS * 255;

const startButton = document.querySelector<HTMLButtonElement>("#start-camera")!;
const captureButton = document.querySelector<HTMLButtonElement>("#capture-frame")!;
const streamButton = document.querySelector<HTMLButtonElement>("#stream-button")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save-button")!;
const video = document.querySelector<HTMLVideoElement>("#camera-video")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const output = document.querySelector<HTMLPreElement>("#decoded-output")!;
const progressLine = document.querySelector<HTMLPreElement>("#progress-output")!;
const previewCanvas = document.querySelector<HTMLCanvasElement>("#capture-preview")!;
const diagnosticsToggle = document.querySelector<HTMLInputElement>("#diagnostics-toggle")!;
const diagnosticsPanel = document.querySelector<HTMLElement>("#diagnostics-panel")!;
const diagnosticsOutput = document.querySelector<HTMLPreElement>("#diagnostics-output")!;
const paletteSwatchCanvas = document.querySelector<HTMLCanvasElement>("#palette-swatches")!;

interface LastCapture {
  imageData: ImageData;
  diagnostics: DecodeFrameWarpedDiagnostics;
}
let lastCapture: LastCapture | null = null;
let streaming = false;
let reassembly: ReassemblyState | null = null;
let packetsAccepted = 0;
let packetsRejected = 0;
let framesProcessed = 0;
const rejectCounts: Record<string, number> = {
  "rs-decode-failed": 0,
  "rejected-malformed": 0,
  "rejected-version": 0,
  "rejected-session": 0,
};
let lastRejectPeek: { reason: string; offset: number; length: number; sessionId: number } | null = null;

// -------------------------------------------------------------------------
// Diagnostics toggle wiring (unchanged from M4.5)
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
    /* localStorage unavailable; silent fallback */
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
// Camera lifecycle
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
    status.textContent = "camera live — Capture or Start streaming";
    captureButton.disabled = false;
    streamButton.disabled = false;
  } catch (err) {
    status.textContent = `camera error: ${(err as Error).message}`;
    startButton.disabled = false;
  }
});

// -------------------------------------------------------------------------
// Single-frame capture (M4)
// -------------------------------------------------------------------------

captureButton.addEventListener("click", () => {
  const captured = captureOnce();
  if (!captured) return;
  lastCapture = captured;
  renderCapture(captured);
});

function captureOnce(): LastCapture | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) {
    status.textContent = "camera frame not ready yet — try again in a sec";
    return null;
  }
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
  return { imageData, diagnostics };
}

// -------------------------------------------------------------------------
// Streaming capture + reassembly (M6)
// -------------------------------------------------------------------------

streamButton.addEventListener("click", () => {
  if (streaming) {
    stopStreaming();
    return;
  }
  startStreaming();
});

function startStreaming(): void {
  reassembly = newReassembly(SESSION);
  packetsAccepted = 0;
  packetsRejected = 0;
  framesProcessed = 0;
  for (const k of Object.keys(rejectCounts)) rejectCounts[k] = 0;
  lastRejectPeek = null;
  streaming = true;
  streamButton.textContent = "Stop receiving";
  saveButton.disabled = true;
  status.textContent = "streaming…";
  scheduleNextStreamTick();
}

function stopStreaming(): void {
  streaming = false;
  streamButton.textContent = "Start receiving";
  if (reassembly && reassembly.received.length > 0) {
    saveButton.disabled = false;
  }
  status.textContent = "stopped";
}

function scheduleNextStreamTick(): void {
  if (!streaming) return;
  setTimeout(streamTick, STREAM_INTERVAL_MS);
}

function streamTick(): void {
  if (!streaming || !reassembly) return;
  framesProcessed++;
  const captured = captureOnce();
  if (captured) {
    lastCapture = captured;
    const wire = decodedWireBytes(captured.diagnostics);
    if (wire) {
      const result = ingest(reassembly, wire);
      if (result === "accepted") {
        packetsAccepted++;
      } else if (result === "duplicate") {
        // Don't count toward either; receiver saw this byte range already.
      } else {
        packetsRejected++;
        rejectCounts[result] = (rejectCounts[result] ?? 0) + 1;
        lastRejectPeek = peekRejectedHeader(wire, result);
      }
    }
    renderCapture(captured);
  }
  updateProgress();
  if (reassembly && reassembly.received.length > 0 && reassembly.received[0]!.offset === 0) {
    // Enable Save as soon as there's any contiguous prefix to save.
    saveButton.disabled = false;
  }
  scheduleNextStreamTick();
}

function decodedWireBytes(d: DecodeFrameWarpedDiagnostics): Uint8Array | null {
  if (!d.result) return null;
  const allBytes = cellsToBytes(d.result.cells, PALETTE_2BIT);
  if (allBytes.length < RS_ENCODED_BYTES) return null;
  const ecc = allBytes.subarray(0, RS_ENCODED_BYTES);
  try {
    return rsDecodeAll(ecc, NSYM);
  } catch {
    rejectCounts["rs-decode-failed"]! += 1;
    packetsRejected++;
    lastRejectPeek = { reason: "rs-decode-failed", offset: -1, length: -1, sessionId: -1 };
    return null;
  }
}

function updateProgress(): void {
  if (!reassembly) {
    progressLine.textContent = "";
    return;
  }
  const first = reassembly.received[0];
  const contiguousFromZero = first && first.offset === 0 ? first.length : 0;
  const highest = reassembly.highestByte;
  const gaps = missing(reassembly);
  const rejectBreakdown = Object.entries(rejectCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  const lastRejectLine = lastRejectPeek
    ? `\nlast rejection (${lastRejectPeek.reason}): session=0x${lastRejectPeek.sessionId.toString(16).padStart(8, "0")} offset=${lastRejectPeek.offset} len=${lastRejectPeek.length}`
    : "";
  progressLine.textContent =
    `frames processed: ${framesProcessed}\n` +
    `packets accepted: ${packetsAccepted}    rejected: ${packetsRejected}` +
    (rejectBreakdown ? ` (${rejectBreakdown})` : "") +
    `\n` +
    `contiguous from 0: ${contiguousFromZero} bytes    highest seen: ${highest} bytes\n` +
    `${formatProgressBar(Math.max(highest, 1), reassembly.received, 60)}\n` +
    `gaps below highest: ${gaps.length === 0 ? "none" : gaps.slice(0, 3).map((g) => `[${g.offset}+${g.length}]`).join(" ") + (gaps.length > 3 ? ` … (+${gaps.length - 3} more)` : "")}` +
    lastRejectLine;
}

function formatProgressBar(
  totalSize: number,
  received: ReadonlyArray<{ offset: number; length: number }>,
  width: number,
): string {
  const buf = new Array(width).fill(".");
  for (const r of received) {
    const start = Math.floor((r.offset / totalSize) * width);
    const end = Math.ceil(((r.offset + r.length) / totalSize) * width);
    for (let i = start; i < end && i < width; i++) buf[i] = "#";
  }
  return `[${buf.join("")}]`;
}

// -------------------------------------------------------------------------
// Save the assembled bytes as a file download
// -------------------------------------------------------------------------

saveButton.addEventListener("click", () => {
  if (!reassembly || reassembly.received.length === 0) return;
  const first = reassembly.received[0];
  if (!first || first.offset !== 0) {
    status.textContent = "no contiguous prefix to save (first received range doesn't start at offset 0)";
    return;
  }
  const bytes = reassembly.buffer.slice(0, first.length);
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `photophone-received-${Date.now()}.bin`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// -------------------------------------------------------------------------
// Rendering (overlay + output) — shared by single-capture and streaming
// -------------------------------------------------------------------------

function renderCapture(capture: LastCapture): void {
  const { imageData, diagnostics } = capture;
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

const CORNER_COLOURS = ["#ff5544", "#44ff66", "#4499ff", "#ffaa33"];

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  d: DecodeFrameWarpedDiagnostics,
): void {
  if (d.detection.chosen) {
    const chosenSet = new Set<PDPCandidate>();
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
  if (d.detection.chosen) {
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = CORNER_COLOURS[i]!;
      ctx.fillStyle = CORNER_COLOURS[i]!;
      drawCross(ctx, d.detection.chosen[i]!, 14);
    }
  }
}

function drawCross(ctx: CanvasRenderingContext2D, p: Point, radius: number): void {
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
function drawDot(ctx: CanvasRenderingContext2D, p: Point, radius: number): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function renderOutputText(d: DecodeFrameWarpedDiagnostics): void {
  const result = d.result;
  if (!result) {
    output.textContent =
      `Capture failed: ${d.failureReason ?? "unknown"}.\n\n` +
      `Likely cause: fiducial detection failed or the magic didn't decode ` +
      `in any rotation. Try aiming the camera so all four corners of the ` +
      `sender canvas are visible, fill more of the frame, and hold steady.`;
    if (!streaming) status.textContent = "capture failed";
    return;
  }
  const allBytes = cellsToBytes(result.cells, PALETTE_2BIT);
  if (allBytes.length < RS_ENCODED_BYTES) {
    output.textContent = `Capture decoded only ${allBytes.length} bytes; expected at least ${RS_ENCODED_BYTES} for RS unwrap.`;
    if (!streaming) status.textContent = "decode short";
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = rsDecodeAll(allBytes.subarray(0, RS_ENCODED_BYTES), NSYM);
  } catch (err) {
    output.textContent =
      `Reed-Solomon decode failed: ${(err as Error).message}\n\n` +
      `Means more than ${Math.floor(NSYM / 2)} byte errors in at least one ` +
      `RS block. Try better lighting, less motion blur, or hold the camera ` +
      `closer to the sender's canvas.`;
    if (!streaming) status.textContent = "RS decode failed";
    return;
  }
  const packet = decodePacket(bytes, SESSION);
  if (!packet) {
    output.textContent =
      `Decoded ${bytes.length} bytes, but packet header is invalid ` +
      `(wrong magic, version, or session_id).\n\n` +
      `Try recapturing — usually means a cell got misclassified.\n\n` +
      `First 32 raw bytes:\n${formatHex(bytes.slice(0, 32))}`;
    if (!streaming) status.textContent = "decode failed";
    return;
  }
  const looksLikePng = isPngHeader(packet.payload);
  const orientationLabel =
    ["upright", "90° CW", "180°", "90° CCW"][result.orientation] ??
    `rotation ${result.orientation}`;
  const firstEight = formatHexInline(packet.payload.slice(0, 8));
  const pngLine = looksLikePng
    ? `   ✓ PNG file signature (89 50 4E 47 0D 0A 1A 0A) matched`
    : `   payload's first 8 bytes: ${firstEight}`;
  output.textContent =
    `✓ Packet accepted (camera held ${orientationLabel})\n` +
    `   • PHOT magic + version + session 0x${packet.sessionId.toString(16).padStart(8, "0")} all valid\n` +
    `   • Payload offset ${packet.payloadOffset}, length ${packet.payload.length} bytes\n` +
    `\n${pngLine}\n` +
    `\nFirst 64 bytes of payload:\n${formatHex(packet.payload.slice(0, 64))}`;
  if (!streaming) status.textContent = "captured";
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


/**
 * Without RS in the wire (M7 isn't yet integrated into send/receive), a
 * single misclassified cell in bytes 10-13 of the packet header corrupts
 * the u32 payload_offset to an arbitrary value, and ingest rejects with
 * "out-of-bounds" or "rejected-malformed". To make this visible while
 * streaming we peek at what the receiver actually parsed out of the wire
 * after a rejection, so the user can tell at a glance whether the offset
 * looks plausible or astronomically wrong.
 */
function peekRejectedHeader(
  wire: Uint8Array,
  reason: string,
): { reason: string; offset: number; length: number; sessionId: number } {
  if (wire.length < 16) {
    return { reason, offset: -1, length: -1, sessionId: -1 };
  }
  const view = new DataView(wire.buffer, wire.byteOffset, 16);
  return {
    reason,
    sessionId: view.getUint32(6, false),
    offset: view.getUint32(10, false),
    length: view.getUint16(14, false),
  };
}
