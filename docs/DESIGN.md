# Photophone — design

> Living document. Decisions here are starting points, not commitments — we'll revise as milestones land.

## 1. Goal

Transfer arbitrary byte payloads of arbitrary size between two (or more) browsers using **only a screen and a camera** as the physical channel. No Wi-Fi, no Bluetooth, no cables.

Photophone has two transport modes that share the same lower stack:

- **Unicast** — one sender, one receiver, both have a screen and a camera. A TCP-style reliability layer with selective ACK/NACK and link adaptation runs over the optical link.
- **Broadcast** — one sender, many receivers, only the sender has a camera-pointed-at-screen role. The sender never gets feedback, so reliability comes entirely from forward error correction (fountain coding). Think: projector at a meetup beaming slides to the audience's phones.

### Non-goals

- **Security / encryption** — Photophone is a transport. Anything sensitive should be encrypted by the app above it. The link is line-of-sight, but it's still optically visible — anyone with a camera in the room can sniff.
- **Hiding the link** — frames are intentionally visible and noisy-looking. We're not steganography.
- **High bandwidth** — the headline number we care about for v1 is "can we move ~30 KB in a reasonable time," not Mbps.
- **Backward compatibility with QR** — QR is a tile in our prior art, not a constraint.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Cell** | One coloured square on the sender's screen. The smallest unit of optical bandwidth. |
| **Palette** | The set of colours a cell may take. N colours → log2(N) bits per cell. |
| **Fiducial** | A high-contrast corner marker, used by the receiver to locate the frame in the camera image and compute a perspective transform. |
| **Calibration strip** | A row of known colours included in every frame, used to train the receiver's colour classifier against the current lighting / white-balance. |
| **Frame** | One full screen-render: fiducials + calibration strip + config indicator + payload grid. |
| **Source packet** | One unit of the original payload split into a fixed-size chunk with a header. |
| **Encoded packet** | What the sender actually puts on screen. In unicast mode an encoded packet *is* a source packet. In broadcast mode an encoded packet is a fountain-coded combination of source packets. |
| **Block** | A group of `dataShards + parityShards` packets that the inner ECC can reconstruct from any `dataShards` of them. (Reed-Solomon, per-frame.) |
| **Channel** | One direction of the optical link. The protocol uses up to two channels: `sender → receiver` carries data, `receiver → sender` (when present) carries ACK/NACK and adaptation feedback. |
| **Config indicator** | A small fixed-position region in every frame, decoded with worst-case parameters, that tells the receiver how to interpret the rest of the frame (mode, palette size, grid dims, ECC strength). |
| **Bootstrap metadata** | Session-scoped info a receiver needs to make sense of the stream: session ID, total source packet count, payload size, filename, mime, sha256. Repeated regularly so late joiners can sync. |

## 3. Architecture — the stack

Photophone is layered, OSI-style. Each layer has a narrow contract with the layer above and below, so we can iterate on one without disturbing the others.

```
┌─────────────────────────────────────────────────────┐
│ Application   file picker → bytes → file save       │
├─────────────────────────────────────────────────────┤
│ Session       handshake, bootstrap metadata, EOF    │
├─────────────────────────────────────────────────────┤
│ Transport     unicast-arq │ broadcast-fec           │
├─────────────────────────────────────────────────────┤
│ Coding        Reed-Solomon (inner), Fountain (outer)│
├─────────────────────────────────────────────────────┤
│ Framing       cells ↔ frame image (palette, layout) │
├─────────────────────────────────────────────────────┤
│ Physical      screen pixels ↔ camera pixels         │
└─────────────────────────────────────────────────────┘
```

Code mirrors this: `src/protocol/{framing,codec,ecc,transport}.ts`, plus future `session.ts`.

**Transport bifurcates** at runtime based on mode:

- `unicast-arq` — sequenced source packets, retransmits driven by the back-channel.
- `broadcast-fec` — fountain-encoded packets, no back-channel, receivers reconstruct from any sufficient subset.

Both modes share the framing, coding, and physical layers underneath. The `transport.ts` interface accepts both modes so we can implement them in different milestones without rewriting everything above.

**The back-channel is a shared resource.** When the receiver→sender visual channel is available (unicast only), three features ride on it: bidirectional ARQ, handshake-time link negotiation, and continuous link adaptation. Designing them together avoids three bespoke return-path schemes.

## 4. Frame format (v1 starting point)

Concrete starting numbers. Geometry is a tunable knob — these are what we'll prototype against.

- **Grid:** 64 × 64 cells
- **Cell size on screen:** 12 px (so a frame is 768 × 768 px, leaving margin on a 1080p screen)
- **Fiducials:** 4 × 4 cells in each corner — 4 × (4 × 4) = 64 cells
- **Config indicator:** 1 × 16 cells next to the top-left fiducial, decoded with worst-case parameters (largest cells, 2-colour palette, no inner ECC). Encodes: `mode` (unicast/broadcast), `palette_size`, `grid_w`, `grid_h`, `ecc_profile`, frame type (payload / bootstrap). 16 cells × 1 bit/cell = 16 bits. Heavy redundancy because nothing else decodes if this doesn't.
- **Calibration strip:** 2 × 64 cells across the top under the fiducial row — 128 cells
- **Payload cells:** 4096 − 64 − 16 − 128 = **3888 cells**
- **Palette:** 4 colours (black, red, green, blue) → 2 bits/cell → **972 bytes/frame raw**

After ECC (8/4 Reed-Solomon = ~67% data efficiency), a 16-byte packet header, and a 24-byte bootstrap region (see §4.1): roughly **609 bytes of application payload per frame** in unicast mode, and ~600 in broadcast mode (the fountain header adds a few bytes).

### 4.1 Bootstrap metadata (broadcast & late-join)

A small fixed region in **every frame** carries session bootstrap info so a receiver tuning in at any moment can sync. Embedding in every frame (rather than dedicated bootstrap frames every N) gives zero join latency at the cost of ~3% per-frame payload tax — a good trade for a primitive that's load-bearing for broadcast.

**Frequent bootstrap region — 24 bytes per frame:**

| Bytes | Field | Notes |
| --- | --- | --- |
| 4 | `session_id` | u32, random per transfer, prevents crosstalk |
| 2 | `source_count` (K) | u16, total source packets in this session |
| 4 | `payload_size` | u32, total bytes of the original payload |
| 4 | `filename_hash` | first 4 bytes of sha256(filename) — for identification |
| 1 | `mime_index` | small enum: 0=`application/octet-stream`, 1=`image/png`, … |
| 1 | `extended_slot` | which extended-metadata slot is in this frame (0–3) |
| 4 | `extended_data` | content of the slot, see below |
| 4 | `bootstrap_crc32` | CRC32 over the preceding 20 bytes |

**Extended metadata** — 4 bytes per frame, rotating through 4 slots:

- Slot 0–7: full **sha256** of payload (32 bytes / 4 = 8 frame slots)
- Slot 8–23: **filename** (UTF-8, up to 64 bytes / 4 = 16 frame slots)

So a receiver assembles the full sha256 from 8 distinct frames and the filename from 16. At 10 fps that's 2.4 s worst-case to learn the full session identity. Until then it can already accumulate fountain packets — it just can't *verify* or *save* the result until extended metadata completes. The truncated `filename_hash` distinguishes simultaneously broadcast files.

### Sending `hello_world.png` (26,802 bytes)

```
26,802 bytes ÷ 633 bytes/packet ≈ 43 packets
At 10 fps render rate: ~4.3 s for one clean pass through the payload
```

These numbers are pessimistic — we'll push them up as the pipeline stabilizes.

### ASCII frame sketch

```
┌──┬CC┬──────────────────────────────┬──┐
│FF│CC│  calibration strip (known)   │FF│
│FF│  │                              │FF│
├──┴──┴──────────────────────────────┴──┤
│                                       │
│                                       │
│           payload grid                │
│        (cells of palette N)           │
│                                       │
│                                       │
├──┬─────────────────────────────────┬──┤
│FF│                                 │FF│
│FF│                                 │FF│
└──┴─────────────────────────────────┴──┘
   FF = corner fiducial (4×4 cells)
   CC = config indicator (1×16 cells, worst-case decode)
```

## 5. Packet format (v1)

Fixed-width header so the receiver can frame even with partial cell corruption.

| Offset | Bytes | Field | Notes |
| --- | --- | --- | --- |
| 0 | 4 | magic | `0x50 0x48 0x4F 0x54` ("PHOT") — sync + version guard |
| 4 | 2 | version | major.minor, both u8 |
| 6 | 4 | session_id | random per transfer, lets the receiver reject crosstalk |
| 10 | 2 | seq | u16, packet sequence number |
| 12 | 2 | total | u16, total packet count (0 = unknown / streaming) |
| 14 | 2 | payload_len | u16, bytes of payload that follow |
| 16 | N | payload | application bytes |

Total header: 16 bytes. Payload is whatever fits in the rest of the post-ECC frame after the bootstrap region.

### 5.1 Encoded packet header (broadcast / fountain mode)

When the transport mode is `broadcast-fec`, the sender doesn't emit source packets directly — it emits **encoded packets**, each a XOR combination of some source packets. These need an additional 4-byte prefix describing the combination:

| Bytes | Field | Notes |
| --- | --- | --- |
| 1 | `degree` (d) | u8, how many source packets are XOR'd into this one |
| 1 | `seed_hi` | u8, high byte of a 16-bit PRNG seed |
| 1 | `seed_lo` | u8, low byte of the PRNG seed |
| 1 | `reserved` | future use |

The receiver re-derives the d source indices by seeding the same PRNG and drawing d values mod K. This avoids transmitting an explicit list of indices, which would otherwise cost `⌈log2(K)⌉ × d` bits per packet — significant at large K.

The PRNG is **xorshift32** initialized from `seed`. K is known from the bootstrap region.

### 5.2 Source packet header (unicast mode)

Unchanged from §5 above. In unicast mode the packet that lands on screen *is* the source packet.

## 6. Reliability model

Two stacked tools, used differently per mode.

### Inner ECC: Reed-Solomon per packet

Each source packet's payload is encoded with Reed-Solomon over GF(256). This survives a bounded number of cell-classification errors *within a single frame* without retransmission. Cheap, well-understood, and the encode/decode is fast in TypeScript.

### Outer code: Fountain (LT or Raptor)

Layered on top of source packets. The sender doesn't transmit source packets directly — it transmits an unbounded stream of **encoded packets**, each one a random XOR combination of source packets. A receiver who collects any K′ ≥ K encoded packets can reconstruct all K source packets via Gaussian elimination (or, faster, belief-propagation peeling).

Properties that matter for Photophone:
- **Rateless** — the sender keeps generating fresh combinations forever; there is no "I sent everything, now what". This is exactly what broadcast needs.
- **Erasure-tolerant** — losing specific packets doesn't matter; only the *count* of distinct received combinations matters.
- **Late-join friendly** — a receiver tuning in halfway through still benefits from every subsequent encoded packet.

### Mode behaviours

**Unicast (`unicast-arq`)**
- Sender cycles through source packets in order (or fountain-encoded if we want both).
- Receiver renders a small ACK frame on its own screen: session ID + either `upTo seq N` or `missing: [seq, seq, …]`.
- Sender's camera reads the ACK channel; sender stops re-sending acked packets and prioritizes nacked ones.
- This is selective-ACK TCP with the wire replaced by photons.

**Broadcast (`broadcast-fec`)**
- Sender continuously generates fountain-encoded packets. No back-channel.
- Bootstrap metadata is repeated regularly so late joiners can sync (see §4).
- Each receiver independently accumulates encoded packets until it has enough to decode.
- Sender keeps looping until manually stopped — extra encoded packets are just extra redundancy for receivers with worse channel conditions.

## 7. Open questions

### Decided

- ✅ **Bootstrap cadence:** embed in every frame (§4.1). 24 frequent bytes + 4 rotating extended bytes = 28-byte tax per frame, ~3% overhead, zero join latency.
- ✅ **Broadcast loop policy:** loop forever until manually stopped. Each extra encoded packet is free redundancy for receivers with worse channel conditions.
- ✅ **Fountain header layout:** seeded PRNG (§5.1) rather than explicit index lists. 4 bytes per encoded packet regardless of K.

### Still open

- **Frame rate vs decode rate.** Most laptop screens refresh at 60 Hz; phone cameras capture at 30 fps with rolling shutter. We probably want sender ≤ camera fps, with a guard band. Empirical.
- **Palette size.** 2 bits/cell is conservative. 3 bits (8 colours) and 4 bits (16) are tempting but degrade under bad lighting. Decide per-deployment via the handshake (unicast) or use a conservative default (broadcast).
- **Fountain code degree distribution.** LT codes need a well-chosen degree distribution (Robust Soliton is the textbook answer). Raptor codes wrap that with a pre-code for cleaner decode. Try both, measure.
- **PWA install flow on two devices.** Pairing UX is real for unicast — we need a way for the two devices to know they're each other's counterpart. For broadcast it's simpler: receivers just point and look. A QR code with the session ID, displayed once at the start, is the easy unicast answer.
- **Multiple senders, one receiver?** Probably out of scope, but interesting. The `session_id` guard already prevents crosstalk.

## 8. Milestones

Each milestone has a **done-when** test. We can't claim it without that.

A note on ordering: the forward-only unicast pipeline (M1–M8) is *almost* broadcast-compatible by construction. Adding fountain coding (M9) and bootstrap-frame UX (M10) gives us the broadcast product. The back-channel work (M11–M14) comes after, and makes unicast *good* rather than just *exist*.

### M0 — Scaffold ✅
- TypeScript + Vite + PWA, three pages, protocol stubs, MIT-licensed.
- **Done when:** `pnpm build` is green.

### M1 — Single-frame pristine loopback
- Implement `codec.bytesToCells` and `codec.cellsToBytes` for the 4-colour palette.
- Implement a minimal `renderFrame(cells) → ImageData` and `decodeFrame(ImageData) → cells`. No fiducials, no perspective, no ECC.
- Include the **config-indicator** region in the frame format from the start, even though its contents are static at this stage. Hard to retrofit later, trivial to add now.
- **Done when:** a unit test round-trips a random 800-byte buffer through `encode → render → decode → decode-cells` and gets the same bytes back, byte-perfect.

### M2 — Multi-frame pristine loopback
- Implement `transport.packetize` and `transport.reassemble`, including the packet header.
- Send a multi-packet payload end-to-end in memory (no rendering yet).
- **Done when:** a unit test packetizes `hello_world.png`, shuffles the packet order, drops a few, reorders them, and reassembles correctly *when* enough packets are present; cleanly reports missing seq numbers otherwise.

### M3 — Fiducials & perspective unwarp
- Render fiducial markers; implement detection and a homography solve to remap a skewed/rotated frame to canonical cell coordinates.
- Decode the config indicator first (worst-case parameters), then the rest of the frame.
- **Done when:** the receiver decodes a frame that's been programmatically rotated, scaled, and perspective-warped (still synthetic, no camera) without errors.

### M4 — First camera capture
- Receiver page: snap a still frame from `getUserMedia`, decode it.
- **Done when:** a user can point their laptop camera at a phone displaying a Photophone frame, hit "capture", and see the decoded bytes. Holds still, one frame at a time.

### M5 — Colour calibration strip
- Sender embeds the palette in the calibration strip every frame.
- Receiver fits a per-frame colour classifier (nearest-neighbour in some colour space) from the calibration cells before classifying payload cells.
- **Done when:** M4 still works under three lighting conditions (warm room, cool room, mixed).

### M6 — Continuous capture
- Move the decode pipeline into the worker. Process frames at camera rate.
- Implement seq-based deduplication so a frame seen multiple times doesn't count multiple times.
- **Done when:** the receiver streams from the camera and reassembles a multi-packet payload from a continuously-rendered sender, without manual capture clicks.

### M7 — Reed-Solomon ECC
- Wire `ecc.encode` / `ecc.decode` (start with `reed-solomon-erasure` or an inline TS implementation; move to Rust/WASM only if measured-slow).
- **Done when:** transmission still succeeds when the sender is positioned at an awkward angle / partially shadowed, where ~10% of cells classify incorrectly per frame.

### M8 — First end-to-end unicast PNG transfer 🎯
- Bring it together: sender picks `hello_world.png`, receiver saves the decoded bytes as a file, opens it, it renders identical to the original. Forward-only, no back-channel yet.
- **Done when:** sha256 of the received bytes equals sha256 of the sent bytes, for `hello_world.png`.

### M9 — Fountain coding (outer code)
- Replace "cycle through source packets in order" with "emit an unbounded stream of LT-coded encoded packets". Each encoded packet carries a small degree-list header so the decoder knows which sources it combines.
- Decoder collects encoded packets and reconstructs once it has enough (Gaussian elimination is fine for the packet counts we're dealing with; switch to belief-propagation peeling if it becomes a bottleneck).
- **Done when:** kill the receiver mid-transfer at the 50% mark, restart it from scratch; with the sender still running, it reconstructs the full payload from the encoded packets it sees after restart.

### M10 — Broadcast mode 🎯
- Embed bootstrap metadata (session ID, source count, payload size, filename, mime, sha256) in every frame.
- Sender uses conservative defaults (larger cells, smallest palette, slow fps) because there's no negotiation.
- New sender UI mode: "broadcast" — picks a file, shows a session info banner, loops fountain-encoded frames indefinitely.
- Receivers can tune in at any time, no pairing.
- **Done when:** open two receiver windows that start at different times during a single broadcast of `hello_world.png`; both reconstruct the file successfully without coordinating.

### M11 — Receiver→sender back-channel (visual ACK channel)
- Receiver page can render a small dedicated channel frame (lower fps, larger cells acceptable) on its own screen.
- Sender page can open its own camera, find this channel, and decode it.
- This is shared infrastructure for M12, M13, M14 — get it solid before layering features.
- **Done when:** a manually-crafted "hello back" message displayed by the receiver is decoded by the sender's camera within 2 seconds.

### M12 — Handshake-time link negotiation (static adaptation)
- Receiver displays a one-shot capabilities frame on its own screen: max resolvable cell size, preferred grid dimensions, sustainable fps, comfortable palette size.
- Sender reads it once, picks transmission parameters, configures the encoder. Parameters stay static for the duration.
- **Done when:** point the receiver at the sender from 30 cm and from 2 m — the sender visibly picks different cell sizes for each, and the transfer completes in both cases.

### M13 — Bidirectional ARQ
- Receiver renders ACK/NACK frames continuously over the back-channel.
- Sender drops acked source packets from its fountain encoding pool (or, in non-fountain mode, from its rotation) and prioritizes nacked ones.
- **Done when:** payload completes faster than the M9 broadcast baseline for the same input, and recovers cleanly when we deliberately obstruct the channel mid-transfer.

### M14 — Continuous link adaptation (dynamic)
- Receiver continuously reports decode-quality stats (cell-classification confidence, observed FER) over the back-channel.
- Sender runs a control loop: bump rate/density when error rate is low, back off when high.
- The config indicator at the top of each frame tells the receiver which decoder parameters to apply, so changes mid-stream don't break anything.
- **Done when:** start a transfer with the camera close; slowly walk it away mid-transfer until just before the edge of usability; the sender visibly reduces density to keep decoding working, and the transfer completes.

### M15 — Performance pass
- Profile. Likely culprits in order: cell classification, fiducial detection, fountain decode.
- Move the per-pixel kernel to WebGL2 fragment shaders.
- Move fountain/RS decode to Rust → WASM if it shows up in the profile.
- **Done when:** end-to-end throughput on a stock laptop+phone setup is at least 4× M8's baseline.

## 9. Test corpus

- **`hello_world.png`** (26,802 bytes, 3840×2160, 8-bit palette PNG) — the canonical end-to-end target. If it ever gets unwieldy for early milestones, we can downscale to e.g. 480×270 (smaller PNG bytes) without losing the "transmits a real PNG" property.
- Synthetic random buffers (8 B, 800 B, 8 KB, 80 KB) — for unit tests, to keep the inner-loop fast.

## 9.1 Rendering & colour conventions

- **sRGB throughout.** The screen renders in sRGB; the camera reports sRGB-ish (post-ISP). We classify cells in sRGB space initially. If lighting issues bite, we'll switch to LAB or HSV — but only after measuring.
- **No anti-aliasing on cell edges.** Cells are rendered as exact rectangular fills on integer pixel boundaries; antialiased edges would smear classification at the cell boundaries the camera sees.
- **No subpixel positioning.** Frame top-left snaps to integer pixels; cell pitch is an integer number of pixels.
- **Cell sampling on receive.** After perspective unwarp the receiver samples a small NxN patch in the *centre* of each cell (e.g., the central 50% of the cell area) and averages, to avoid edge contamination.
- **Palette colours** are picked to be maximally separated in the camera's likely operating space. Black + primary RGB is the cheap-and-cheerful 4-colour starting point; larger palettes will need empirical placement.

## 10. Out of scope (forever or until requested)

- Native mobile apps. Browser-only.
- Audio side-channels. Photons only.
- Network-assisted fallback. The whole point is *not* using the network.
- Encryption / authentication of the optical link. Application layer's problem.

## 11. Development workflow

- **Tooling:** `mise` pins node + pnpm. `mise install` to set up.
- **Commands:**
  - `pnpm dev` — Vite dev server, both sender and receiver pages.
  - `pnpm test` — Vitest, watch mode by default.
  - `pnpm test --run` — single test run.
  - `pnpm typecheck` — `tsc --noEmit`.
  - `pnpm build` — typecheck + production bundle.
- **Branches:** one feature branch per milestone, `feature/m<N>-<slug>`. Stack PRs with each milestone's base set to the previous milestone's branch; bottom of the stack targets `main`.
- **PR template:** include the milestone's done-when criterion verbatim and link to the test that proves it.
- **CI:** GitHub Actions runs typecheck + tests on every PR.

## 11.1 Diagnostics & dev overlays

Photophone's failure modes are largely visual — fiducials missed, cells misclassified, sampling points drifting off-cell — and a hex dump of decoded bytes rarely tells you _why_. Diagnostic overlays give the developer a visual layer on top of the production UI that exposes what the protocol layer "saw" during a capture or stream.

**Conventions:**

- **Toggle-gated.** A single "Show diagnostics" checkbox per page, off by default, state persisted in `localStorage` so it survives reloads. Off → clean demo UI; on → developer view.
- **Off the hot path.** Diagnostics never run when the toggle is off; their cost stays at zero for the "show this to someone" demo case.
- **Parallel APIs in the protocol layer.** When a diagnostic surface needs internals (e.g. all detected marker candidates, not just the four chosen ones), add a `*WithDiagnostics` variant that returns the richer data. Keep the lean production function unchanged.

**Planned surfaces:**

| Surface | Lands with | What it shows |
| --- | --- | --- |
| **Receiver capture overlay** | M4.5 (stacked on M4) | Detected fiducial centroids (TL/TR/BR/BL colour-coded), cluster bounding boxes, rejected candidates in muted colours, the reconstructed grid overlaid on the warped image. Diagnoses "where did detection go wrong". |
| **Colour-score panel** | M4.5 (same PR) | For each marker candidate: pixel count, mean RGB, min RGB, role (chosen / rejected-too-small / rejected-too-large / not-a-corner). Drives empirical tuning of the >200 marker threshold. |
| **Bytestream progress visualizer** | M6 companion | A sparse-fill bar showing the payload buffer with received byte ranges filled and gaps unfilled. Lets the developer see which parts of a multi-frame transmission have landed and which are still pending. |

When in doubt: prefer adding to diagnostics rather than to the demo UI. The demo path should stay legible to a non-developer; the diagnostic path is for us.

## 12. Decision log

Short list of "we chose X over Y because Z" calls, so future-us can find the reasoning quickly.

- **Vitest over Jest.** Native ESM, native TS, shares Vite's transformer — zero-config and consistent with the runtime.
- **mise over nvm/Volta.** Standardized on it at the team level (CLAUDE.md), polyglot, project-pinned tool versions.
- **Bootstrap embedded in every frame, not periodic.** Zero join latency for broadcast — the property that matters most for the headline use case.
- **PRNG-seeded fountain header, not explicit index lists.** Constant header size regardless of K; saves ~`⌈log2(K)⌉ × d` bits per encoded packet at large K.
- **Hand-rolled homography for M3 instead of pulling a linear-algebra dep.** Small kernel, explicitly a learning project. Will reconsider if it shows up in profiles.
- **Stacked PR workflow.** One milestone per PR by default, base-branch chained, opened as drafts. Lets each milestone be reviewed in isolation without blocking forward progress.
