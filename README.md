# Ressam

Pick a photo, and watch it get painted from scratch with a brush on a canvas in a 3D scene. The brush strokes are computed from the photo with code. No AI, no server: everything runs in the browser.

<p align="center">
  <img src="docs/demo.gif" width="270" alt="Ressam demo">
</p>

[Demo video (MP4, 17 sec)](docs/demo.mp4)

| Photo | The painter's canvas |
|---|---|
| <img src="docs/ornek.jpg" width="320"> | <img src="docs/tablo.jpg" width="320"> |

Sample image: Johannes Vermeer, *Girl with a Pearl Earring* (1665). It is in the public domain and taken from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:1665_Girl_with_a_Pearl_Earring.jpg).

## How it works

1. **Brush strokes (Rust → WebAssembly):** The photo is painted in five layers, from coarse to fine. At each layer the image is blurred according to the brush size. The regions of the canvas that differ most from the photo are found. From each region, a brush stroke is drawn that follows the edges of the photo. Code: [`wasm/src/lib.rs`](wasm/src/lib.rs).
2. **Scene (three.js):** An easel, the surroundings (a lake, a clock), and a hand holding the brush. The hand tracks the brush tip using inverse kinematics (IK).
3. **Finish:** The camera moves toward the canvas. Paint relief and linen texture are added to the painting. The painting can be downloaded as a PNG, and the playback as an MP4/WebM video.

## Running it

With Docker:

```bash
docker build -t ressam .
docker run -d -p 8080:80 ressam
```

Then open http://localhost:8080 in your browser.

Without Docker, with any static file server:

```bash
python3 -m http.server 8080
```

If you change the Rust code, rebuild `js/ressam.wasm` (requires `rustup target add wasm32-unknown-unknown`):

```bash
./build.sh
```

Tests and speed benchmark:

```bash
cd wasm && cargo test --release && cargo run --release --example bench
```

## Files

| File | Purpose |
|---|---|
| `wasm/src/lib.rs` | Brush stroke layers and canvas texture (Rust) |
| `js/wasm.js` | Loads and wraps the WebAssembly module |
| `js/strokes.js` | Draws the strokes and composes the painting |
| `js/stage.js` | Easel, canvas, and camera |
| `js/painter.js`, `js/hand.js` | The hand holding the brush and the arm IK |
| `js/environments.js` | Room and clock environments |
| `js/app.js` | UI, playback, and recording |

The hand model is `Michelle.glb` (Mixamo) from the three.js examples. It is loaded together with three.js from the jsDelivr CDN.
