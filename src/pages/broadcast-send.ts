import "../style.css";
if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
import {
  BOOTSTRAP_SIZE,
  BROADCAST_HEADER_SIZE,
  DEFAULT_GEOMETRY,
  EXTENDED_SLOT_TOTAL,
  FILENAME_MAX,
  PALETTE_2BIT,
  SHA256_SLOT_COUNT,
  bytesToCells,
  crc32,
  encodeBroadcastFrame,
  encodeOnePacket,
  idealSolitonDegree,
  mimeIndexFor,
  payloadCellCount,
  renderFrame,
  rsEncodeFrame,
  sourcePacketSizeForGeometry,
  type BootstrapFields,
} from "../protocol";

/**
 * Broadcast sender (M10). Reads a file, splits it into K equal-size source
 * packets, and continuously emits LT-coded encoded packets — every frame
 * also embeds bootstrap metadata so a late-joining receiver can sync.
 */

const CELL_SIZE_PX = 12;
const STREAM_FRAME_INTERVAL_MS = 200; // 5 fps
const NSYM = 32;

const fileInput = document.querySelector<HTMLInputElement>("#payload-input")!;
const streamButton = document.querySelector<HTMLButtonElement>("#stream-button")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const sessionInfo = document.querySelector<HTMLPreElement>("#session-info")!;
const canvas = document.querySelector<HTMLCanvasElement>("#frame-canvas")!;
const ctx = canvas.getContext("2d")!;

const capacityCells = payloadCellCount(DEFAULT_GEOMETRY);
const capacityBytes = (capacityCells * 2) / 8;
const SOURCE_PACKET_SIZE = sourcePacketSizeForGeometry(DEFAULT_GEOMETRY, NSYM);

interface BroadcastSession {
  sessionId: number;
  K: number;
  S: number;
  sources: Uint8Array[];
  sha256: Uint8Array;
  filenameBytes: Uint8Array; // padded to FILENAME_MAX
  filenameHash: number; // first 4 bytes of sha256(filename) as u32
  filename: string;
  mimeIndex: number;
  payloadSize: number;
}

let session: BroadcastSession | null = null;
let streamIntervalId: ReturnType<typeof setInterval> | null = null;
let slotCursor = 0;
let frameCounter = 0;

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  status.textContent = "preparing session…";
  const payload = new Uint8Array(await file.arrayBuffer());
  session = await buildSession(file.name, payload);
  streamButton.disabled = false;
  slotCursor = 0;
  frameCounter = 0;
  renderSessionInfo();
  status.textContent = "ready — click Start broadcast";
});

streamButton.addEventListener("click", () => {
  if (!session) return;
  if (streamIntervalId !== null) {
    stopStream();
    return;
  }
  startStream();
});

function startStream(): void {
  if (!session) return;
  streamButton.textContent = "Stop broadcast";
  status.textContent = "broadcasting…";
  emitFrame();
  streamIntervalId = setInterval(emitFrame, STREAM_FRAME_INTERVAL_MS);
}

function stopStream(): void {
  if (streamIntervalId !== null) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
  streamButton.textContent = "Start broadcast";
  status.textContent = "stopped";
}

function emitFrame(): void {
  if (!session) return;
  // PRNG seed for this packet: combine frame counter and session id.
  const seed = ((session.sessionId ^ (frameCounter * 0x9e3779b1)) & 0xffffff) >>> 0;
  // Pick a degree from the Ideal Soliton distribution. For very small K
  // (< 4) Ideal Soliton can fail to draw 1 frequently enough; clamp.
  const u = Math.random();
  let degree = idealSolitonDegree(u, session.K);
  if (degree < 1) degree = 1;
  if (degree > session.K) degree = session.K;

  void session.S;
  const encoded = encodeOnePacket(session.sources, degree, seed);

  const slotData = extendedSlotData(session, slotCursor);
  const bootstrap: BootstrapFields = {
    sessionId: session.sessionId,
    sourceCount: session.K,
    payloadSize: session.payloadSize,
    filenameHash: session.filenameHash,
    mimeIndex: session.mimeIndex,
    extendedSlot: slotCursor,
    extendedData: slotData,
  };
  slotCursor = (slotCursor + 1) % EXTENDED_SLOT_TOTAL;
  frameCounter++;

  const wire = encodeBroadcastFrame({ bootstrap, encoded });
  // rsEncodeFrame fills exactly capacityBytes and throws on oversize.
  const framePayload = rsEncodeFrame(wire, capacityBytes, NSYM);
  const cells = bytesToCells(framePayload, PALETTE_2BIT);
  const img = renderFrame(DEFAULT_GEOMETRY, PALETTE_2BIT, cells, CELL_SIZE_PX);
  canvas.width = img.width;
  canvas.height = img.height;
  const out = ctx.createImageData(img.width, img.height);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
  status.textContent = `broadcasting — frame ${frameCounter} (slot ${slotCursor === 0 ? EXTENDED_SLOT_TOTAL : slotCursor - 1})`;
}

function extendedSlotData(s: BroadcastSession, slot: number): Uint8Array {
  if (slot < SHA256_SLOT_COUNT) {
    return s.sha256.slice(slot * 4, slot * 4 + 4);
  }
  const fnSlot = slot - SHA256_SLOT_COUNT;
  return s.filenameBytes.slice(fnSlot * 4, fnSlot * 4 + 4);
}

async function buildSession(filename: string, payload: Uint8Array): Promise<BroadcastSession> {
  const sessionId = Math.floor(Math.random() * 0x100000000) >>> 0;
  const S = SOURCE_PACKET_SIZE;
  const K = Math.ceil(payload.length / S);
  if (K > 0xffff) {
    throw new Error(`payload too large: K=${K} exceeds u16`);
  }
  const padded = new Uint8Array(K * S);
  padded.set(payload);
  const sources: Uint8Array[] = [];
  for (let i = 0; i < K; i++) {
    sources.push(padded.subarray(i * S, (i + 1) * S));
  }
  const sha256Buf = await crypto.subtle.digest("SHA-256", payload.slice().buffer);
  const sha256 = new Uint8Array(sha256Buf);
  const filenameBytes = new Uint8Array(FILENAME_MAX);
  const enc = new TextEncoder().encode(filename);
  filenameBytes.set(enc.subarray(0, Math.min(enc.length, FILENAME_MAX)));
  const filenameSha = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.slice().buffer));
  const filenameHash =
    (filenameSha[0]! << 24) |
    (filenameSha[1]! << 16) |
    (filenameSha[2]! << 8) |
    filenameSha[3]!;
  const mimeIndex = mimeIndexFor(filename);
  return {
    sessionId,
    K,
    S,
    sources,
    sha256,
    filenameBytes,
    filenameHash: filenameHash >>> 0,
    filename,
    mimeIndex,
    payloadSize: payload.length,
  };
}

function renderSessionInfo(): void {
  if (!session) {
    sessionInfo.textContent = "";
    return;
  }
  const sha = Array.from(session.sha256.subarray(0, 8), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join(" ");
  void crc32; // referenced from re-export of bootstrap.ts
  sessionInfo.textContent =
    `session_id: 0x${session.sessionId.toString(16).padStart(8, "0")}\n` +
    `filename:   ${session.filename}\n` +
    `payload:    ${session.payloadSize} bytes\n` +
    `K × S:      ${session.K} × ${session.S} = ${session.K * session.S} bytes (incl. zero-pad)\n` +
    `mime_index: ${session.mimeIndex}\n` +
    `sha256(8):  ${sha} …\n` +
    `bootstrap:  ${BOOTSTRAP_SIZE}b + fountain hdr ${BROADCAST_HEADER_SIZE - BOOTSTRAP_SIZE - 6}b + magic+ver 6b = ${BROADCAST_HEADER_SIZE}b/frame`;
}
