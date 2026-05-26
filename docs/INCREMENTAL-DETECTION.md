# Incremental fiducial detection — design notes

PR-A (#32) added a cached-fiducials fast path: blindly reuse last-frame's
corners and verify with the magic check. When the camera is stable
(tripod, propped phone), that fast path hits every frame and the
warped decode runs ~150× faster than the cold path.

This document is the design for the **middle tier** that catches the
case PR-A misses: the camera moved a *little* between frames (hand
wobble at 30 fps ≈ 10-20 pixels typical), so the cached fiducials no
longer pass the magic check, but the real fiducials are still close to
where they were.

Without this tier, every hand wobble pessimizes to a full-frame detect
(~14 ms), even though the fiducials only shifted by tens of pixels.
With it, we search a ±W window around each cached corner — typically
~64×64 pixels each = 16 k pixels total vs the full 2 M pixels — and
fall through to full-frame only on a real tracking loss.

## When this matters

| Camera state                                | Hit by PR-A fast path? | Needs window search? | Falls back to full-frame? |
| ------------------------------------------- | ---------------------- | -------------------- | ------------------------- |
| Tripod, stationary                          | ✅ every frame         | —                    | —                         |
| Steady hand, sub-pixel drift                | ✅ most frames         | rare                 | rare                      |
| Steady hand, 5-20 px wobble                 | ❌                     | ✅ this PR           | rare                      |
| Reframing / camera moving across the screen | ❌                     | ❌                   | ✅ unavoidable            |
| First frame after `Start receiving`         | ❌ (cold state)        | ❌                   | ✅ unavoidable            |
| Total occlusion (hand passes over)          | ❌                     | ❌                   | ✅ (with retry)           |

So this middle tier converts the "small hand wobble" column from a
full-frame fallback to a cheap window scan.

## Algorithm sketch

```
WINDOW_RADIUS_PX = 50  # fixed; see "Decisions" below

detectFiducialsInWindows(img, cachedFiducials, cachedOtsu):
  # Reuse the cached full-image Otsu threshold from the last full
  # detect. We do NOT recompute Otsu per window: (a) it's wasteful on
  # 100×100 pixel patches, (b) any failed decode bounces us straight to
  # a full-image re-detect that refreshes the threshold for free, so
  # the cached value is at most one failed-decode-cycle stale.
  threshold = cachedOtsu

  for each corner in (tl, tr, br, bl):
    roiX = clamp(cachedFiducials[corner].x - WINDOW_RADIUS_PX, 0, img.width)
    roiY = clamp(cachedFiducials[corner].y - WINDOW_RADIUS_PX, 0, img.height)
    roiW = clamp(cachedFiducials[corner].x + WINDOW_RADIUS_PX, 0, img.width) - roiX
    roiH = clamp(cachedFiducials[corner].y + WINDOW_RADIUS_PX, 0, img.height) - roiY

    # Connected components ONLY within the ROI. The current
    # findComponents scans the whole image; we add a sibling version
    # that respects roi bounds.
    whites = findComponentsInROI(img, threshold, predicate=brighter, roi)
    darks  = findComponentsInROI(img, threshold, predicate=darker,  roi)

    # Same nested-bbox + area-ratio + 1:1:3:1:1 cross-section as
    # detectPDPs but restricted to this region.
    candidates = pairAndFilter(whites, darks)
    if !candidates: return null    # fall through to full-frame

    # Pick the candidate closest to the cached position — there
    # should usually be exactly one anyway.
    chosen[corner] = candidates.minBy(|c| distance(c.centroid, cachedFiducials[corner]))

  return chosen as FiducialCorners
```

`findComponentsInROI` is the only new primitive — restrict the
flood-fill / two-pass labeling to pixels inside `(roiX, roiY, roiX+roiW,
roiY+roiH)`. Everything else (ratio match, cross-section) already
exists and works on arbitrary pixel sets.

**Why fixed, not fiducial-relative.** Per-frame pixel motion is roughly
distance-independent in absolute pixels — rotational hand wobble at a
constant angular rate produces the same number of pixels of fiducial
movement regardless of how far the camera is from the screen. A
fiducial-relative window would shrink as the camera pulls back (when
fiducials get smaller on the image), which is exactly when the search
needs more headroom, not less. Going with a fixed window that's
comfortably larger than realistic jitter at any distance.

100×100 px windows over four corners = ~40 000 pixels of work per
frame. A FHD frame is 1920×1080 = ~2 M pixels, so this is roughly
50× cheaper than a full-frame pass — and the existing Otsu cost on
that full frame is what currently dominates the warped decode at
~14 ms / frame.

## State additions to `WarpedDecoderState`

To support the window search, the decoder state grows one field:

```ts
interface WarpedDecoderState {
  lastFiducials: [Point, Point, Point, Point] | null;
  lastRotation: number;
  lastOtsuThreshold: number;       // NEW — captured on every full detect
  // ... existing stats counters
}
```

Populated whenever `decodeFrameWarpedStateful` completes the slow path
successfully, alongside `lastFiducials` and `lastRotation`. The
threshold is shared across all four window scans on the next frame —
all four PDPs live on the same screen under the same lighting, so a
single threshold value is right.

## Decisions

1. **Window radius — fixed 50 px.** Per-frame pixel motion is dominated
   by rotational hand wobble, which is roughly constant in absolute
   pixels independent of camera distance. A fiducial-relative window
   would shrink at distance — exactly when fiducials are smaller, jitter
   relative to the fiducial is larger, and the search needs more
   headroom not less. 50 px covers any realistic per-frame motion and
   keeps the work at ~2 % of a FHD full-frame pass.

2. **Otsu threshold — cached, not recomputed per window.** Reuse
   `state.lastOtsuThreshold` from the last full detect. A failed decode
   bounces straight to a full-image re-detect that refreshes the
   threshold for free, so the cached value is at most one failed-decode
   stale. No per-window Otsu work — saves ~4 redundant histogram passes
   per frame.

## Open questions to discuss

1. **What if more than one PDP candidate lands in a window?** Currently
   `pickFourPDPs` solves the global ambiguity with the convex-quad
   constraint. Per-window we lose that. Suggested heuristic: pick the
   candidate whose centroid is closest to the cached position. Risk:
   under fast motion, this latches onto the wrong PDP. Mitigation: if
   the chosen quadrilateral fails convexity, abandon the window search
   and fall through to full-frame.

2. **State eviction / Otsu refresh.** With cached Otsu we accept that the
   threshold can lag behind a slowly changing lighting condition. The
   refresh path is "any decode failure → full re-detect → fresh Otsu",
   which works for sudden changes (room light flips). A slow drift
   (cloud moves over a window over 30 s) is harder — the cached Otsu
   keeps decoding "well enough" but progressively worse. Worth adding a
   keep-alive: after N consecutive fast-path-or-window hits, force a
   full-image detect anyway. N = 30 (one second at 30 fps) is a
   reasonable starting point. Tunable from real-stream data once the
   hit-rate diagnostic in PR #32 is exercised.

## Skeleton

This branch adds:

- `docs/INCREMENTAL-DETECTION.md` (this file)
- `detectFiducialsInWindows()` stub in `framing.ts` that throws
  `"not implemented — see docs/INCREMENTAL-DETECTION.md"`
- Wired call in `decodeFrameWarpedStateful` guarded by
  `state.useWindowFallback = false` (default off — flips to true when
  the implementation lands and tests confirm it)
- A pending test that documents the intended contract

## Implementation sequencing

1. PR #32 merged — cached-fiducials fast path lives.
2. Extend `WarpedDecoderState` with `lastOtsuThreshold`. Capture from
   the slow-path `detectFiducials` on success.
3. Add `findComponentsInROI(img, predicate, roi)` (~50 lines, parallel to
   existing `findComponents`).
4. Add `detectFiducialsInWindows(img, cached, cachedOtsu)` (fixed 50 px
   window radius) using `findComponentsInROI` + the existing
   `verifyCrossSection`.
5. Wire it as the middle tier in `decodeFrameWarpedStateful`:
     fast path (cached fiducials, cached rotation, magic check)
       → window search (this PR)
       → full detect (current fallback)
6. Tests: synthetic camera wobble — rotate + translate a known frame by
   N pixels, decode, assert window-search picks up the new fiducials at
   N up to `~1 × fiducial size`. Also test that a translation larger
   than the window correctly falls through to full-detect.
7. Surface a new cachePath label in the diagnostic output:
   `"window-hit"` — so the PR #32 hit-rate UI on `/receive.html` can
   distinguish blind-reuse hits from window-search hits, and the keep-
   alive cadence (open question 2) can be calibrated from real data.
