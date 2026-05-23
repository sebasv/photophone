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

### 6.1 Back-channel modalities — visual vs audio

The unicast back-channel (receiver → sender, for ACK / NACK / handshake / continuous adaptation) is the gate to M11–M14. We currently plan a **visual** channel (receiver renders a frame on its own screen, the sender's camera reads it). An **audio** back-channel — receiver emits acoustic chirps, the sender's microphone captures them — is a serious alternative worth holding open.

#### Why audio is on-theme, not off-theme

Alexander Graham Bell's 1880 photophone transmitted **speech over light** (a flexible mirror modulated by the speaker's voice, a selenium photocell on the other end). The historical device that this project is named after was an audio-over-light apparatus. Adding audio doesn't betray "photons only" — it completes the metaphor the project is already drawing on. "Two computers seeing each other" and "two computers talking to each other" together form a richer chord than either alone.

#### What audio solves that the visual back-channel doesn't

- **Spatial flexibility.** The visual back-channel needs both devices to have a camera pointed at the other's screen — which is awkward for laptops (front-facing camera + front-facing screen = you cannot easily set up bidirectional camera↔screen between two laptops). Audio is omnidirectional: if both devices can hear each other, the back-channel works regardless of physical orientation.
- **Higher available bandwidth.** A 44.1 kHz microphone with a modest 1000-baud FSK encoding carries hundreds of bytes per second — far more than the visual back-channel, which is bounded by camera frame rate × per-frame cell capacity.
- **No second camera required.** The sender uses its mic, not its camera, for the back-channel. Laptops and phones already have a microphone; no extra hardware.

#### Why we'd still want photons-only for the *main* data path

- **Core thesis.** "Two screens, only photons" is the project's identity. The main data path stays visual.
- **Acoustic environments are noisy in practice.** Rooms with music, conversation, fans, HVAC. The visual channel is robust to ambient noise; audio isn't. The visual back-channel remains the canonical reference implementation.
- **Demo legibility.** "Photophone via screen + camera only" is a cleaner headline than "screen + camera + speaker + mic."

#### Technical approach

Simplest viable encoding: **FSK (Frequency-Shift Keying)**. Two distinct audio tones encode bit 0 and bit 1.

- Sender (= receiver of data, emitting back-channel): `OscillatorNode` via the Web Audio API, switching frequency per bit.
- Receiver (= data sender, listening): `MediaStreamAudioSourceNode` → `AnalyserNode`, FFT per chunk, detect which tone is dominant.

Two frequency choices to consider:

- **Audible range** (e.g. 1000 Hz and 1500 Hz). Easy to detect, easy to debug ("you can hear it working"), but obviously noisy in shared spaces.
- **Near-ultrasonic** (17–20 kHz). Inaudible to most adults, still well within most consumer mic/speaker frequency response. Same FFT, just different tones. This is what commercial data-over-sound systems use.

For ACKs and NACK ranges we need maybe 20–60 bytes per packet, easily within FSK's reach. For higher throughput we'd graduate to PSK / QAM / OFDM, but that's overkill for what the back-channel needs.

Prior art worth studying:
- **ggwave** (MIT-ish) — small, focused library doing exactly this in audible / near-ultrasonic ranges. JS bindings exist.
- **Quiet Modem Project** (MIT) — fuller-featured OFDM/PSK acoustic modem in WebAssembly.
- **Chirp** (commercial, no longer maintained) — the historical reference for "data over audio."

#### How it fits in the milestone graph

M11–M14 currently treat the back-channel as a single resource (visual). To accommodate audio cleanly, the milestones can split:

- **M11a — Visual back-channel** (the existing M11)
- **M11b — Audio back-channel** (new; stretch / power-user)

Everything M12–M14 depends on "a back-channel exists" and doesn't care which modality is wired up. The receiver UI would offer a toggle: "back-channel via screen" (default) or "back-channel via audio."

#### Recommendation

Do **M11a (visual)** first as the canonical reference implementation — keeps the project's philosophical purity intact and forces us to solve bidirectional optical alignment. Add **M11b (audio)** as a stretch milestone, primarily for demos where the spatial setup makes the visual back-channel impractical (e.g., two laptops at a meetup table).

#### Audible-mode toggle (opt-in for quirk)

Near-ultrasonic (17–20 kHz) is the right *default* for the audio back-channel — invisible to the ear, no interference with conversation, no startled bystanders. But there's a strong product argument for a toggle that **moves the FSK tones into the human-audible range** (say 1000–2000 Hz) on demand: it lets a person *witness* the back-channel in action. The whole point of the project is making computers communicate in ways humans can perceive — photons are already visible, the bytes-as-colours are right there. Letting the audio be audible by request is exactly the kind of quirk that fits the photophone metaphor.

Concretely: a single toggle on the receiver page, off by default. When on, the FSK tone pair drops from `(f₀_ultra, f₁_ultra)` into `(f₀_audible, f₁_audible)`. Encoding and protocol are otherwise identical; only the carrier frequencies change. The user gets to *hear* the ACKs and NACKs flying between the two devices.

Why this is worth shipping (when M11b lands):
- Demos / meetups where the audible duet is the punchline.
- Pedagogical value — teaches data-over-sound viscerally without anyone having to explain "this is real, just trust me, ultrasonic."
- Debugging — audible tones tell you that the device IS emitting something even when detection isn't working.

#### What we explicitly don't want

- **Audio for the main data path.** That would dilute the project's identity.
- **Audible audio *as default*.** Audible mode is opt-in — it lights up because the user asked for it. Default is near-ultrasonic. A polite beep, never a continuous chirp.


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

### M3.5 — Robust fiducial detection
**Motivation — three failures discovered during M4 manual testing:**

1. **Lighting brittleness.** The detector uses `r > 200 && g > 200 && b > 200`. That threshold was tuned for an indoor scene where the camera's auto-exposure metered against a dark room. Outside in daylight the camera meters against bright surroundings, gain drops, and the actual fiducial pixels come back at maybe `(180, 180, 195)` — silently failing the threshold even though nothing about the fiducial itself changed.

2. **False positives from arbitrary bright shapes.** Any blob over the threshold that survives the size filter is a candidate. White letters on the sender page (`#f5f5f5` until the PR #8 fix), a laptop bezel under outdoor light, paper in the frame — all can pass. When such a blob sits closer to an image corner than a real fiducial, it wins the corner-assignment heuristic and the homography lands sampling off-frame.

3. **Orientation.** `detectFiducials` assigns blobs to corners by Manhattan distance to *image* corners, which is rotation-blind: rotate the camera 180° and the receiver labels what was the sender's TL as BR, so cells decode back-to-front.

**Why not "just add a quiet zone" around each fiducial?** Letters on a dark page already have black around them; surrounding margin is visually identical to a fiducial's outer ring. Whitespace separates content from noise but doesn't *characterise* fiducial-ness. The fix has to constrain the marker's shape, not its surroundings.

**Approach — pivot to QR-style detection.** Two changes together; orientation strategy still TBD (see "Open: orientation strategy" below).

#### 1. Otsu's adaptive thresholding

Replace the constant `>200` with a per-frame threshold derived from the image's brightness histogram. Otsu picks the threshold that maximises the between-class variance of "dark vs. bright" pixels — i.e., the value that best separates foreground from background in *this specific* frame. No magic constants survive across lighting conditions.

- Compute a 256-bin luminance histogram of the camera frame
- Walk the threshold from 1..254, keep the value that maximises `w_dark · w_bright · (μ_bright − μ_dark)²`
- Use that threshold (and a tolerance band) as the marker-pixel test

Independent of fiducial shape. Solves the outdoor/indoor problem. ~80 lines, no dependencies, well-documented algorithm.

#### 2. 7×7 Position Detection Patterns (PDPs) at all four corners

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

Why this is dramatically more robust than the current 4×4 detector:

- **The ratio is overwhelmingly improbable in nature.** A bezel, a letter, a reflection — none have a sharp dark ring around a bright ring around a dark centre with the right proportions. Bezels would have width ratios like `1:0.5:100:0.5:1` (the bright screen content fills most of the line) and fail.
- **No separate "anti-bezel" or "anti-letter" checks needed.** The ratio test alone subsumes them.
- **Decades of empirical hardening.** Every corner case has already been found and fixed in published implementations.

**Cost:** 7×7 = 49 cells per fiducial × 4 corners = 196 cells, up from 64 today. Net payload impact: **−132 cells = −3.4%**. Acceptable; the robustness payoff justifies it.

#### 3. Orientation via magic validation in all four rotations

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

#### 4. Geometry plausibility sanity check (optional, low effort)

After detection, verify the four chosen PDP centroids form a roughly-convex quadrilateral with reasonable aspect ratio (say 0.5–2.0) and reasonable image-area fraction (e.g. 5%–80%). Cheap to add (~30 lines) and catches the residual edge cases where four valid PDP-passing patches are arranged implausibly. Skip if the PDP detector alone proves robust enough in practice.

#### 5. Deferred refinements

Two detector ideas considered but not shipped in M3.5. Logged here with a "pick up when…" trigger so the deferral is explicit and the reasoning is preserved for whoever revisits this section.

##### a. Staggered topology / outer-band area ratio

**Idea.** Extend the area-ratio check to a third layer. Currently we verify `D_inner ⊂ W_ring` with `W/D ≈ 16/9`. The natural extension is to verify an *outer dark band* immediately around `W_ring` with thickness ≈ 1/3 of the centre. Done as area ratios it is **projectively invariant** — strictly more perspective-robust than the 1:1:3:1:1 cross-section we landed in §8 M3.5 #3.

**Why deferred.** The cross-section verifier is already cheap (~30 ops worst case per candidate) and effective on the failure modes M4.5 surfaced. The staggered outer-band check needs morphological dilation around each candidate's `W_ring` to isolate the immediate annulus from the page-background connected component — another full pixel pass per candidate. For typical handheld camera angles, the cross-section's perspective sensitivity is well within tolerance.

**Pick up when:**
- Manual testing reveals false-positive leaks under extreme perspective (camera approaching screen-edge-on), where cross-section starts failing under heavy band-width distortion.
- Or: a structural false positive emerges in the wild that passes both flood-fill containment *and* cross-section verification.

##### b. Locality-restructured detector (one flood-fill instead of two)

**Idea.** Currently `detectPDPs` runs `findComponents` twice — once for whites, once for darks. Restructure to: flood-fill *only* dark components, then per-candidate localised expansion to find each candidate's surrounding white ring (sampling pixels in the annulus just outside the dark's bbox, rather than committing the whole image's white pixels to a connected-components pass).

**Why deferred.** Detection is currently well under budget (<5ms total on a 1080p frame; the connected-components passes are ~2ms each). This refactor would save ~2ms — a real number, but optimisation isn't a problem yet. The current structure is also more obviously correct under inspection; locality changes invite bugs.

**Pick up when:**
- Profiling shows detection in the hot loop dominating frame time (>15ms on real hardware).
- Or: M6 (continuous capture) demands a frame budget the current detector can't meet.

**Done when:**
- A single PNG decodes correctly under all of: dim indoor light, outdoor daylight, mixed lighting, and the camera held at any of the four cardinal orientations.
- A wider camera view that includes the laptop bezel still decodes correctly — the bezel does not win corner assignment.
- No manual covering of sender-page UI required.
- Synthetic-warp tests still pass (rotated inputs to `decodeFrameWarped`).

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
- **This is also where Photophone formally becomes a *file* transfer rather than a *byte stream*** — the receiver reads the bootstrap mime/filename and saves the result with the correct name and extension, regardless of payload type (see §9.2).
- **Done when:** open two receiver windows that start at different times during a single broadcast; both reconstruct the file successfully without coordinating, save it with the correct name and extension, and verify the sha256 transmitted in the bootstrap. Verified with at least two payload types (a PNG and a non-image binary, e.g. a small PDF or text file) to confirm the any-binary path.

### M11 — Receiver→sender back-channel (visual ACK channel)
- Receiver page can render a small dedicated channel frame (lower fps, larger cells acceptable) on its own screen.
- Sender page can open its own camera, find this channel, and decode it.
- This is shared infrastructure for M12, M13, M14 — get it solid before layering features.
- M11b is a planned alternative back-channel modality (audio via FSK over Web Audio) — see §6.1. Same interface, different physical channel; M12–M14 don't care which is wired up.
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

## 9.2 Payload format and the move from PNG to any-binary

The Photophone protocol layer (codec, framing, transport) is **binary-agnostic from the start** — it transports an opaque `Uint8Array` and never inspects its contents. The only places where PNG appears in the codebase are UX hints in the sender / receiver pages:

- `send.html`'s file picker uses `accept="image/png"`
- `receive.ts`'s success message checks the PNG file signature (`89 50 4E 47 0D 0A 1A 0A`) as a payload-content sanity hint
- `hello_world.png` is the canonical end-to-end test corpus

These are scaffolding around the M4 manual test loop; nothing in the wire format prevents transmitting any other binary.

### Phased transition

**Phase A — UX-level "any binary" (small, can land any time)**

- Drop `accept="image/png"` (or set to `accept="*"`) on the file picker.
- Replace the PNG-signature sanity check with a generic "received N bytes" display, ideally with light file-type sniffing (`89 50 4E 47…` = PNG, `FF D8 FF` = JPEG, `25 50 44 46` = PDF, etc.) so the receiver can still give a useful hint when it recognises the type.
- No protocol changes. Existing `hello_world.png` tests continue to work.

**Phase B — Self-describing payloads via bootstrap metadata (M10)**

The bootstrap region (§4.1) already reserves space for `mime_index`, `filename_hash`, full sha256, and full filename. Once M10 lands these are populated by the sender on every frame, and the receiver can:

- Save the received bytes with the correct filename and extension
- Show the inferred MIME in the UI
- Verify integrity against the transmitted sha256

This is when Photophone formally becomes a *file* transfer rather than a *byte stream* — a real "send me that PDF" use case.

### Recommended milestone allocation

- **Phase A** as a small standalone PR alongside or after the next milestone. Removing the PNG-only UI hints is cheap and lets the project advertise itself as "any binary" sooner.
- **Phase B** is **M10**'s headline. The broadcast mode is what makes "drop this file into the world" interesting, so the file-transfer UX naturally arrives with it.

### Concretely — what changes when

- M5 / M6 / M7 / M8: protocol work is binary-agnostic; payload type is a UX detail.
- M9 (fountain coding): unchanged — fountain operates on bytes, not files.
- M10 (broadcast mode): adds bootstrap-metadata-driven mime/filename. **The receiver becomes file-aware here.** Done-when should explicitly mention "two receivers can pick up a broadcast and save the file with the correct name and extension regardless of type."
- M10+: payload type is no longer a meaningful protocol concept.


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
