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
detectFiducialsInWindows(img, expected, windowRadius):
  for each corner in (tl, tr, br, bl):
    roiX = clamp(expected[corner].x - windowRadius, 0, img.width)
    roiY = clamp(expected[corner].y - windowRadius, 0, img.height)
    roiW = clamp(expected[corner].x + windowRadius, 0, img.width) - roiX
    roiH = clamp(expected[corner].y + windowRadius, 0, img.height) - roiY

    # Local Otsu on just this ROI — keeps threshold robust under
    # uneven lighting across the screen.
    threshold = otsuThreshold(img, roi)

    # Connected components ONLY within the ROI. The current
    # findComponents scans the whole image; we'd add a version that
    # respects roi bounds.
    whites = findComponentsInROI(img, threshold, predicate=brighter, roi)
    darks  = findComponentsInROI(img, threshold, predicate=darker,  roi)

    # Same nested-bbox + area-ratio + 1:1:3:1:1 cross-section as
    # detectPDPs but restricted to this region.
    candidates = pairAndFilter(whites, darks)
    if !candidates: return null    # fall through to full-frame

    # Pick the candidate closest to the expected position — there
    # should usually be exactly one anyway.
    chosen[corner] = candidates.minBy(|c| distance(c.centroid, expected[corner]))

  return chosen as FiducialCorners
```

`findComponentsInROI` is the only new primitive — restrict the
flood-fill / two-pass labeling to pixels inside `(roiX, roiY, roiX+roiW,
roiY+roiH)`. Everything else (Otsu, ratio match, cross-section) already
exists and works on arbitrary pixel sets.

## Open questions to discuss

1. **What window radius?** 32 pixels at 30 fps ≈ 960 px/s — easily faster
   than human hand wobble. But on small screens the fiducials are
   themselves only ~30-50 px wide; W=32 might land the search window
   inside a single fiducial. Probably want adaptive: `W = max(32, 2 ×
   max_fiducial_dimension)`.

2. **Per-window or per-image Otsu?** Per-window is more robust to
   uneven backlight but more expensive. The current `otsuThreshold` is
   already cheap (~1 ms full-image); a 64×64 window is ~500× smaller.

3. **What if more than one PDP candidate lands in a window?** Currently
   `pickFourPDPs` solves the global ambiguity with the convex-quad
   constraint. Per-window we lose that. Suggested heuristic: pick the
   candidate whose centroid is closest to the cached position. Risk:
   under fast motion, this latches onto the wrong PDP. Mitigation: if
   the chosen quadrilateral fails convexity, abandon the window search
   and fall through to full-frame.

4. **State eviction.** After N consecutive fast-path-or-window hits,
   force a full-image detect anyway as a keep-alive against gradual
   drift. N = 30 (one second at 30 fps) is a reasonable starting point.

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

1. Land PR-A (#32) — done in this branch tree
2. Add `findComponentsInROI` (~50 lines, parallel to existing
   `findComponents`)
3. Add `detectFiducialsInWindows` using `findComponentsInROI` + the
   existing `verifyCrossSection`
4. Tests: synthetic camera wobble (rotate + translate a known frame by
   N pixels, decode, assert window-search picks up the new fiducials)
5. Flip `useWindowFallback` default to true once the wobble test
   passes at a 20-pixel offset
