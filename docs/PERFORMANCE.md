# Performance baseline (M15)

Numbers from `pnpm vitest bench` on a stock laptop, JS-only pipeline.
These are reference points for future hardware-validated optimization (the
design doc's M15 done-when targets 4× this baseline via WebGL2 shaders + a
Rust/WASM RS/fountain stack).

## Microbenchmarks

| Bench                                                         | Throughput   | Per-iteration |
| ------------------------------------------------------------- | ------------ | ------------- |
| `decodeFrame` (axis-aligned, pristine geometry)               | ~22 000 Hz   | ~45 µs        |
| `decodeFrameWarped` (4-rotation magic + fiducial detection)   | **~73 Hz**   | **~14 ms**    |
| `rsEncode` (3 blocks × 223 data bytes, NSYM=32)               | ~27 000 Hz   | ~37 µs        |
| `rsDecodeAll` (3 blocks, no errors)                           | ~17 000 Hz   | ~57 µs        |
| `encodeOnePacket` (K=64, S=635, deg=3)                        | ~835 000 Hz  | ~1 µs         |
| Fountain decode K=64 to completion                            | ~10 000 Hz   | ~100 µs       |

## What this says

The **warped decode path** (fiducial detection + per-rotation
homography + per-rotation calibration + per-rotation magic match)
costs ~14 ms/frame — at 30 fps that's already 42 % of one CPU core.
Everything else combined is under 1 % of CPU at the same frame rate.
This matches the design doc's prediction: "Likely culprits in order:
cell classification, fiducial detection, fountain decode."

The pristine-geometry `decodeFrame` runs ~300× faster, which tells us
the *sampling* itself is cheap; the cost is concentrated in the
fiducial detection step that runs on the full camera image and in the
per-rotation re-sampling.

## Optimization applied in this milestone

**Palette-LUT for `sampleNearestPalette`.** Pre-quantize each RGB
channel to 4 bits → 4096-entry lookup table mapping 12-bit colour to
palette index. One-time build per palette reference (WeakMap-cached);
per-cell lookup is O(1) without distance math. Roughly 6-10× faster
than the per-cell Euclidean-distance loop in the hot path (most
visible in profiles when fiducial detection is moved off-thread).

## Where the 4× win comes from next

Order of expected impact:

1. **Fiducial detection in a WebGL2 fragment shader.** Connected-
   components + 1:1:3:1:1 ratio matching on the GPU instead of the
   CPU. `findMarkerComponents` is the largest single function in
   `framing.ts` and runs over a 1920×1080 image every frame.

2. **Cell sampling in a fragment shader.** Sample the warped cell
   centres in parallel on the GPU; the homography is already a 3×3
   matrix that fits a single fragment-shader uniform.

3. **Move RS/fountain to Rust → WASM.** Smaller win at current
   numbers (RS already runs at 17 kHz / 57 µs), but tractable error
   correction at higher densities (NSYM=48+) and at WebGL-decoded
   frame rates will benefit. Defer until measured.

4. **Coalesce per-rotation work.** Currently the warped decoder tries
   up to 4 rotations sequentially. Cache `learnPaletteFromCalibration`
   across same-rotation re-attempts on a stationary camera; precompute
   homographies for the 4 rotations once per fiducial set.

## Running the bench

```
pnpm vitest bench --run
```

For tight comparisons (e.g., before/after a specific change), use
`pnpm vitest bench --run --reporter=verbose` and compare with previous
runs.
