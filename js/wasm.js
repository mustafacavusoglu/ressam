// Loads the Rust core (wasm/src/lib.rs → js/ressam.wasm) and wraps its raw exports.
const bytes = await (await fetch(new URL("./ressam.wasm", import.meta.url))).arrayBuffer();
const W = (await WebAssembly.instantiate(bytes)).instance.exports;

const put = px => { const p = W.alloc(px.length); new Uint8Array(W.memory.buffer, p, px.length).set(px); return p; };

// The photo stays in wasm memory for every layer of one painting; call free() when done.
export function photoCore(ref) {
  const refP = put(ref);
  return {
    // → [{ p: Float32Array of x,y pairs, rgb: [r,g,b], len }]
    layer(cur, w, h, r, thresh, cap, maxs) {
      const curP = put(cur);
      const n = W.layer(refP, curP, w, h, r, thresh, cap, maxs, (Math.random() * 2 ** 31) >>> 0);
      W.free(curP, cur.length);
      const f = new Float32Array(W.memory.buffer, W.out_ptr(), n), strokes = [];
      for (let k = 0; k < n;) {
        const np = f[k], rgb = f[k + 1];
        strokes.push({ p: f.slice(k + 3, k + 3 + 2 * np), rgb: [rgb >> 16, (rgb >> 8) & 255, rgb & 255], len: f[k + 2] });
        k += 3 + 2 * np;
      }
      return strokes;
    },
    free() { W.free(refP, ref.length); },
  };
}

// Stroke-height RGBA → overlay RGBA (relief + linen weave).
export function surfacePixels(height, w, h) {
  const inP = put(height), outP = W.alloc(height.length);
  W.surface(inP, outP, w, h);
  const out = new Uint8ClampedArray(W.memory.buffer, outP, height.length).slice();
  W.free(inP, height.length); W.free(outP, height.length);
  return out;
}
