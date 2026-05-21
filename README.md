# Photophone

> _Sharing data between two screens, using only photons._

Photophone is a browser-to-browser data transfer protocol that uses **only a screen and a camera** as the physical link. No Wi-Fi, no Bluetooth, no cables — just light.

Think of it as **QR codes, but for arbitrary payloads of arbitrary size**, with a TCP-inspired reliability layer running on top.

## Why "Photophone"?

In 1880, Alexander Graham Bell invented the [photophone](https://en.wikipedia.org/wiki/Photophone) — a device that transmitted speech over a beam of light. He considered it his greatest invention, even above the telephone. It is widely regarded as the conceptual ancestor of fibre-optic communication.

This project is, in that lineage, a (slightly absurd) postmodern fibre optic: the medium is light, but the carrier is two consumer devices facing each other.

## How it works

```
[Sender device]  ──── photons ────►  [Receiver device]
   screen                                    camera

                ◄──── photons ────
                  ACK / NACK frames
```

1. **Sender** encodes a byte payload as a sequence of visual frames — a grid of coloured cells, with fiducial markers in the corners for alignment and a calibration strip for white-balance correction.
2. **Receiver** captures frames through its camera, locates the grid, unwarps perspective, samples cells, and reconstructs bytes.
3. The two devices speak a **TCP-inspired protocol**: packets carry sequence numbers, and the receiver requests retransmission of dropped frames over _its own_ screen (camera-flipped). Both devices need a screen and a camera.

## Status

🚧 Very early — this repo currently scaffolds the project and outlines the architecture. Nothing actually transmits yet. The roadmap below is the plan.

## Stack

- **TypeScript + Vite** — strict, fast, ESM-native
- **Progressive Web App** — installable, runs fully offline (poetic, given the premise)
- **Web Workers + OffscreenCanvas** — keep the UI thread responsive during decoding
- **WebGL2 shaders** — planned for the per-pixel hot path (binarization, fiducial detection, colour classification)
- **Rust → WASM** — planned for ECC / fountain-code decode, once the algorithms stabilize

## Roadmap

- [x] Project scaffold
- [ ] Single-frame loopback: encode a known payload, decode from a still photo
- [ ] Fiducial detection + perspective unwarp
- [ ] Colour calibration strip per frame
- [ ] Multi-frame streaming
- [ ] TCP-style ARQ reliability layer over a bidirectional camera link
- [ ] First end-to-end PNG transfer
- [ ] WebGL2 fast-path for the receiver
- [ ] Rust/WASM ECC

## Develop

```sh
pnpm install
pnpm dev
```

Open the printed URL on **two devices** (or two browser windows on the same machine, for early testing). Point one device's camera at the other's screen.

```sh
pnpm build        # production build
pnpm preview      # serve the production build locally
pnpm typecheck    # tsc --noEmit
```

## Project layout

```
src/
├── main.ts                 # landing page wiring
├── style.css
├── pages/
│   ├── send.ts             # sender role: encode + render frames
│   └── receive.ts          # receiver role: capture camera + decode
├── protocol/               # the wire format, kept UI-agnostic
│   ├── framing.ts          # grid layout, fiducials, calibration
│   ├── codec.ts            # bytes ↔ cells
│   ├── ecc.ts              # error correction
│   └── transport.ts        # ARQ / sequencing / retransmits
└── workers/
    └── decoder.worker.ts   # off-main-thread decode pipeline
```

## License

MIT — see [LICENSE](./LICENSE).
