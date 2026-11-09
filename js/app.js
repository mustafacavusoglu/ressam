// UI, playback timeline, recording/downloads, environment switching.
import * as THREE from "three";
import { createStage } from "./stage.js";
import { createPainter } from "./painter.js";
import { PAPER, drawStroke, tipOf, composePainting, loadImage, generate, renderFinal, paintHeight, paintSurface } from "./strokes.js";

const $ = id => document.getElementById(id);
const CANCEL = { cancelled: true };
const PRE = 0.3, POST = 4.2, STROKE_PART = 0.88;   // last 12% of the painting time is the finishing pass

/* ---------- theme (light by default, remembered) ---------- */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme").textContent = t === "dark" ? "☀ Açık" : "☾ Koyu";
  try { localStorage.setItem("theme", t); } catch (e) { /* storage blocked */ }
}
let savedTheme = null; try { savedTheme = localStorage.getItem("theme"); } catch (e) { /* storage blocked */ }
setTheme(savedTheme === "dark" ? "dark" : "light");
$("theme").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

/* ---------- state ---------- */
const out = $("out");
const stage = createStage(out);
const painter = createPainter(stage.scene);
const paint = document.createElement("canvas"), pctx = paint.getContext("2d");   // committed strokes
const view = document.createElement("canvas"), vctx = view.getContext("2d");     // what the easel shows
let img = null, cw = 0, ch = 0;
let job = null;            // { strokes, cum, totalCost, ref, surface }
let drawn = 0;
let ready = false, playing = false, finished = false, prepId = 0, recording = false, discard = false, record = false;
let rec = null, chunks = [], videoBlob = null, videoExt = "mp4", t0 = 0, lastT = 0;
const canRecord = !!(window.MediaRecorder && out.captureStream);

/* ---------- environment ---------- */
let envMod = null, env = null, envQueue = Promise.resolve();
function basicWorld(scene) {   // fallback if the environment module can't load
  const objs = [new THREE.HemisphereLight("#dfe8ff", "#4a3a2a", 1.2)];
  const sun = new THREE.DirectionalLight("#fff1dc", 2.2); sun.position.set(-3, 5, 3); sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -1 }); objs.push(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: "#6b5a48", roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; objs.push(floor);
  scene.background = new THREE.Color("#2b2420");
  objs.forEach(o => scene.add(o));
  return { update() {}, dispose() { objs.forEach(o => scene.remove(o)); floor.geometry.dispose(); floor.material.dispose(); scene.background = null; } };
}
// serialised: old world is disposed before the next one is built (dispose resets background/fog/environment)
const loadEnv = () => (envQueue = envQueue.then(async () => {
  if (env) { env.dispose(); env = null; }
  try {
    envMod = envMod || await import("./environments.js");
    env = await envMod.buildEnvironment({ scene: stage.scene, renderer: stage.renderer, place: $("place").value, time: $("time").value });
  } catch (e) {
    console.error(e);
    env = basicWorld(stage.scene);
    $("place").closest(".f").hidden = $("time").closest(".f").hidden = true;
  }
  stage.renderer.toneMappingExposure = env.exposure ?? 1.0;
}));
function fillSelect(sel, items, def) {
  sel.innerHTML = items.map(i => `<option value="${i.id}"${i.id === def ? " selected" : ""}>${i.label}</option>`).join("");
}

/* ---------- canvas view ---------- */
function setupSheet(w, h) {
  cw = w; ch = h;
  paint.width = view.width = w; paint.height = view.height = h;
  pctx.fillStyle = PAPER; pctx.fillRect(0, 0, w, h);
}
function refreshView(info, glaze = 0) {
  stage.setReliefAmount(img ? glaze : 0);
  if (img) composePainting(vctx, paint, cw, ch, 1, info, job && job.ref, glaze, job && job.surface);
  else {
    vctx.drawImage(paint, 0, 0);
    vctx.fillStyle = "#3a3026"; vctx.textAlign = "center"; vctx.textBaseline = "middle";
    vctx.font = `bold ${Math.round(cw / 14)}px Georgia, serif`; vctx.fillText("Bir fotoğraf seç", cw / 2, ch / 2);
  }
  stage.updateCanvas();
}
const sheetSizeFor = (w, h) => { const sc = 1024 / Math.max(w, h); return [Math.max(64, Math.round(w * sc)), Math.max(64, Math.round(h * sc))]; };

/* ---------- preparing a photo ---------- */
function setProgress(p, text) {
  const bar = $("bar"); bar.hidden = false; bar.value = p;
  if (text) $("msg").textContent = text;
}
async function prepare() {
  if (!img) return;
  const id = ++prepId;
  stopPlay(true); ready = false; finished = false; videoBlob = null; job = null; updateUI();
  try {
    const f = $("format").value;
    stage.setFormat(f === "land" || (f === "auto" && img.w >= img.h));
    setupSheet(...sheetSizeFor(img.w, img.h)); stage.buildEasel(view); refreshView(null); stage.resetCamera();
    setProgress(0, "Fırçalar hazırlanıyor…");
    let lastYield = performance.now();
    const tick = async (frac, text) => {
      if (performance.now() - lastYield > 35) {
        setProgress(frac, text);
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
        if (id !== prepId) throw CANCEL;
      }
    };
    const res = await generate({ img, cw, ch, detail: +$("detail").value, tick });
    if (id !== prepId) return;
    setProgress(1, "Tuval dokusu hazırlanıyor…"); await new Promise(r => setTimeout(r, 0));
    const height = paintHeight(res.strokes, cw, ch, 1);
    res.surface = paintSurface(height);
    if (id !== prepId) return;
    stage.setRelief(height);
    job = res;
    setupSheet(cw, ch); drawn = 0; refreshView(null);
    ready = true;
    $("bar").hidden = true;
    $("msg").textContent = `Hazır: ${job.strokes.length.toLocaleString("tr-TR")} fırça darbesi. Oynatabilir ya da doğrudan videoya kaydedebilirsin.`;
  } catch (e) {
    if (e !== CANCEL) { console.error(e); $("bar").hidden = true; $("msg").textContent = "Resim işlenemedi. Başka bir fotoğraf dene."; }
  }
  updateUI();
}

/* ---------- playback ---------- */
function seek(prog) {
  const { strokes, cum, totalCost } = job, target = prog * totalCost;
  let lo = 0, hi = strokes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] > target) hi = m; else lo = m + 1; }
  while (drawn < lo) { drawStroke(pctx, strokes[drawn], 1); drawn++; }
  if (lo >= strokes.length) return null;
  const prev = lo ? cum[lo - 1] : 0;
  return { s: strokes[lo], frac: Math.min(1, Math.max(0, (target - prev) / (cum[lo] - prev))) };
}
// finishing pass: the brush sweeps the canvas in three rows while the glaze settles
function sweepUV(g) {
  const rows = 3, r = Math.min(rows - 1, Math.floor(g * rows)), f = g * rows - r;
  return [0.12 + 0.76 * (r % 2 ? 1 - f : f), 0.22 + r * 0.28 + 0.03 * Math.sin(f * 20)];
}

function pickMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  for (const m of ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}
function startRec() {
  const mime = pickMime();
  const stream = out.captureStream(30);
  rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : {});
  chunks = []; discard = false;
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    if (discard || !chunks.length) { recording = false; updateUI(); return; }
    const type = rec.mimeType || mime || "video/webm";
    videoBlob = new Blob(chunks, { type });
    videoExt = /mp4/i.test(type) ? "mp4" : "webm";
    recording = false;
    $("msg").textContent = `Video hazır (${(videoBlob.size / 1048576).toFixed(1)} MB, ${videoExt}). İndirebilirsin.`;
    updateUI();
  };
  rec.start(250);
  recording = true;
}
function start(withRec) {
  if (!ready || playing) return;
  playing = true; finished = false; videoBlob = null; record = withRec;
  setupSheet(cw, ch); drawn = 0; refreshView(null); stage.resetCamera();
  if (record) { try { startRec(); } catch (e) { console.error(e); record = false; $("msg").textContent = "Bu cihazda video kaydı başlatılamadı."; } }
  t0 = performance.now();
  updateUI();
}
function finish() {
  playing = false; finished = true;
  $("bar").hidden = true;
  if (record && rec && rec.state !== "inactive") {
    $("msg").textContent = "Video hazırlanıyor…";
    setTimeout(() => { try { rec.stop(); } catch (e) { recording = false; } }, 250);
  } else if (!record) { $("msg").textContent = "Tablo bitti. İstersen indirebilirsin."; }
  updateUI();
}
function stopPlay(silent) {
  if (!playing && !recording) return;
  playing = false; discard = true;
  if (rec && rec.state !== "inactive") { try { rec.stop(); } catch (e) { /* ignore */ } }
  recording = false;
  $("bar").hidden = true;
  if (!silent && ready) { setupSheet(cw, ch); drawn = 0; refreshView(null); $("msg").textContent = "Durduruldu."; }
  updateUI();
}

function updateUI() {
  const busy = playing || recording;
  $("play").disabled = !ready || (recording && !playing);
  $("play").textContent = playing ? "Durdur" : "Oynat";
  $("rec").disabled = !ready || busy || !canRecord;
  $("rec").title = canRecord ? "" : "Bu tarayıcı video kaydını desteklemiyor";
  $("save").hidden = !videoBlob;
  $("savePic").hidden = !(finished && ready);
  for (const id of ["detail", "format", "place", "time"]) $(id).disabled = busy;
  $("pick").style.pointerEvents = busy ? "none" : "";
}

/* ---------- downloads ---------- */
async function saveBlob(blob, filename, what) {
  let dl = null;
  try { dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null; } catch (e) { dl = null; }
  if (!dl) { // local: plain browser download
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $("msg").textContent = `${what} indirildi.`; return;
  }
  try {
    await dl.save({ filename, data: blob });
    $("msg").textContent = `${what} kaydedildi.`;
  } catch (e) {
    $("msg").textContent = e && e.code === "declined" ? "İndirme iptal edildi." : `${what} indirilemedi.`;
  }
}
async function savePainting() {
  if (!job) return;
  const c = renderFinal({ strokes: job.strokes, ref: job.ref, cw, ch, k: 2 });
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  if (blob) saveBlob(blob, "ressam-tablo.png", "Tablo");
}

/* ---------- main loop ---------- */
// Battery: render only as often as needed — 60 fps while playing, 30 while recording (the video is 30 fps),
// 20 fps when idle, nothing when the canvas is scrolled away (rAF already stops in hidden tabs).
let lastDraw = 0, onScreen = true;
new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(out);
function loop(now) {
  requestAnimationFrame(loop);
  const fps = recording ? 30 : playing ? 60 : 20;
  if ((!onScreen && !recording) || now - lastDraw < 1000 / fps - 2) return;
  lastDraw = now;
  const t = now / 1000, dt = Math.min(0.1, lastT ? t - lastT : 0.016); lastT = t;
  let tip = null, endBlend = 0;
  if (playing) {
    const dur = +$("dur").value, el = (now - t0) / 1000, p = (el - PRE) / dur;
    let info = null, glaze = 0;
    if (p >= 0 && p < 1) {
      if (p < STROKE_PART) {
        info = seek(p / STROKE_PART);
        if (info) { const [sx, sy] = tipOf(info.s, info.frac); tip = stage.sheetToWorld(sx / cw, sy / ch); painter.setPaint(info.s.c); }
      } else {
        seek(1);
        glaze = (p - STROKE_PART) / (1 - STROKE_PART);
        tip = stage.sheetToWorld(...sweepUV(glaze));
      }
    } else if (p >= 1) { seek(1); glaze = 1; }
    refreshView(info, glaze);
    endBlend = Math.min(1, Math.max(0, (el - PRE - dur) / (POST * 0.5)));
    setProgress(Math.min(1, el / (PRE + dur + POST)), record ? "Kaydediliyor… sekmeyi açık tut." : undefined);
    if (el >= PRE + dur + POST) finish();
  } else if (finished) endBlend = 1;
  painter.update(tip, dt, t, stage.dims);
  if (env) env.update(dt, t);
  stage.placeCamera(t, dt, endBlend, tip ? painter.hand : null);
  stage.render();
}

/* ---------- wiring ---------- */
$("file").addEventListener("change", async ev => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  stopPlay(true);
  $("msg").textContent = "Fotoğraf okunuyor…";
  try { img = await loadImage(f); } catch (e) { $("msg").textContent = "Bu dosya resim olarak açılamadı."; return; }
  ev.target.value = "";
  prepare();
});
$("play").addEventListener("click", () => { if (playing) stopPlay(false); else start(false); });
$("rec").addEventListener("click", () => start(true));
$("save").addEventListener("click", () => videoBlob && saveBlob(videoBlob, `ressam.${videoExt}`, "Video"));
$("savePic").addEventListener("click", savePainting);
$("detail").addEventListener("change", () => { if (img) prepare(); });
$("format").addEventListener("change", () => { if (img) prepare(); });
$("place").addEventListener("change", loadEnv);
$("time").addEventListener("change", loadEnv);

if (new URLSearchParams(location.search).has("debug")) window.ressam = { stage, painter, THREE, view, get job() { return job; } };   // inspection hook

stage.setFormat(true);
setupSheet(1024, 768); stage.buildEasel(view); refreshView(null);
painter.loaded.catch(e => { console.error(e); $("msg").textContent = "Ressam modeli yüklenemedi (internet?). Fırça yine de çalışır."; });
import("./environments.js").then(m => {
  envMod = m;
  fillSelect($("place"), m.PLACES, "lake"); fillSelect($("time"), m.TIMES, "sunset");
}).catch(() => {}).finally(async () => {
  await loadEnv();
  await painter.loaded.catch(() => {});
  if (!img) $("msg").textContent = "Önce bir fotoğraf seç.";
});
updateUI();
requestAnimationFrame(loop);
