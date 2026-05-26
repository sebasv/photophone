# Fiducial detection — M3.5 design

The robustness story for the corner-marker detector. Originally lived inline in DESIGN.md §8 M3.5; moved here to keep the main design doc readable. Pair with [INCREMENTAL-DETECTION.md](./INCREMENTAL-DETECTION.md), which layers cached-fiducial / window-search fast paths on top of the cold-path detector designed here.

## Motivation — three failures discovered during M4 manual testing

1. **Lighting brittleness.** The detector used `r > 200 && g > 200 && b > 200`. That threshold was tuned for an indoor scene where the camera's auto-exposure metered against a dark room. Outside in daylight the camera meters against bright surroundings, gain drops, and the actual fiducial pixels come back at maybe `(180, 180, 195)` — silently failing the threshold even though nothing about the fiducial itself changed.

2. **False positives from arbitrary bright shapes.** Any blob over the threshold that survives the size filter is a candidate. White letters on the sender page (`#f5f5f5` until the PR #8 fix), a laptop bezel under outdoor light, paper in the frame — all can pass. When such a blob sits closer to an image corner than a real fiducial, it wins the corner-assignment heuristic and the homography lands sampling off-frame.

3. **Orientation.** `detectFiducials` assigned blobs to corners by Manhattan distance to *image* corners, which is rotation-blind: rotate the camera 180° and the receiver labels what was the sender's TL as BR, so cells decode back-to-front.

**Why not "just add a quiet zone" around each fiducial?** Letters on a dark page already have black around them; surrounding margin is visually identical to a fiducial's outer ring. Whitespace separates content from noise but doesn't *characterise* fiducial-ness. The fix has to constrain the marker's shape, not its surroundings.

## Approach — pivot to QR-style detection

### 1. Otsu's adaptive thresholding

Replace the constant `>200` with a per-frame threshold derived from the image's brightness histogram. Otsu picks the threshold that maximises the between-class variance of "dark vs. bright" pixels — i.e., the value that best separates foreground from background in *this specific* frame. No magic constants survive across lighting conditions.

- Compute a 256-bin luminance histogram of the camera frame
- Walk the threshold from 1..254, keep the value that maximises `w_dark · w_bright · (μ_bright − μ_dark)²`
- Use that threshold (and a tolerance band) as the marker-pixel test

Independent of fiducial shape. Solves the outdoor/indoor problem. ~80 lines, no dependencies, well-documented algorithm.

### 2. 7×7 Position Detection Patterns (PDPs) at all four corners

Replace the 4×4 "outer ring + 2×2 inner marker" fiducial with a 7×7 nested-ring pattern that mirrors QR codes' finder pattern:

```
■ ■ ■ ■ ■ ■ ■
■ □ □ □ □ □ ■
■ □ ■ ■ ■ □ ■
■ □ ■ ■ ■ □ ■
■ □ ■ ■ ■ □ ■
■ □ □ □ □ □ ■
■ ■ ■ ■ ■ ■ ■
```

The signature property: any horizontal or vertical line through the centre crosses five bands in **1:1:3:1:1** width ratio (`black:white:black:white:black`). The detector scans rows then columns looking for run-length sequences matching that ratio within a width tolerance; two independent confirmations (one row, one column) per pattern, four patterns per frame.

Why this is dramatically more robust than the original 4×4 detector:

- **The ratio is overwhelmingly improbable in nature.** A bezel, a letter, a reflection — none have a sharp dark ring around a bright ring around a dark centre with the right proportions. Bezels would have width ratios like `1:0.5:100:0.5:1` (the bright screen content fills most of the line) and fail.
- **No separate "anti-bezel" or "anti-letter" checks needed.** The ratio test alone subsumes them.
- **Decades of empirical hardening.** Every corner case has already been found and fixed in published implementations.

**Cost:** 7×7 = 49 cells per fiducial × 4 corners = 196 cells, up from 64 today. Net payload impact: **−132 cells = −3.4%**. Acceptable; the robustness payoff justifies it.

### 3. Orientation via magic validation in all four rotations

All four PDPs render identically; orientation is recovered *after* detection. For each of the four rotational assignments of the detected PDP centroids to the canonical TL/TR/BR/BL slots, compute the homography, sample the first 16 payload cells (= 4 bytes), and accept the rotation whose magic decodes to `"PHOT"` (`0x50 0x48 0x4F 0x54`).

Properties:

- **Zero rendered-frame asymmetry.** All four PDPs are pixel-identical; the orientation signal lives in the already-required packet header, not in the fiducial pattern.
- **False-positive probability ≈ 2⁻³² per non-matching rotation.** Three non-matching rotations × 2⁻³² ≈ 1 in 1.4 billion that a wrong rotation accidentally decodes to the magic. Effectively never happens.
- **Cost is negligible:** 4 × (8×8 linear solve + 16-cell sample + 4-byte assembly). Microseconds.
- **Loose coupling.** No dependence on render-layout asymmetry, satellite markers, or fiducial-pattern variants. Changes to the palette, frame size, or fiducial geometry all leave the orientation logic untouched.

The detector's output carries an `orientation: 0 | 1 | 2 | 3` field so M4.5's diagnostics overlay can surface which rotation was accepted and which magic bytes the other three rotations produced.

Rejected alternatives:

- **Satellite marker beside the TL fiducial.** Adds a new render artefact, a separate detector path, and its own false-positive surface. Weaker math than the magic's 32 bits of entropy.
- **QR-style asymmetric TL fiducial (3+1).** Forces two PDP detector paths and necessarily weakens the TL pattern's ratio match by deviating from 1:1:3:1:1.
- **CRC32 in the bootstrap region instead of the magic.** Equivalent entropy (32 bits) but depends on M9's bootstrap parser; the magic check already exists in the decode pipeline.

### 4. Geometry plausibility sanity check (optional, low effort)

After detection, verify the four chosen PDP centroids form a roughly-convex quadrilateral with reasonable aspect ratio (say 0.5–2.0) and reasonable image-area fraction (e.g. 5%–80%). Cheap to add (~30 lines) and catches the residual edge cases where four valid PDP-passing patches are arranged implausibly. Skip if the PDP detector alone proves robust enough in practice.

## Deferred refinements

Two detector ideas considered but not shipped in M3.5. Logged here with a "pick up when…" trigger so the deferral is explicit and the reasoning is preserved for whoever revisits this section.

### a. Staggered topology / outer-band area ratio

**Idea.** Extend the area-ratio check to a third layer. Currently we verify `D_inner ⊂ W_ring` with `W/D ≈ 16/9`. The natural extension is to verify an *outer dark band* immediately around `W_ring` with thickness ≈ 1/3 of the centre. Done as area ratios it is **projectively invariant** — strictly more perspective-robust than the 1:1:3:1:1 cross-section we landed in §3 above.

**Why deferred.** The cross-section verifier is already cheap (~30 ops worst case per candidate) and effective on the failure modes M4.5 surfaced. The staggered outer-band check needs morphological dilation around each candidate's `W_ring` to isolate the immediate annulus from the page-background connected component — another full pixel pass per candidate. For typical handheld camera angles, the cross-section's perspective sensitivity is well within tolerance.

**Pick up when:**
- Manual testing reveals false-positive leaks under extreme perspective (camera approaching screen-edge-on), where cross-section starts failing under heavy band-width distortion.
- Or: a structural false positive emerges in the wild that passes both flood-fill containment *and* cross-section verification.

### b. Locality-restructured detector (one flood-fill instead of two)

**Idea.** Currently `detectPDPs` runs `findComponents` twice — once for whites, once for darks. Restructure to: flood-fill *only* dark components, then per-candidate localised expansion to find each candidate's surrounding white ring (sampling pixels in the annulus just outside the dark's bbox, rather than committing the whole image's white pixels to a connected-components pass).

**Why deferred.** Detection is currently well under budget (<5ms total on a 1080p frame; the connected-components passes are ~2ms each). This refactor would save ~2ms — a real number, but optimisation isn't a problem yet. The current structure is also more obviously correct under inspection; locality changes invite bugs.

**Pick up when:**
- Profiling shows detection in the hot loop dominating frame time (>15ms on real hardware).
- Or: M6 (continuous capture) demands a frame budget the current detector can't meet.

## Done when (M3.5 acceptance)

- A single PNG decodes correctly under all of: dim indoor light, outdoor daylight, mixed lighting, and the camera held at any of the four cardinal orientations.
- A wider camera view that includes the laptop bezel still decodes correctly — the bezel does not win corner assignment.
- No manual covering of sender-page UI required.
- Synthetic-warp tests still pass (rotated inputs to `decodeFrameWarped`).
