import "../style.css";
if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
import {
  BackChannelMessageType,
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  cellsToBytes,
  decodeBackChannelFrame,
  decodeCapabilities,
  decodeFrameWarpedWithDiagnostics,
  decodeHello,
  payloadCellCount,
  pickCellSizeFromCapabilities,
  rsDecodeAll,
  type SessionInfo,
} from "../protocol";

/**
 * Back-channel receiver (M11). Continuously captures the camera and
 * decodes any back-channel frames it sees. For M11 we accept any
 * session_id (no handshake yet); M13+ will tie this to the unicast
 * session.
 */

const NSYM = 32;
const STREAM_INTERVAL_MS = 100;

const startButton = document.querySelector<HTMLButtonElement>("#start-camera")!;
const streamButton = document.querySelector<HTMLButtonElement>("#stream-button")!;
const video = document.querySelector<HTMLVideoElement>("#camera-video")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const preview = document.querySelector<HTMLCanvasElement>("#capture-preview")!;
const log = document.querySelector<HTMLPreElement>("#bc-log")!;

const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
const capacityBytes = (capacityCells * 2) / 8;
const RS_BLOCKS = Math.floor(capacityBytes / 255);
const RS_ENCODED_BYTES = RS_BLOCKS * 255;

// Use a wildcard "match any session" by trying a few common candidate IDs.
// For M11's done-when the TX hardcodes 0xb4cbac0c.
const CANDIDATE_SESSIONS: SessionInfo[] = [{ sessionId: 0xb4cbac0c >>> 0 }];

let streaming = false;
let firstCaptureAt = 0;
let lastDecodedAt = 0;
let messagesDecoded = 0;
const seenSeqs = new Set<number>();
const messages: { atMs: number; text: string; seq: number }[] = [];

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
    streaming = false;
    streamButton.textContent = "Start receiving";
    status.textContent = "stopped";
    return;
  }
  streaming = true;
  firstCaptureAt = performance.now();
  streamButton.textContent = "Stop receiving";
  schedule();
});

function schedule(): void {
  if (!streaming) return;
  setTimeout(tick, STREAM_INTERVAL_MS);
}

function tick(): void {
  if (!streaming) return;
  decodeOnce();
  schedule();
}

function decodeOnce(): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return;
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const oc = off.getContext("2d", { willReadFrequently: true })!;
  oc.drawImage(video, 0, 0);
  const imageData = oc.getImageData(0, 0, w, h);
  preview.width = w;
  preview.height = h;
  preview.getContext("2d")!.putImageData(imageData, 0, 0);

  const d = decodeFrameWarpedWithDiagnostics(
    DEFAULT_GEOMETRY,
    PALETTE_2BIT,
    { data: imageData.data, width: w, height: h },
    8,
  );
  if (!d.result) return;
  const allBytes = cellsToBytes(d.result.cells, PALETTE_2BIT);
  if (allBytes.length < RS_ENCODED_BYTES) return;
  let wire: Uint8Array;
  try {
    wire = rsDecodeAll(allBytes.subarray(0, RS_ENCODED_BYTES), NSYM);
  } catch {
    return;
  }
  for (const sess of CANDIDATE_SESSIONS) {
    const parsed = decodeBackChannelFrame(wire, sess);
    if (!parsed) continue;
    if (seenSeqs.has(parsed.seq)) return;
    seenSeqs.add(parsed.seq);
    if (parsed.msg.type === BackChannelMessageType.Hello) {
      const text = decodeHello(parsed.msg) ?? "";
      lastDecodedAt = performance.now();
      messagesDecoded++;
      const atMs = Math.round(lastDecodedAt - firstCaptureAt);
      messages.push({ atMs, text: `hello: "${text}"`, seq: parsed.seq });
      renderLog();
      status.textContent = `decoded hello "${text}" at +${atMs} ms`;
    } else if (parsed.msg.type === BackChannelMessageType.Capabilities) {
      const cap = decodeCapabilities(parsed.msg);
      if (cap) {
        const cellSizePicked = pickCellSizeFromCapabilities(cap);
        lastDecodedAt = performance.now();
        messagesDecoded++;
        const atMs = Math.round(lastDecodedAt - firstCaptureAt);
        const summary =
          `caps: cell ${cap.minCellSizePx}-${cap.maxCellSizePx}px (would pick ${cellSizePicked}px), ` +
          `fps≤${cap.preferredFps}, grid ${cap.preferredCellsX}×${cap.preferredCellsY}, nsym ${cap.rsNsymTier}`;
        messages.push({ atMs, text: summary, seq: parsed.seq });
        renderLog();
        status.textContent = `negotiated cell size ${cellSizePicked}px at +${atMs} ms`;
      }
    }
    return;
  }
}

function renderLog(): void {
  const lines = messages.slice(-20).map((m) => `[+${m.atMs} ms, seq ${m.seq}] ${m.text}`);
  log.textContent = lines.join("\n");
}
