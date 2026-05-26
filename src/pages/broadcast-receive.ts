import "../style.css";
if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
import {
  DEFAULT_GEOMETRY,
  EXTENDED_SLOT_TOTAL,
  PALETTE_2BIT,
  bootstrapMime,
  bootstrapReady,
  cellsToBytes,
  decodeBroadcastFrame,
  decodeFilename,
  decodeFrameWarpedWithDiagnostics,
  filenameComplete,
  fountainComplete,
  ingestBootstrap,
  ingestEncodedPacket,
  newBootstrapAccumulator,
  newFountainDecoder,
  payloadCellCount,
  recoverPayload,
  rsDecodeFrame,
  sha256Complete,
  sourcePacketSizeForGeometry,
  type BootstrapAccumulator,
  type FountainDecoder,
} from "../protocol";

/**
 * Broadcast receiver (M10). Tunes in mid-stream, accumulates bootstrap
 * metadata across rotating slots, ingests fountain-encoded packets into
 * the LT peeling decoder, and saves the result with the correct filename
 * once both layers are complete.
 */

const STREAM_INTERVAL_MS = 100; // 10 fps
const NSYM = 32;

const startButton = document.querySelector<HTMLButtonElement>("#start-camera")!;
const streamButton = document.querySelector<HTMLButtonElement>("#stream-button")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save-button")!;
const video = document.querySelector<HTMLVideoElement>("#camera-video")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const previewCanvas = document.querySelector<HTMLCanvasElement>("#capture-preview")!;
const progressOutput = document.querySelector<HTMLPreElement>("#progress-output")!;
const decodedOutput = document.querySelector<HTMLPreElement>("#decoded-output")!;

const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
const capacityBytes = (capacityCells * 2) / 8;
const SOURCE_PACKET_SIZE = sourcePacketSizeForGeometry(DEFAULT_GEOMETRY, NSYM);

interface SessionState {
  acc: BootstrapAccumulator;
  decoder: FountainDecoder;
}
let session: SessionState | null = null;
let streaming = false;
let framesProcessed = 0;
let bootstrapPacketsAccepted = 0;
let fountainPacketsAccepted = 0;
const rejectCounts: Record<string, number> = {
  "rs-decode-failed": 0,
  "no-fiducial": 0,
  "magic-mismatch": 0,
  "broadcast-decode-failed": 0,
  "session-mismatch": 0,
  "fountain-rejected": 0,
};

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  status.textContent = "requesting camera…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    status.textContent = "camera live — click Start receiving";
    streamButton.disabled = false;
  } catch (err) {
    status.textContent = `camera error: ${(err as Error).message}`;
    startButton.disabled = false;
  }
});

streamButton.addEventListener("click", () => {
  if (streaming) {
    stopStreaming();
    return;
  }
  startStreaming();
});

function startStreaming(): void {
  streaming = true;
  session = null;
  framesProcessed = 0;
  bootstrapPacketsAccepted = 0;
  fountainPacketsAccepted = 0;
  for (const k of Object.keys(rejectCounts)) rejectCounts[k] = 0;
  streamButton.textContent = "Stop receiving";
  saveButton.disabled = true;
  status.textContent = "streaming…";
  decodedOutput.textContent = "Waiting for first frame…";
  scheduleTick();
}

function stopStreaming(): void {
  streaming = false;
  streamButton.textContent = "Start receiving";
  status.textContent = "stopped";
}

function scheduleTick(): void {
  if (!streaming) return;
  setTimeout(streamTick, STREAM_INTERVAL_MS);
}

function streamTick(): void {
  if (!streaming) return;
  framesProcessed++;
  ingestOneFrameFromCamera();
  updateProgress();
  scheduleTick();
}

function ingestOneFrameFromCamera(): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return;
  const offscreen = document.createElement("canvas");
  offscreen.width = w;
  offscreen.height = h;
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true })!;
  offCtx.drawImage(video, 0, 0);
  const imageData = offCtx.getImageData(0, 0, w, h);
  const rawImage = { data: imageData.data, width: w, height: h };

  const d = decodeFrameWarpedWithDiagnostics(DEFAULT_GEOMETRY, PALETTE_2BIT, rawImage, 8);

  previewCanvas.width = w;
  previewCanvas.height = h;
  previewCanvas.getContext("2d")!.putImageData(imageData, 0, 0);

  if (!d.result) {
    if (d.failureReason && d.failureReason.includes("PDP")) rejectCounts["no-fiducial"]! += 1;
    else rejectCounts["magic-mismatch"]! += 1;
    return;
  }
  const allBytes = cellsToBytes(d.result.cells, PALETTE_2BIT);
  if (allBytes.length < capacityBytes) return;
  let dataBytes: Uint8Array;
  try {
    dataBytes = rsDecodeFrame(allBytes.subarray(0, capacityBytes), capacityBytes, NSYM);
  } catch {
    rejectCounts["rs-decode-failed"]! += 1;
    return;
  }
  const frame = decodeBroadcastFrame(dataBytes, SOURCE_PACKET_SIZE);
  if (!frame) {
    rejectCounts["broadcast-decode-failed"]! += 1;
    return;
  }

  if (!session) {
    session = {
      acc: newBootstrapAccumulator(frame.bootstrap),
      decoder: newFountainDecoder(frame.bootstrap.sourceCount, SOURCE_PACKET_SIZE),
    };
  }
  if (session.acc.sessionId !== frame.bootstrap.sessionId) {
    rejectCounts["session-mismatch"]! += 1;
    return;
  }

  const ingResult = ingestBootstrap(session.acc, frame.bootstrap);
  if (ingResult === "slot-updated") bootstrapPacketsAccepted++;

  const fr = ingestEncodedPacket(session.decoder, frame.encoded);
  if (fr === "accepted") fountainPacketsAccepted++;
  else if (fr === "rejected") rejectCounts["fountain-rejected"]! += 1;

  maybeFinish();
}

function updateProgress(): void {
  if (!session) {
    progressOutput.textContent = `frames processed: ${framesProcessed}    no session yet`;
    return;
  }
  const acc = session.acc;
  const dec = session.decoder;
  const sha256Done = sha256Complete(acc);
  const fnDone = filenameComplete(acc);
  const sha256Slots = acc.sha256SlotSeen.filter(Boolean).length;
  const fnSlots = acc.filenameSlotSeen.filter(Boolean).length;
  const fountainPct = ((dec.recovered.size / dec.K) * 100).toFixed(1);

  const rejectBreakdown = Object.entries(rejectCounts)
    .filter(([, c]) => c > 0)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  progressOutput.textContent =
    `frames processed: ${framesProcessed}    bootstrap pkts: ${bootstrapPacketsAccepted}    fountain pkts: ${fountainPacketsAccepted}` +
    (rejectBreakdown ? `    (${rejectBreakdown})` : "") +
    `\n` +
    `session: 0x${acc.sessionId.toString(16).padStart(8, "0")}    K=${acc.sourceCount} S=${SOURCE_PACKET_SIZE} payload=${acc.payloadSize} bytes\n` +
    `bootstrap:   sha256 ${sha256Slots}/8 ${sha256Done ? "✓" : "…"}    filename ${fnSlots}/16 ${fnDone ? "✓" : "…"}\n` +
    `fountain:    ${dec.recovered.size}/${dec.K} source pkts recovered (${fountainPct}%)\n` +
    `slot progress: [${EXTENDED_SLOT_TOTAL ? renderSlotBar(acc) : ""}]`;
}

function renderSlotBar(acc: BootstrapAccumulator): string {
  const cells: string[] = [];
  for (let i = 0; i < EXTENDED_SLOT_TOTAL; i++) {
    if (i < acc.sha256SlotSeen.length) {
      cells.push(acc.sha256SlotSeen[i] ? "#" : ".");
    } else {
      const fnIdx = i - acc.sha256SlotSeen.length;
      cells.push(acc.filenameSlotSeen[fnIdx] ? "#" : ".");
    }
  }
  return cells.join("");
}

let saveBlobAvailable = false;
async function maybeFinish(): Promise<void> {
  if (!session) return;
  if (!fountainComplete(session.decoder)) return;
  if (!bootstrapReady(session.acc)) return;
  if (saveBlobAvailable) return;
  // We have everything needed to verify and save.
  const sources = recoverPayload(session.decoder);
  const concatenated = new Uint8Array(sources.length * SOURCE_PACKET_SIZE);
  let off = 0;
  for (const s of sources) {
    concatenated.set(s, off);
    off += s.length;
  }
  const trimmed = concatenated.subarray(0, session.acc.payloadSize);
  const computed = new Uint8Array(
    await crypto.subtle.digest("SHA-256", trimmed.slice().buffer),
  );
  const matches = bytesEqual(computed, session.acc.sha256);
  const filename = decodeFilename(session.acc) || "photophone-broadcast.bin";
  const mime = bootstrapMime(session.acc);
  const sha256Hex = Array.from(computed.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join(" ");
  decodedOutput.textContent =
    `✓ Broadcast assembled\n` +
    `   filename: ${filename}\n` +
    `   mime:     ${mime}\n` +
    `   bytes:    ${trimmed.length}\n` +
    `   sha256(8): ${sha256Hex}…\n` +
    `   integrity: ${matches ? "MATCH (sender's sha256 verified)" : "MISMATCH — corrupted"}\n` +
    `\nClick Save to download.`;
  saveButton.disabled = false;
  saveBlobAvailable = true;

  saveButton.onclick = () => {
    const blob = new Blob([new Uint8Array(trimmed)], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
