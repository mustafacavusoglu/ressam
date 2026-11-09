// Photo → brush strokes, stroke drawing and compositing. Pixel loops run in Rust (wasm.js).
import { photoCore, surfacePixels } from "./wasm.js";

export const PAPER = "#f6f2ea";

export function drawStroke(c, s, frac) {
  c.strokeStyle = s.c; c.lineWidth = s.w; c.lineCap = "round"; c.lineJoin = "round";
  trace(c, s, frac); c.stroke();
}
function trace(c, s, frac) {
  const p = s.p, n = p.length >> 1;
  c.beginPath(); c.moveTo(p[0], p[1]);
  if (n === 1) c.lineTo(p[0] + 0.01, p[1]);
  else {
    const sg = (n - 1) * frac, full = Math.floor(sg);
    for (let i = 1; i <= full && i < n; i++) c.lineTo(p[2 * i], p[2 * i + 1]);
    const rem = sg - full;
    if (rem > 0 && full < n - 1) c.lineTo(p[2 * full] + (p[2 * full + 2] - p[2 * full]) * rem, p[2 * full + 1] + (p[2 * full + 3] - p[2 * full + 1]) * rem);
  }
}

export function tipOf(s, f) {
  const p = s.p, n = p.length >> 1;
  if (n < 2) return [p[0], p[1]];
  const sg = (n - 1) * f, i = Math.min(n - 2, Math.floor(sg)), r = sg - i;
  return [p[2 * i] + (p[2 * i + 2] - p[2 * i]) * r, p[2 * i + 1] + (p[2 * i + 3] - p[2 * i + 1]) * r];
}

/* ---------- compositing ---------- */
// Draw the painting (strokes canvas `src`, w×h) into ctx.
// k: pixel scale relative to the sheet; info: in-progress stroke; ref + finish: final pass toward the photo so it ends complete;
// surface (optional): oil-paint relief + canvas weave, laid over with `finish`.
export function composePainting(ctx, src, w, h, k, info, ref, finish, surface) {
  ctx.drawImage(src, 0, 0, w, h);
  if (info) { ctx.save(); ctx.scale(k, k); drawStroke(ctx, info.s, info.frac); ctx.restore(); }
  if (ref && finish > 0) { ctx.globalAlpha = 0.5 * finish; ctx.drawImage(ref, 0, 0, w, h); ctx.globalAlpha = 1; }
  if (surface && finish > 0) {
    ctx.globalCompositeOperation = "overlay"; ctx.globalAlpha = 0.85 * finish;
    ctx.drawImage(surface, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  }
}

/* ---------- paint surface ---------- */
// Height of the paint layer: every stroke is a ridge of its own thickness, wide strokes get bristle grooves.
export function paintHeight(strokes, cw, ch, k = 1) {
  const c = document.createElement("canvas"); c.width = cw * k; c.height = ch * k;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
  g.scale(k, k); g.lineCap = "round"; g.lineJoin = "round";
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const s of strokes) {
    const v = (110 + rnd() * 100) | 0, p = s.p;
    trace(g, s, 1); g.strokeStyle = `rgb(${v},${v},${v})`; g.lineWidth = s.w; g.stroke();
    if (s.w < 2.5 || p.length < 4) continue;
    const dx = p[p.length - 2] - p[0], dy = p[p.length - 1] - p[1], m = Math.hypot(dx, dy) || 1;
    const ox = -dy / m * s.w * 0.22, oy = dx / m * s.w * 0.22, gv = v - 45;
    g.lineWidth = Math.max(0.6, s.w * 0.12); g.strokeStyle = `rgb(${gv},${gv},${gv})`;
    for (const f of [-1, 1]) { g.save(); g.translate(ox * f, oy * f); trace(g, s, 1); g.stroke(); g.restore(); }
  }
  return c;
}
// Overlay layer (grey 128 = no change): relief lit from the upper left + linen weave.
export function paintSurface(height) {
  const w = height.width, h = height.height;
  const px = surfacePixels(height.getContext("2d").getImageData(0, 0, w, h).data, w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
  return c;
}

/* ---------- image helpers ---------- */
export async function loadImage(file) {
  try { const bm = await createImageBitmap(file); return { src: bm, w: bm.width, h: bm.height }; } catch (e) { /* fall back */ }
  const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  const im = new Image();
  await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
  return { src: im, w: im.naturalWidth, h: im.naturalHeight };
}

export function drawScaled(ctx, im, w, h) {
  let src = im.src, sw = im.w, sh = im.h;
  while (sw / 2 >= w && sh / 2 >= h) {
    const t = document.createElement("canvas"); t.width = Math.floor(sw / 2); t.height = Math.floor(sh / 2);
    const tc = t.getContext("2d"); tc.imageSmoothingQuality = "high"; tc.drawImage(src, 0, 0, t.width, t.height);
    src = t; sw = t.width; sh = t.height;
  }
  ctx.imageSmoothingQuality = "high"; ctx.drawImage(src, 0, 0, w, h);
}

/* ---------- painter brain ---------- */
// Coarse-to-fine painterly rendering. Returns strokes in play order plus a cumulative time budget,
// and `ref` (the photo at sheet size) used for the final glaze so the finished painting is complete.
export async function generate({ img, cw, ch, detail, tick }) {
  const rc = document.createElement("canvas"); rc.width = cw; rc.height = ch;
  const rx = rc.getContext("2d", { willReadFrequently: true });
  drawScaled(rx, img, cw, ch);
  const ref = rx.getImageData(0, 0, cw, ch).data;
  const wc = document.createElement("canvas"); wc.width = cw; wc.height = ch;
  const wx = wc.getContext("2d", { willReadFrequently: true });
  wx.fillStyle = PAPER; wx.fillRect(0, 0, cw, ch);

  const s = Math.max(cw, ch) / 900;
  const RAD = [16, 8, 4, 2, 1.2].slice(0, detail);
  const CAP = [4000, 11000, 20000, 30000, 38000];
  const THRESH = [16, 13, 11, 9, 8];            // finer layers fix smaller errors → nothing left unfinished
  const SHARE = [0.2, 0.25, 0.25, 0.2, 0.1];
  const all = [], layerRanges = [];
  const core = photoCore(ref);

  try { for (let li = 0; li < detail; li++) {
    const r = Math.max(0.9, RAD[li] * s);
    const txt = `Fırçalar hazırlanıyor… (${li + 1}/${detail})`;
    await tick(li / detail, txt);
    const cur = wx.getImageData(0, 0, cw, ch).data;
    const layer = core.layer(cur, cw, ch, r, THRESH[li], CAP[li], li < 2 ? 10 : 14)
      .map(st => ({ p: st.p, c: `rgb(${st.rgb})`, w: 2 * r, li, len: st.len }));
    for (const st of layer) drawStroke(wx, st, 1);
    // patch by patch (serpentine over a coarse grid) so the arm sweeps instead of teleporting
    const COLS = 5, ROWS = 4, flip = li % 2;
    const key = st => {
      const row = Math.min(ROWS - 1, (st.p[1] / ch * ROWS) | 0), col = Math.min(COLS - 1, (st.p[0] / cw * COLS) | 0);
      const rr = flip ? ROWS - 1 - row : row;
      return rr * COLS + (rr % 2 ? COLS - 1 - col : col);
    };
    layer.sort((a, b) => key(a) - key(b));
    layerRanges.push(layer);
    for (const st of layer) all.push(st);
  } } finally { core.free(); }

  const used = SHARE.slice(0, detail);
  const cum = new Float64Array(all.length);
  let acc = 0, k = 0;
  for (let li = 0; li < detail; li++) {
    const layer = layerRanges[li]; if (!layer.length) continue;
    let sum = 0; for (const st of layer) sum += st.len;
    for (const st of layer) { acc += used[li] * (st.len / sum); cum[k++] = acc; }
  }
  return { strokes: all, cum, totalCost: acc || 1, ref: rc };
}

// Renders the finished painting at k× the sheet size.
export function renderFinal({ strokes, ref, cw, ch, k }) {
  const w = cw * k, h = ch * k;
  const raw = document.createElement("canvas"); raw.width = w; raw.height = h;
  const rx = raw.getContext("2d");
  rx.fillStyle = PAPER; rx.fillRect(0, 0, w, h);
  rx.scale(k, k);
  for (const s of strokes) drawStroke(rx, s, 1);
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  composePainting(out.getContext("2d"), raw, w, h, k, null, ref, 1, paintSurface(paintHeight(strokes, cw, ch, k)));
  return out;
}
