import "../style.css";
import {
  DEFAULT_GEOMETRY,
  PALETTE_2BIT,
  cellsToBytes,
  decodeFrameWarped,
  decodePacket,
  type SessionInfo,
} from "../protocol";

/**
 * M4 receiver: snap one frame from the live camera, run the M3 detect +
 * unwarp + decode pipeline, then validate the first wire packet and dump
 * its payload. Manual, one-frame-at-a-time. M6 brings continuous capture.
 */

const M4_SESSION: SessionInfo = { sessionId: 0xdeadbeef };

const startButton = document.querySelector<HTMLButtonElement>("#start-camera")!;
const captureButton = document.querySelector<HTMLButtonElement>("#capture-frame")!;
const video = document.querySelector<HTMLVideoElement>("#camera-video")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const output = document.querySelector<HTMLPreElement>("#decoded-output")!;
const previewCanvas = document.querySelector<HTMLCanvasElement>("#capture-preview")!;

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

  // Snapshot the current video frame.
  const offscreen = document.createElement("canvas");
  offscreen.width = w;
  offscreen.height = h;
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true })!;
  offCtx.drawImage(video, 0, 0);
  const imageData = offCtx.getImageData(0, 0, w, h);

  previewCanvas.width = w;
  previewCanvas.height = h;
  previewCanvas.getContext("2d")!.putImageData(imageData, 0, 0);

  const rawImage = { data: imageData.data, width: w, height: h };

  // Pixel-area bounds for fiducial markers. The expected size depends on
  // how the sender's canvas is framed in the camera view — for a typical
  // phone-camera-at-laptop or laptop-camera-at-phone setup, marker clusters
  // land between 50 and 20000 pixels. M5+ will tighten this.
  const detectionBounds = {
    minClusterPixels: 50,
    maxClusterPixels: 20000,
  };

  try {
    const cells = decodeFrameWarped(
      DEFAULT_GEOMETRY,
      PALETTE_2BIT,
      rawImage,
      8,
      detectionBounds,
    );
    const bytes = cellsToBytes(cells, PALETTE_2BIT);
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
    output.textContent =
      `✓ Packet accepted\n` +
      `Session 0x${packet.sessionId.toString(16)}, offset ${packet.payloadOffset}, payload ${packet.payload.length} bytes\n` +
      (looksLikePng ? `✓ Payload starts with the PNG magic (89 50 4E 47 …)\n` : `(payload does not start with a known magic)\n`) +
      `\nFirst 64 bytes of payload:\n${formatHex(packet.payload.slice(0, 64))}`;
    status.textContent = "captured";
  } catch (err) {
    output.textContent = `Capture failed: ${(err as Error).message}\n\nLikely cause: fiducial detection failed. Try aiming the camera so all four corners of the sender canvas are visible, fill more of the frame, hold steady.`;
    status.textContent = "capture failed";
  }
});

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
