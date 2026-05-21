/// <reference lib="webworker" />

/**
 * Decoder worker.
 *
 * Lives off the main thread so the camera preview stays buttery while the
 * pipeline crunches frames. Phases that will land here:
 *   1. Grab VideoFrame (via MediaStreamTrackProcessor when available) or an
 *      ImageBitmap drawn from the <video> element.
 *   2. Detect corner fiducials.
 *   3. Compute perspective transform; resample to a canonical grid.
 *   4. Classify each cell's colour against the calibration strip.
 *   5. Hand the cell array off to the codec + ECC layers.
 */

self.addEventListener("message", (event: MessageEvent) => {
  // Placeholder echo until the pipeline is wired up.
  (self as DedicatedWorkerGlobalScope).postMessage({
    kind: "echo",
    received: event.data,
  });
});

export {};
