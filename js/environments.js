// Ressam — painting locations (the world around the easel).
// API: PLACES, TIMES, buildEnvironment({ scene, renderer, place, time }) → { update(dt, t), dispose(), exposure, buildMs }
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { Water } from "three/addons/objects/Water.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

export const PLACES = [
  { id: "studio", label: "Atölye" },
  { id: "forest", label: "Orman" },
  { id: "lake", label: "Göl kenarı" },
  { id: "mountain", label: "Dağ manzarası" },
  { id: "beach", label: "Sahil" },
  { id: "lavender", label: "Lavanta tarlası" },
];
export const TIMES = [
  { id: "sunrise", label: "Gün doğumu" },
  { id: "noon", label: "Öğle" },
  { id: "sunset", label: "Gün batımı" },
];

const WATERNORMALS_URL = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/waternormals.jpg";

/* ======================================================================
   Time-of-day table.
   az: sun azimuth in degrees, 0 = behind the easel (−z), 90 = left (−x), 180 = behind the camera (+z).
   el: visible sun elevation; lightEl: elevation used for the shadow-casting light (kept higher at
   golden hour so the work area stays lit and shadows stay a sane length).
   ====================================================================== */
const TIME_CFG = {
  sunrise: {
    az: 24, el: 4, lightEl: 15, turbidity: 2.2, rayleigh: 3.2, mie: 0.005, mieG: 0.86, skyBright: 0.46,
    sun: "#ffb48a", sunI: 2.6, fill: "#c4b6f0", fillI: 1.25, hemi: ["#ffd2c4", "#6a5a7a", 0.55], envI: 1.15, groundLum: 0.45, exposure: 1.05,
    studio: { az: 70, el: 21, sunI: 8, envI: 0.55, fillI: 0.55, exposure: 1.1 },
  },
  noon: {
    az: 148, el: 55, lightEl: 55, turbidity: 1.8, rayleigh: 1.1, mie: 0.003, mieG: 0.8, skyBright: 0.34,
    sun: "#fff1dc", sunI: 3.2, fill: "#dce8ff", fillI: 0.45, hemi: ["#cfe6ff", "#7a8a50", 0.45], envI: 1.15, groundLum: 1.0, exposure: 1.0,
    studio: { az: 84, el: 46, sunI: 5.0, envI: 0.75, fillI: 0.45, exposure: 1.05 },
  },
  sunset: {
    az: 50, el: 2.6, lightEl: 13, turbidity: 4.5, rayleigh: 3.6, mie: 0.006, mieG: 0.9, skyBright: 0.5,
    sun: "#ff9150", sunI: 2.6, fill: "#b49ce8", fillI: 1.3, hemi: ["#ffb8a8", "#5a4a78", 0.6], envI: 1.1, groundLum: 0.42, exposure: 1.08,
    studio: { az: 58, el: 17, sunI: 8, envI: 0.45, fillI: 0.55, exposure: 1.15 },
  },
};

// Work area (must stay flat & clear) and the region the shadow camera covers.
const WORK = { x0: -2.6, x1: 2.2, z0: -1.0, z1: 3.6 };
const SHADOW_BOX = { x0: -2.9, x1: 2.5, y0: 0, y1: 2.5, z0: -1.3, z1: 3.9 };

/* ======================================================================
   Small helpers
   ====================================================================== */
const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const C = (hex) => new THREE.Color(hex);

function rng(seed) {             // mulberry32
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const perlin = new ImprovedNoise();
const noise = (x, z, s = 0) => perlin.noise(x, z, s);
function fbm(x, z, oct = 4, seed = 0) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * perlin.noise(x * f, z * f, seed + i * 17.13); n += a; a *= 0.5; f *= 2.02; }
  return s / n;
}
function ridged(x, z, oct = 6, seed = 0) {
  let a = 1, f = 1, s = 0, n = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(perlin.noise(x * f, z * f, seed + i * 7.31));
    v *= v; v *= w; w = clamp(v * 1.8, 0, 1);
    s += v * a; n += a; a *= 0.5; f *= 2.03;
  }
  return s / n;
}
// distance from the work rectangle (0 inside)
function workDist(x, z, m = 0) {
  const dx = Math.max(WORK.x0 - m - x, 0, x - WORK.x1 - m);
  const dz = Math.max(WORK.z0 - m - z, 0, z - WORK.z1 - m);
  return Math.hypot(dx, dz);
}
const inWork = (x, z, m = 0) => x > WORK.x0 - m && x < WORK.x1 + m && z > WORK.z0 - m && z < WORK.z1 + m;
// 0 inside the work area (+margin), smoothly 1 beyond `blend` metres
const flatMask = (x, z, margin = 0.6, blend = 7) => sstep(0, blend, workDist(x, z, margin));
const dirFromAzEl = (az, el) => {
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  return new V3(-Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
};

// Module-level caches: CPU-side canvases / geometries are reused across builds (dispose() frees only GPU copies).
// chunky bevelled box for props (no razor-sharp edges)
const rbox = (w, h, d) => new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.3);
const memoCache = new Map();
const memo = (key, fn) => { if (!memoCache.has(key)) memoCache.set(key, fn()); return memoCache.get(key); };
const uTime = { value: 0 };     // shared wind clock

function makeCanvas(w, h, draw) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h); return c;
}
// draw something 9× so it tiles seamlessly
const wrapDraw = (w, h, x, y, fn) => { for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) fn(x + dx, y + dy); };

/* ======================================================================
   Build context & disposal
   ====================================================================== */
function makeCtx(scene, renderer) {
  const root = new THREE.Group(); root.name = "environment";
  scene.add(root);
  return {
    scene, renderer, root, owned: [], updaters: [], waters: [], noReflect: [],
    add(o) { root.add(o); return o; },
    keep(x) { this.owned.push(x); return x; },
    tex(canvas, { repeat = [1, 1], srgb = true, aniso = 8, wrap = true } = {}) {
      const t = new THREE.CanvasTexture(canvas);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]); t.anisotropy = aniso;
      return this.keep(t);
    },
  };
}
function disposeCtx(ctx) {
  const { scene, root } = ctx;
  scene.remove(root);
  const geos = new Set(), mats = new Set(), texs = new Set();
  root.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    if (o.material) [].concat(o.material).forEach((m) => mats.add(m));
    if (o.customDepthMaterial) mats.add(o.customDepthMaterial);
    if (o.isLight && o.dispose) o.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
  for (const m of mats) {
    for (const v of Object.values(m)) if (v && v.isTexture) texs.add(v);
    if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u.value && u.value.isTexture) texs.add(u.value);
    m.dispose();
  }
  geos.forEach((g) => g.dispose());
  texs.forEach((t) => { if (!t.isRenderTargetTexture) t.dispose(); });
  ctx.owned.forEach((x) => x.dispose());
  ctx.waters.forEach((w) => w.rt && w.rt.dispose());
  scene.background = null; scene.environment = null; scene.fog = null;
}

/* ======================================================================
   Material helpers
   ====================================================================== */
// Foliage/grass: wind sway in object space (scaled by height²) and no normal flip on back faces,
// so double-sided cards keep their "spherical" normals and shade softly.
function foliageMat(opts, wind = 0, keepNormal = true) {
  // physical material only to switch specular off: grazing Fresnel sheen makes leaf cards look like paper
  const m = new THREE.MeshPhysicalMaterial({ specularIntensity: 0, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = "uniform float uTime;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      vec3 ip = vec3(0.0);
      #ifdef USE_INSTANCING
        ip = instanceMatrix[3].xyz;
      #endif
      float hh = max(position.y, 0.0);
      float ph = ip.x * 0.45 + ip.z * 0.31;
      float sw = sin(uTime * 1.5 + ph) * 0.7 + sin(uTime * 3.3 + ph * 2.3 + position.x * 1.7) * 0.3;
      transformed.x += sw * hh * hh * ${wind.toFixed(6)};
      transformed.z += cos(uTime * 1.15 + ph * 1.7) * hh * hh * ${(wind * 0.6).toFixed(6)};`);
    if (keepNormal) sh.fragmentShader = sh.fragmentShader.replace("#include <normal_fragment_begin>",
      THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""));
  };
  m.customProgramCacheKey = () => `fol-${wind}-${keepNormal}`;
  return m;
}

/* ======================================================================
   Geometry builder (non-indexed triangles with position/normal/uv/color)
   ====================================================================== */
class Parts {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; }
  vert(p, n, u, v, c) { this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.uv.push(u, v); this.c.push(c.r, c.g, c.b); }
  // p0 bottom-left, p1 bottom-right, p2 top-right, p3 top-left
  quad(p0, p1, p2, p3, n, c, uv = [0, 0, 1, 1]) {
    const P = [p0, p1, p2, p3], N = Array.isArray(n) ? n : [n, n, n, n], Cc = Array.isArray(c) ? c : [c, c, c, c];
    const U = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
    for (const i of [0, 1, 2, 0, 2, 3]) this.vert(P[i], N[i], U[i][0], U[i][1], Cc[i]);
  }
  // add a three.js geometry transformed by `matrix`; colour: Color or (pos, normal) => Color
  geo(g, matrix, color, uvFixed) {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    if (matrix) geo.applyMatrix4(matrix);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const P = geo.attributes.position, N = geo.attributes.normal, UV = geo.attributes.uv;
    const p = new V3(), n = new V3();
    for (let i = 0; i < P.count; i++) {
      p.fromBufferAttribute(P, i); n.fromBufferAttribute(N, i);
      const c = typeof color === "function" ? color(p, n) : color;
      const u = uvFixed ? uvFixed[0] : UV ? UV.getX(i) : 0, v = uvFixed ? uvFixed[1] : UV ? UV.getY(i) : 0;
      this.vert(p, n, u, v, c);
    }
    geo.dispose(); g.dispose();
  }
  get count() { return this.p.length / 3; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    return g;
  }
}
// Merge several Parts into one geometry with one group per Parts (→ material array index).
function groupsGeometry(list) {
  const g = mergeGeometries(list.map((p) => {
    if (p.count === 0) p.vert(new V3(), UP, 0, 0, C("#000")), p.vert(new V3(), UP, 0, 0, C("#000")), p.vert(new V3(), UP, 0, 0, C("#000"));
    return p.build();
  }), true);
  g.computeBoundingSphere();
  return g;
}
const m4 = (pos, quat, scl) => new THREE.Matrix4().compose(pos, quat || new THREE.Quaternion(), scl || new V3(1, 1, 1));
const qBetween = (a, b) => new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
// a cylinder between two points
function limb(parts, a, b, r0, r1, color, seg = 7) {
  const d = b.clone().sub(a), len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
  parts.geo(g, m4(a.clone().addScaledVector(d, 0.5), qBetween(UP, d)), color);
}
// one textured card with random in-plane rotation; normals come from normalFn(vertex)
function card(parts, c, half, nrm, rot, normalFn, colorFn) {
  const t = Math.abs(nrm.y) < 0.9 ? UP : new V3(1, 0, 0);
  let u = new V3().crossVectors(t, nrm).normalize(), v = new V3().crossVectors(nrm, u);
  const cu = Math.cos(rot), su = Math.sin(rot);
  const uu = u.clone().multiplyScalar(cu).addScaledVector(v, su).multiplyScalar(half);
  const vv = v.clone().multiplyScalar(cu).addScaledVector(u, -su).multiplyScalar(half);
  const P = [c.clone().sub(uu).sub(vv), c.clone().add(uu).sub(vv), c.clone().add(uu).add(vv), c.clone().sub(uu).add(vv)];
  parts.quad(P[0], P[1], P[2], P[3], P.map(normalFn), P.map(colorFn));
}
// a strip through points; side(i) gives the half-width vector at point i
function strip(parts, pts, side, nrm, col) {
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const s0 = side(i), s1 = side(i + 1);
    parts.quad(pts[i].clone().sub(s0), pts[i].clone().add(s0), pts[i + 1].clone().add(s1), pts[i + 1].clone().sub(s1),
      [nrm(i), nrm(i), nrm(i + 1), nrm(i + 1)], [col(i), col(i), col(i + 1), col(i + 1)], [0, i / n, 1, (i + 1) / n]);
  }
}

/* ======================================================================
   Procedural canvases (cached)
   ====================================================================== */
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

const leafCanvas = () => memo("cv:leaf", () => makeCanvas(256, 256, (g, w, h) => {
  const r = rng(11);
  for (let i = 0; i < 520; i++) {
    const ang = r() * Math.PI * 2, rad = Math.pow(r(), 0.65) * 118;
    const x = w / 2 + Math.cos(ang) * rad, y = h / 2 + Math.sin(ang) * rad;
    const len = 7 + r() * 7, wid = 3 + r() * 3;
    g.save(); g.translate(x, y); g.rotate(ang + (r() - 0.5) * 1.6);
    g.fillStyle = hsl(78 + r() * 34, 30 + r() * 28, 20 + r() * 26);
    g.beginPath(); g.ellipse(0, 0, len, wid, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255,255,220,0.12)";
    g.beginPath(); g.ellipse(0, -wid * 0.3, len * 0.8, wid * 0.4, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
}));
const needleCanvas = () => memo("cv:needle", () => makeCanvas(256, 128, (g, w, h) => {
  const r = rng(12);
  const needles = (x0, y0, ang, len, size) => {
    for (let t = 0; t < len; t += 1.5) {
      const x = x0 + Math.cos(ang) * t, y = y0 + Math.sin(ang) * t;
      for (const sgn of [-1, 1]) {
        const a = ang + sgn * (0.9 + r() * 0.5), l = size * (0.7 + r() * 0.5) * (1 - 0.5 * t / len);
        g.strokeStyle = hsl(110 + r() * 35, 22 + r() * 22, 9 + r() * 17);
        g.lineWidth = 1.4; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
    }
  };
  g.lineCap = "round";
  g.strokeStyle = "#4a3422"; g.lineWidth = 3; g.beginPath(); g.moveTo(2, h / 2); g.lineTo(w - 6, h / 2); g.stroke();
  for (let x = 8; x < w - 24; x += 9) {
    const f = 1 - x / w;
    for (const sgn of [-1, 1]) {
      const a = sgn * (0.5 + r() * 0.35), len = (12 + 44 * f) * (0.8 + r() * 0.4);
      needles(x, h / 2, a, len, 7 + 4 * f);
    }
  }
  needles(2, h / 2, 0, w - 8, 12);
}));
// tileable conifer "skirt": hanging needle sprays with a ragged lower edge
const skirtCanvas = () => memo("cv:skirt", () => makeCanvas(256, 256, (g, w, h) => {
  const r = rng(17);
  g.lineCap = "round";
  // dark, nearly opaque body so the cone reads as a dense mass; needle sprays and a ragged edge on top
  const body = g.createLinearGradient(0, 0, 0, h * 0.7);
  body.addColorStop(0, hsl(125, 30, 9)); body.addColorStop(1, hsl(125, 30, 6));
  g.fillStyle = body; g.fillRect(0, 0, w, h * 0.62);
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 230; i++) {
    const x = r() * w, y0 = r() * h * 0.6, ang = Math.PI / 2 + (r() - 0.5) * 0.6;
    const L = (h * (0.8 + r() * 0.18) - y0) / Math.sin(ang) * (0.5 + r() * 0.5);
    wrapDraw(w, 0.0001, x, y0, (X) => {
      for (let t = 0; t < L; t += 1.7) {
        const px = X + Math.cos(ang) * t, py = y0 + Math.sin(ang) * t, tip = t / L;
        for (const sgn of [-1, 1]) {
          const a = ang + sgn * (0.75 + r() * 0.5), l = (5 + r() * 5) * (1 - 0.35 * tip);
          const light = pass === 0 ? 5 + r() * 10 : 10 + r() * 14 + 16 * tip * r();
          g.strokeStyle = hsl(105 + r() * 40, 22 + r() * 20, light); g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); g.stroke();
        }
      }
    });
  }
}));
const barkCanvas = () => memo("cv:bark", () => makeCanvas(128, 256, (g, w, h) => {
  const r = rng(13);
  g.fillStyle = "#5a4636"; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 260; i++) {
    const x = r() * w, y = r() * h, l = 20 + r() * 80;
    g.strokeStyle = r() < 0.5 ? `rgba(20,14,10,${0.25 + r() * 0.4})` : `rgba(150,130,110,${0.12 + r() * 0.2})`;
    g.lineWidth = 1 + r() * 3;
    wrapDraw(w, h, x, y, (X, Y) => { g.beginPath(); g.moveTo(X, Y); g.bezierCurveTo(X + (r() - 0.5) * 6, Y + l / 3, X + (r() - 0.5) * 6, Y + 2 * l / 3, X + (r() - 0.5) * 4, Y + l); g.stroke(); });
  }
}));
const palmLeafCanvas = () => memo("cv:palm", () => makeCanvas(128, 512, (g, w, h) => {
  const r = rng(14);
  g.lineCap = "round";
  for (let y = 18; y < h - 6; y += 4.2) {
    const f = y / h, len = 58 * Math.sin(Math.PI * Math.min(1, f * 1.15 + 0.08)) * (0.85 + r() * 0.2);
    for (const sgn of [-1, 1]) {
      g.strokeStyle = hsl(95 + r() * 10, 55, 34 + r() * 6);
      g.lineWidth = 5 * (1 - f * 0.5);
      g.beginPath(); g.moveTo(w / 2, y); g.quadraticCurveTo(w / 2 + sgn * len * 0.6, y + len * 0.15, w / 2 + sgn * len, y + len * 0.55); g.stroke();
    }
  }
  g.strokeStyle = "#9a9a40"; g.lineWidth = 5; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
}));
const fernCanvas = () => memo("cv:fern", () => makeCanvas(64, 256, (g, w, h) => {
  const r = rng(15);
  for (let y = 6; y < h - 2; y += 5) {
    const f = y / h, len = 28 * Math.sin(Math.PI * Math.min(1, f * 0.9 + 0.12));
    for (const sgn of [-1, 1]) {
      g.fillStyle = hsl(100 + r() * 8, 55, 36 + r() * 5);
      g.save(); g.translate(w / 2, y); g.rotate(sgn * 1.15);
      g.beginPath(); g.ellipse(0, -len / 2, 2.6, len / 2, 0, 0, Math.PI * 2); g.fill(); g.restore();
    }
  }
  g.strokeStyle = "#4d6b2a"; g.lineWidth = 2; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
}));
// lavender: bottom band opaque (bush mound), above it a bud spike silhouette (white, tinted by vertex colour)
const lavCanvas = () => memo("cv:lav", () => makeCanvas(64, 256, (g, w, h) => {
  const r = rng(16);
  g.fillStyle = "#cfcfcf"; g.fillRect(0, h - 16, w, 16);
  for (let y = 20; y < h - 30; y += 4) {
    const f = 1 - y / (h - 30), rad = 5 + 9 * f;
    for (let k = 0; k < 3; k++) {
      const l = 55 + r() * 45;
      g.fillStyle = `rgb(${l * 2.4},${l * 2.4},${l * 2.55})`;
      g.beginPath(); g.ellipse(w / 2 + (r() - 0.5) * rad * 1.4, y + r() * 3, rad * 0.55, rad * 0.45, 0, 0, Math.PI * 2); g.fill();
    }
  }
  g.fillStyle = "#bbbbbb"; g.fillRect(w / 2 - 1.5, h - 30, 3, 16);
}));
// greyscale ground detail textures (hue comes from vertex colours)
const grassDetailCanvas = () => memo("cv:grass", () => makeCanvas(512, 512, (g, w, h) => {
  const r = rng(21);
  g.fillStyle = "#8c8c8c"; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 160; i++) {
    const x = r() * w, y = r() * h, rad = 20 + r() * 60, v = r() < 0.5 ? 0 : 255;
    wrapDraw(w, h, x, y, (X, Y) => {
      const gr = g.createRadialGradient(X, Y, 0, X, Y, rad);
      gr.addColorStop(0, `rgba(${v},${v},${v},0.07)`); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.fillRect(X - rad, Y - rad, rad * 2, rad * 2);
    });
  }
  g.lineCap = "round";
  for (let i = 0; i < 9000; i++) {
    const x = r() * w, y = r() * h, a = r() * Math.PI * 2, l = 4 + r() * 10;
    const v = 70 + r() * 150, warm = r() < 0.18 ? 18 : 0;
    g.strokeStyle = `rgb(${v + warm},${v + warm * 0.6},${v - warm})`; g.lineWidth = 1 + r() * 1.4;
    wrapDraw(w, h, x, y, (X, Y) => { if (X < -20 || Y < -20 || X > w + 20 || Y > h + 20) return; g.beginPath(); g.moveTo(X, Y); g.lineTo(X + Math.cos(a) * l, Y + Math.sin(a) * l); g.stroke(); });
  }
}));
const sandCanvas = () => memo("cv:sand", () => makeCanvas(512, 512, (g, w, h) => {
  const r = rng(22), img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rip = Math.sin(2 * Math.PI * (y * 10 / h + 0.35 * Math.sin(2 * Math.PI * x * 2 / w) + 0.12 * Math.sin(2 * Math.PI * (x * 5 / w + y * 3 / h))));
    const v = 205 + rip * 9 + (r() - 0.5) * 34 + (r() < 0.02 ? -50 : 0);
    const i = (y * w + x) * 4; d[i] = v + 6; d[i + 1] = v; d[i + 2] = v - 10; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}));
const soilCanvas = () => memo("cv:soil", () => makeCanvas(512, 512, (g, w, h) => {
  const r = rng(23);
  g.fillStyle = "#9a9188"; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) {
    const x = r() * w, y = r() * h, rx = 2 + r() * 9, ry = rx * (0.5 + r() * 0.5), v = 90 + r() * 120;
    g.fillStyle = `rgba(${v},${v * 0.95},${v * 0.9},${0.35 + r() * 0.5})`;
    wrapDraw(w, h, x, y, (X, Y) => { g.beginPath(); g.ellipse(X, Y, rx, ry, r() * 3, 0, Math.PI * 2); g.fill(); });
  }
  for (let i = 0; i < 4000; i++) { const v = r() < 0.5 ? 60 : 220; g.fillStyle = `rgba(${v},${v},${v},0.5)`; g.fillRect(r() * w, r() * h, 1.5, 1.5); }
}));
// plank floor: colour + roughness from one per-pixel pass
const plankCanvases = () => memo("cv:planks", () => {
  const W = 512, H = 1024, PL = 6, pw = W / PL, r = rng(31);
  const col = document.createElement("canvas"), rough = document.createElement("canvas");
  col.width = rough.width = W; col.height = rough.height = H;
  const ci = col.getContext("2d").createImageData(W, H), ri = rough.getContext("2d").createImageData(W, H);
  const planks = [...Array(PL)].map((_, i) => ({ l: 0.85 + r() * 0.3, hue: r(), cut: (0.15 + r() * 0.7) * H, seed: r() * 50 }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const pi = Math.floor(x / pw), P = planks[pi], lx = x - pi * pw;
    const seg = y < P.cut ? 0 : 1, sd = P.seed + seg * 13;
    const warp = noise(lx * 0.015 + sd, y * 0.0025, sd) * 30 + noise(lx * 0.06, y * 0.02, sd + 3) * 3;
    const ring = 0.5 + 0.5 * Math.sin((lx + warp) * 0.42);
    const fine = noise(lx * 0.4, y * 0.01, sd + 7);
    let v = (0.9 + ring * 0.05 + fine * 0.02) * P.l * (seg ? 0.96 : 1.03);
    const edge = Math.min(lx, pw - 1 - lx), cutD = Math.abs(y - P.cut);
    if (edge < 1.2 || cutD < 1.2 || y < 1 || y > H - 2) v *= 0.35;
    const i = (y * W + x) * 4;
    ci.data[i] = 190 * v + 14 * P.hue; ci.data[i + 1] = 120 * v + 6 * P.hue; ci.data[i + 2] = 70 * v; ci.data[i + 3] = 255;
    const rv = 150 + ring * 40 - fine * 30 + (edge < 1.2 || cutD < 1.2 ? 80 : 0);
    ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = rv; ri.data[i + 3] = 255;
  }
  col.getContext("2d").putImageData(ci, 0, 0); rough.getContext("2d").putImageData(ri, 0, 0);
  return { col, rough };
});
const woodCanvas = () => memo("cv:wood", () => makeCanvas(256, 256, (g, w, h) => {
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const warp = noise(x * 0.02, y * 0.004, 5.5) * 24;
    const ring = 0.5 + 0.5 * Math.sin((x + warp) * 0.5), v = 0.8 + ring * 0.15 + noise(x * 0.5, y * 0.02, 8) * 0.07;
    const i = (y * w + x) * 4; d[i] = 168 * v; d[i + 1] = 116 * v; d[i + 2] = 72 * v; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}));
const plasterCanvas = () => memo("cv:plaster", () => makeCanvas(256, 256, (g, w, h) => {
  const img = g.createImageData(w, h), d = img.data, r = rng(33);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // periodic noise via 4-corner blend so it tiles
    const u = x / w, v = y / h, s = 6;
    const n = (a, b) => noise(a * s, b * s, 2.2) + 0.5 * noise(a * s * 3, b * s * 3, 4.4);
    const val = n(u, v) * (1 - u) * (1 - v) + n(u - 1, v) * u * (1 - v) + n(u, v - 1) * (1 - u) * v + n(u - 1, v - 1) * u * v;
    const k = 240 + val * 8 + (r() - 0.5) * 3;
    const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = k; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}));
const rugCanvas = () => memo("cv:rug", () => makeCanvas(512, 352, (g, w, h) => {
  const r = rng(34);
  g.fillStyle = "#7d2a24"; g.fillRect(0, 0, w, h);
  const band = (inset, col, t) => { g.strokeStyle = col; g.lineWidth = t; g.strokeRect(inset, inset, w - inset * 2, h - inset * 2); };
  band(10, "#2c3550", 14); band(26, "#d9b98a", 5); band(38, "#2c3550", 8);
  g.save(); g.translate(w / 2, h / 2);
  for (const [s, col] of [[120, "#2c3550"], [92, "#c88a3a"], [64, "#7d2a24"], [38, "#d9b98a"], [16, "#2c3550"]]) {
    g.fillStyle = col; g.beginPath(); g.moveTo(-s * 1.4, 0); g.lineTo(0, -s * 0.8); g.lineTo(s * 1.4, 0); g.lineTo(0, s * 0.8); g.closePath(); g.fill();
  }
  g.restore();
  for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) {
    g.fillStyle = k % 2 ? "#d9b98a" : "#c88a3a";
    const cx = w / 2 + sx * (175 + 0), cy = 70 + k * 70;
    g.beginPath(); g.moveTo(cx - 18, cy); g.lineTo(cx, cy - 18); g.lineTo(cx + 18, cy); g.lineTo(cx, cy + 18); g.closePath(); g.fill();
  }
  for (let i = 0; i < 26000; i++) { g.fillStyle = r() < 0.5 ? "rgba(0,0,0,0.08)" : "rgba(255,240,220,0.06)"; g.fillRect(r() * w, r() * h, 2, 1); }
}));
// small impressionist landscape for frames on the wall
const paintingCanvas = (seed) => memo("cv:painting" + seed, () => makeCanvas(256, 192, (g, w, h) => {
  const r = rng(100 + seed), pal = [
    ["#9cc3dd", "#f3e2b8", "#6f8f4e", "#3d5a35", "#e7b04a"],
    ["#e9a46b", "#f6d39b", "#7a6a8f", "#3b3550", "#f2c14e"],
    ["#b7d3c6", "#eef0e0", "#4d7a8a", "#24414d", "#d76f4c"],
  ][seed % 3];
  const sky = g.createLinearGradient(0, 0, 0, h * 0.6); sky.addColorStop(0, pal[0]); sky.addColorStop(1, pal[1]);
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  g.fillStyle = pal[4]; g.beginPath(); g.arc(w * (0.2 + r() * 0.6), h * 0.3, 14, 0, 7); g.fill();
  for (let L = 0; L < 3; L++) {
    g.fillStyle = [pal[2], pal[3], pal[3]][L]; g.globalAlpha = 0.9;
    g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) g.lineTo(x, h * (0.45 + L * 0.15) + Math.sin(x * 0.02 + L * 2 + seed) * 14 + (r() - 0.5) * 6);
    g.lineTo(w, h); g.fill();
  }
  g.globalAlpha = 1;
  for (let i = 0; i < 900; i++) {
    const x = r() * w, y = r() * h, c = pal[Math.floor(r() * 5)];
    g.fillStyle = c; g.globalAlpha = 0.18; g.fillRect(x, y, 3 + r() * 6, 2 + r() * 3);
  }
  g.globalAlpha = 1;
}));
const foamCanvas = () => memo("cv:foam", () => makeCanvas(512, 64, (g, w, h) => {
  const r = rng(35);
  g.clearRect(0, 0, w, h);
  for (let i = 0; i < 1800; i++) {
    const x = r() * w, y = h * (0.15 + 0.7 * Math.pow(r(), 1.6)), a = 0.25 + r() * 0.5;
    g.fillStyle = `rgba(255,255,255,${a * (1 - y / h)})`;
    wrapDraw(w, 0.0001, x, y, (X) => { g.beginPath(); g.ellipse(X, y, 3 + r() * 10, 1 + r() * 2, 0, 0, 7); g.fill(); });
  }
}));

/* ======================================================================
   Vegetation & rock geometries (cached per variant)
   groups: [0] bark/solid, [1] core (vertex colour), [2] leaf cards
   ====================================================================== */
// Stylized ("realistic cartoon") trees: smooth, slightly squashed blob canopies and stacked rounded cones,
// coloured with soft vertex gradients (shadowed underside → sunlit top) instead of leaf textures.
const blobColor = (base, top, centre, rad, tint = 1) => (p, n) => {
  const y = clamp((p.y - (centre.y - rad.y)) / (2 * rad.y), 0, 1), up = clamp(n.y * 0.5 + 0.5, 0, 1);
  return base.clone().lerp(top, y * 0.6 + up * 0.4).multiplyScalar(tint * (0.72 + 0.28 * up));
};
function broadleafGeo(seed, bush = false, lite = false) {
  return memo(`geo:broad:${seed}:${bush}:${lite}`, () => {
    const r = rng(seed), bark = new Parts(), core = new Parts(), leaf = new Parts();
    const barkC = C("#7a5236");
    const H = bush ? 0 : 3.4 + r() * 1.2;
    const rad = bush ? new V3(0.8, 0.6, 0.8) : new V3(2.5 + r() * 0.8, 2.2 + r() * 0.6, 2.5 + r() * 0.8);
    const crown = bush ? new V3(0, 0.45, 0) : new V3((r() - 0.5) * 0.5, H + rad.y * 0.85, (r() - 0.5) * 0.5);
    if (!bush) {
      const top = new V3(crown.x * 0.6, H + 1.0, crown.z * 0.6);
      limb(bark, new V3(0, -0.3, 0), new V3(0, 0.5, 0), 0.46, 0.3, barkC, 10);
      limb(bark, new V3(0, 0.45, 0), top, 0.3, 0.18, barkC, 10);
      for (let k = 0; k < 3; k++) {
        const a = k * 2.1 + r(), from = new V3(0, H * 0.8, 0);
        limb(bark, from, crown.clone().add(new V3(Math.cos(a) * rad.x * 0.45, -rad.y * 0.2, Math.sin(a) * rad.z * 0.45)), 0.13, 0.07, barkC, 7);
      }
    }
    const base = C(bush ? "#3f7d2c" : "#3d7a2a"), top = C(bush ? "#9ccc4a" : "#a6d150");
    const n = bush ? 4 : lite ? 4 : 5 + Math.floor(r() * 2), tint = 0.92 + r() * 0.16;
    // central mass + puffs around it
    const puffs = [[crown.clone(), rad.clone().multiplyScalar(0.78)]];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + r() * 0.6, up = (r() - 0.3) * 0.9;
      const d = new V3(Math.cos(a), up, Math.sin(a)).normalize();
      const pr = (bush ? 0.5 : 0.55) * (0.75 + r() * 0.35);
      puffs.push([crown.clone().add(d.multiply(rad).multiplyScalar(0.55)), rad.clone().multiplyScalar(pr).setY(rad.y * pr * 0.85)]);
    }
    for (const [c, rr] of puffs) core.geo(new THREE.IcosahedronGeometry(1, lite ? 1 : 2), m4(c, null, rr), blobColor(base, top, crown, rad, tint));
    return groupsGeometry([bark, core, leaf]);
  });
}
function coniferGeo(seed, slim = false, far = false) {
  return memo(`geo:conifer:${seed}:${slim}:${far}`, () => {
    const r = rng(seed), bark = new Parts(), core = new Parts(), leaf = new Parts(), skirt = new Parts();
    const H = slim ? 9 + r() * 3 : 10 + r() * 3, base = slim ? 0.6 : 1.2, R0 = slim ? 1.0 : 2.5 + r() * 0.5;
    if (!far) limb(bark, new V3(0, -0.3, 0), new V3(0, base + 1, 0), slim ? 0.2 : 0.3, 0.2, C("#6e4a30"), 8);
    const lo = C(slim ? "#24502c" : "#1f5a3a"), hi = C(slim ? "#5f9a45" : "#58a35a");
    const tiers = far ? 3 : slim ? 4 : 5, seg = far ? 7 : 16;
    for (let t = 0; t < tiers; t++) {
      const f = t / tiers, y0 = base + f * (H - base) * 0.82, R = R0 * Math.pow(1 - f, slim ? 0.6 : 0.85) * (0.95 + r() * 0.1) + 0.3;
      const hh = (H - base) / tiers * 1.75;
      const cg = new THREE.ConeGeometry(R, hh, seg, far ? 1 : 3);
      const P = cg.attributes.position;
      for (let i = 0; i < P.count; i++) {        // round the cone: bulge the flanks, tuck the rim under
        const ty = P.getY(i) / hh + 0.5, k = 1 + 0.18 * Math.sin(Math.PI * Math.min(1, (1 - ty) * 1.25));
        P.setXYZ(i, P.getX(i) * k, P.getY(i) - (ty < 0.02 ? 0.15 * R : 0), P.getZ(i) * k);
      }
      cg.computeVertexNormals();
      const c = new V3(0, y0 + hh / 2, 0), rad = new V3(R, hh / 2, R);
      core.geo(cg, m4(c), (p, nn) => lo.clone().lerp(hi, clamp(0.25 + 0.5 * f + 0.4 * nn.y, 0, 1)).multiplyScalar(0.75 + 0.25 * clamp(nn.y + 0.5, 0, 1)));
    }
    return groupsGeometry([bark, core, leaf, skirt]);
  });
}
function palmGeo(seed) {
  return memo(`geo:palm:${seed}`, () => {
    const r = rng(seed), bark = new Parts(), core = new Parts(), leaf = new Parts();
    const L = 6.5 + r() * 2.5, lean = 0.22 + r() * 0.2;
    const at = (t) => new V3(lean * L * Math.pow(t, 1.7), L * t, 0);
    const N = 16;
    for (let i = 0; i < N; i++) {
      const a = at(i / N), b = at((i + 1) / N), rr = 0.2 * (1 - 0.35 * i / N);
      const sh = i % 2 ? 0.82 : 1.0;
      limb(bark, a, b.clone().addScaledVector(b.clone().sub(a), 0.04), rr * 1.15, rr * 0.92, C("#a07850").multiplyScalar(sh), 10);
    }
    const top = at(1);
    const nutC = C("#4a3a1c");
    for (let k = 0; k < 4; k++) {
      const a = k * 1.7 + r();
      core.geo(new THREE.SphereGeometry(0.11, 8, 6), m4(top.clone().add(new V3(Math.cos(a) * 0.17, -0.22 - r() * 0.1, Math.sin(a) * 0.17))), nutC);
    }
    core.geo(new THREE.SphereGeometry(0.24, 8, 6), m4(top.clone().add(new V3(0, -0.05, 0)), null, new V3(1, 0.7, 1)), C("#5a4a26"));
    const nf = 11 + Math.floor(r() * 3);
    for (let k = 0; k < nf; k++) {
      const a = (k / nf) * Math.PI * 2 + r() * 0.35, hd = new V3(Math.cos(a), 0, Math.sin(a));
      const len = 3.2 + r() * 1.1, e0 = 0.35 + r() * 0.5, seg = 7, pts = [];
      for (let j = 0; j <= seg; j++) {
        const s = (j / seg) * len;
        pts.push(top.clone().addScaledVector(hd, s * Math.cos(e0) * 0.95).add(new V3(0, s * Math.sin(e0) - 0.16 * s * s, 0)));
      }
      const sideV = new V3(-hd.z, 0, hd.x);
      const tint = 0.85 + r() * 0.25;
      strip(leaf, pts, (i) => sideV.clone().multiplyScalar(0.62).add(new V3(0, -0.12, 0)), () => new V3(0, 1, 0).addScaledVector(hd, 0.25).normalize(),
        (i) => { const s = tint * (0.75 + 0.3 * i / seg); return new THREE.Color(s, s, s * 0.9); });
    }
    return groupsGeometry([bark, core, leaf]);
  });
}
function fernGeo(seed) {
  return memo(`geo:fern:${seed}`, () => {
    const r = rng(seed), p = new Parts(), nf = 9;
    for (let k = 0; k < nf; k++) {
      const a = (k / nf) * Math.PI * 2 + r() * 0.5, hd = new V3(Math.cos(a), 0, Math.sin(a));
      const len = 0.6 + r() * 0.35, e0 = 0.9 + r() * 0.35, seg = 5, pts = [];
      for (let j = 0; j <= seg; j++) { const s = (j / seg) * len; pts.push(hd.clone().multiplyScalar(s * Math.cos(e0) * 1.25).add(new V3(0, s * Math.sin(e0) - 0.75 * s * s, 0))); }
      const sideV = new V3(-hd.z, 0, hd.x).multiplyScalar(0.12);
      strip(p, pts, () => sideV, () => UP, (i) => { const s = 0.7 + 0.35 * i / seg; return new THREE.Color(s, s, s); });
    }
    return p.build();
  });
}
// grass blade, unit height; curve bends it forward
function bladeGeo(width = 0.05, curve = 0.25, segs = 3, key = "blade") {
  return memo(`geo:${key}:${width}:${curve}`, () => {
    const p = new Parts(), pts = [];
    for (let i = 0; i <= segs; i++) { const t = i / segs; pts.push(new V3(0, t, curve * t * t)); }
    strip(p, pts, (i) => new V3(width * 0.5 * Math.pow(1 - i / segs, 0.7) + 0.0005, 0, 0), () => UP, (i) => { const s = 0.35 + 0.65 * i / segs; return new THREE.Color(s, s, s); });
    return p.build();
  });
}
// a tuft of thin blades (unit height), leaning outward
function tuftGeo(n = 5, width = 0.032, key = "tuft") {
  return memo(`geo:${key}:${n}:${width}`, () => {
    const r = rng(n * 31 + Math.round(width * 1000)), p = new Parts();
    for (let k = 0; k < n; k++) {
      const a = r() * 6.28, lean = 0.12 + r() * 0.3, hgt = 0.55 + r() * 0.45, off = new V3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(r() * 0.05);
      const out = new V3(Math.cos(a), 0, Math.sin(a)), side = new V3(-out.z, 0, out.x), pts = [];
      for (let i = 0; i <= 2; i++) { const t = i / 2; pts.push(off.clone().addScaledVector(out, (lean * t + 0.25 * t * t) * hgt).setY(t * hgt * (1 - 0.15 * t))); }
      strip(p, pts, (i) => side.clone().multiplyScalar(width * 0.5 * (i === 2 ? 0.05 : i === 1 ? 0.75 : 1)), () => UP, (i) => { const s = 0.55 + 0.45 * i / 2; return new THREE.Color(s, s, s * (0.8 + 0.2 * i / 2)); });
    }
    return p.build();
  });
}
function reedGeo(withHead) {
  return memo(`geo:reed:${withHead}`, () => {
    const r = rng(withHead ? 7 : 8), p = new Parts();
    const col = (k) => (i) => { const s = 0.4 + 0.6 * i / 4; return new THREE.Color(0.3 * s * k, 0.42 * s * k, 0.2 * s * k); };
    for (let k = 0; k < 7; k++) {
      const a = r() * 6.28, out = new V3(Math.cos(a), 0, Math.sin(a)), side = new V3(-out.z, 0, out.x);
      const lean = 0.04 + r() * 0.14, hgt = 0.55 + r() * 0.45, off = out.clone().multiplyScalar(r() * 0.07), pts = [];
      for (let i = 0; i <= 4; i++) { const t = i / 4; pts.push(off.clone().addScaledVector(out, (lean * t + 0.12 * t * t) * hgt).setY(t * hgt)); }
      strip(p, pts, (i) => side.clone().multiplyScalar(0.012 * (1 - i / 4) + 0.001), () => UP, col(0.85 + r() * 0.3));
    }
    if (withHead) for (let k = 0; k < 2; k++) {
      const x = (r() - 0.5) * 0.08, z = (r() - 0.5) * 0.08, hgt = 0.9 + r() * 0.15;
      p.geo(new THREE.CylinderGeometry(0.004, 0.005, hgt, 4, 1, true), m4(new V3(x, hgt / 2, z)), C("#4d5a2c"));
      p.geo(new THREE.CylinderGeometry(0.016, 0.016, 0.12, 7), m4(new V3(x, hgt - 0.1, z)), C("#3a2312"));
    }
    return p.build();
  });
}
function lavenderGeo(seed, near) {
  return memo(`geo:lav:${seed}:${near}`, () => {
    const r = rng(seed), p = new Parts(), green = C("#6f9a5a");
    p.geo(new THREE.IcosahedronGeometry(1, 0), m4(new V3(0, near ? 0.1 : 0.14, 0), null, near ? new V3(0.34, 0.22, 0.34) : new V3(0.42, 0.3, 0.42)),
      (q) => { const k = 0.55 + 0.45 * clamp(q.y / 0.4, 0, 1); return near ? green.clone().multiplyScalar(k) : green.clone().lerp(C("#7a5fae"), clamp(q.y / 0.4, 0, 1) * 0.85).multiplyScalar(k); }, [0.5, 0.03]);
    if (near) {
      const purples = ["#8a5ee0", "#9a6af0", "#a77ef2", "#7f52d6", "#b48af5"].map(C);
      for (let i = 0; i < 40; i++) {
        const a = r() * 6.28, rr = Math.sqrt(r()) * 0.34, base = new V3(Math.cos(a) * rr, 0.08 + 0.18 * (1 - rr / 0.34), Math.sin(a) * rr);
        const dir = new V3(Math.cos(a) * rr * 2.2, 1, Math.sin(a) * rr * 2.2).normalize(), len = 0.36 + r() * 0.2;
        const top = base.clone().addScaledVector(dir, len), pc = purples[Math.floor(r() * purples.length)];
        for (const rot of [0, Math.PI / 2]) {
          const side = new V3(Math.cos(a + rot), 0, Math.sin(a + rot)).multiplyScalar(0.036);
          const cb = C("#4f6040"), ct = pc;
          p.quad(base.clone().sub(side), base.clone().add(side), top.clone().add(side), top.clone().sub(side), [UP, UP, UP, UP], [cb, cb, ct, ct], [0, 0.08, 1, 1]);
        }
      }
    }
    return p.build();
  });
}
function rockGeo(seed) {
  return memo(`geo:rock:${seed}`, () => {
    let g = new THREE.IcosahedronGeometry(1, 3); g.deleteAttribute("normal"); g.deleteAttribute("uv");
    g = mergeVertices(g);
    const P = g.attributes.position, v = new V3(), dent = new Float32Array(P.count);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      const fine = noise(v.x * 5, v.y * 5 + seed, v.z * 5) + 0.5 * noise(v.x * 11, v.y * 11, v.z * 11 + seed);
      const d = 1 + 0.22 * fbm(v.x * 0.9 + seed, v.z * 0.9 + v.y * 0.6, 2, seed) + 0.01 * fine;
      dent[i] = fine;
      v.multiplyScalar(d); v.y *= 0.62; if (v.y < -0.15) v.y = -0.15 + (v.y + 0.15) * 0.3;
      P.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    const N = g.attributes.normal, cols = new Float32Array(P.count * 3), base = C("#a39c92"), moss = C("#6f9a3e"), c = new THREE.Color();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      const k = 0.8 + 0.25 * clamp(N.getY(i), -1, 1);
      c.copy(base).multiplyScalar(k).lerp(moss, sstep(0.55, 0.9, N.getY(i)) * 0.55 * (seed % 3 === 0 ? 1 : 0.4));
      cols.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    return g;
  });
}

/* ======================================================================
   Instancing helpers
   ====================================================================== */
const _o = new THREE.Object3D();
function instanced(ctx, geo, mat, items, { cast = false, receive = true, chunk = 0 } = {}) {
  if (!items.length) return [];
  if (chunk) {            // spatial chunks so frustum culling (main + shadow camera) works
    const map = new Map();
    for (const it of items) { const k = Math.floor(it.x / chunk) + "," + Math.floor(it.z / chunk); if (!map.has(k)) map.set(k, []); map.get(k).push(it); }
    return [...map.values()].flatMap((list) => instanced(ctx, geo, mat, list, { cast, receive }));
  }
  const m = new THREE.InstancedMesh(geo, mat, items.length);
  items.forEach((it, i) => {
    _o.position.set(it.x, it.y, it.z); _o.rotation.set(it.rx || 0, it.ry || 0, it.rz || 0);
    _o.scale.set(it.sx ?? it.s ?? 1, it.sy ?? it.s ?? 1, it.sz ?? it.sx ?? it.s ?? 1); _o.updateMatrix();
    m.setMatrixAt(i, _o.matrix); if (it.c) m.setColorAt(i, it.c);
  });
  m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.computeBoundingSphere(); m.castShadow = cast; m.receiveShadow = receive;
  ctx.add(m); return [m];
}
// materials for the tree families (one set per build)
function vegetationMats(ctx) {
  const bark = foliageMat({ vertexColors: true, roughness: 0.85 }, 0.00025, false);
  const core = foliageMat({ vertexColors: true, roughness: 0.75, specularIntensity: 0.25 }, 0.00025, false);
  const leafOpts = { vertexColors: true, roughness: 0.82, side: THREE.DoubleSide, alphaTest: 0.45, alphaToCoverage: true };
  return {
    broad: [bark, core, core],
    conifer: [bark, core, core, core],
    palm: [bark, core, foliageMat({ ...leafOpts, map: ctx.tex(palmLeafCanvas(), { wrap: false }), alphaTest: 0.35 }, 0.0006)],
    fern: foliageMat({ ...leafOpts, map: ctx.tex(fernCanvas(), { wrap: false }), alphaTest: 0.4 }, 0.06),
    grass: foliageMat({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }, 0.045),
    rock: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }),
  };
}
// trees: items [{x,z,s,kind:'broad'|'conifer'|'slim'|'palm', ry}] with y from height()
function plantTrees(ctx, mats, items, height, { cast = false } = {}) {
  const byKey = new Map();
  for (const it of items) {
    const v = it.variant ?? Math.floor(Math.abs(Math.sin(it.x * 12.9898 + it.z * 78.233)) * 3);
    const lite = Math.hypot(it.x, it.z) > 60 && (it.kind === "broad" || it.kind === "conifer");
    const key = it.kind + ":" + v + (lite ? ":lite" : "");
    if (!byKey.has(key)) byKey.set(key, []);
    const t = 0.82 + Math.abs(Math.sin(it.x * 3.1 + it.z * 1.7)) * 0.3;
    byKey.get(key).push({ x: it.x, y: height(it.x, it.z) - 0.05, z: it.z, s: it.s, sy: it.s * (it.sy || 1), ry: it.ry ?? (it.x * 7.7 + it.z * 3.3) % 6.28,
      c: it.c || new THREE.Color(t, t * (0.96 + 0.08 * Math.sin(it.x)), t * 0.95) });
  }
  for (const [key, list] of byKey) {
    const [kind, v, lite] = key.split(":"), seed = 300 + Number(v) * 17;
    const geo = kind === "broad" ? broadleafGeo(seed, false, !!lite) : kind === "conifer" && lite ? coniferGeo(seed, false, true) : kind === "bush" ? broadleafGeo(seed + 5, true) : kind === "palm" ? palmGeo(seed) : coniferGeo(seed, kind === "slim", kind === "far");
    const mat = kind === "palm" ? mats.palm : kind === "broad" || kind === "bush" ? mats.broad : mats.conifer;
    instanced(ctx, geo, mat, list, { cast });
  }
}
// scatter helper: poisson-ish rejection inside a sampler
function scatter(n, r, sample, minDist = 0, tries = 30) {
  const out = [], grid = new Map(), cs = Math.max(minDist, 0.001);
  const key = (x, z) => Math.floor(x / cs) + "," + Math.floor(z / cs);
  for (let i = 0; i < n * tries && out.length < n; i++) {
    const p = sample(r); if (!p) continue;
    if (minDist) {
      let ok = true;
      const gx = Math.floor(p.x / cs), gz = Math.floor(p.z / cs);
      for (let dx = -1; dx <= 1 && ok; dx++) for (let dz = -1; dz <= 1 && ok; dz++) {
        for (const q of grid.get(gx + dx + "," + (gz + dz)) || []) if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < minDist * minDist) { ok = false; break; }
      }
      if (!ok) continue;
      const k = key(p.x, p.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p);
    }
    out.push(p);
  }
  return out;
}
function addGrass(ctx, mats, { count, outer, height, colA, colB, hMin = 0.12, hMax = 0.4, accept = () => true, seed = 5, keepOut = 0.25 }) {
  const r = rng(seed), A = C(colA), B = C(colB), items = [], cx = -0.2, cz = 1.3;
  for (let i = 0; i < count * 6 && items.length < count; i++) {
    const x = cx + (r() * 2 - 1) * outer, z = cz + (r() * 2 - 1) * outer;
    if (inWork(x, z, keepOut)) {     // inside the work area: only a very short lawn (≤3 cm), never through the easel
      if (!inWork(x, z, -0.05) || !accept(x, z) || r() > 0.5) continue;
      const w = 0.6 + r() * 0.5;
      items.push({ x, y: height(x, z) - 0.005, z, sx: w, sy: 0.015 + r() * 0.015, sz: w, ry: r() * 6.28, c: A.clone().lerp(B, r()).multiplyScalar(0.75 + r() * 0.3) });
      continue;
    }
    const d = workDist(x, z);
    if (r() > Math.exp(-d / (outer * 0.35))) continue;
    const patch = 0.5 + 0.5 * fbm(x * 0.25, z * 0.25, 2, seed);
    if (patch < 0.35 || !accept(x, z)) continue;
    const h = lerp(hMin, hMax, r() * 0.6 + patch * 0.4) * (0.55 + 0.45 * sstep(0, 2.5, d));
    const c = A.clone().lerp(B, r() * 0.7 + (1 - patch) * 0.3).multiplyScalar(0.8 + r() * 0.3);
    const w = 0.7 + r() * 0.6;
    items.push({ x, y: height(x, z) - 0.01, z, sx: w, sy: h, sz: w, ry: r() * 6.28, c });
  }
  const meshes = instanced(ctx, tuftGeo(), mats.grass, items, { chunk: 12 });
  ctx.noReflect.push(...meshes);
  return meshes;
}
function addRocks(ctx, mats, pts, height, cast = true) {
  const items = pts.map((p, i) => ({ x: p.x, y: height(p.x, p.z) - 0.05 * p.s, z: p.z, s: p.s, sy: p.s * (p.flat ?? 1), ry: i * 2.1 }));
  const groups = [[], [], []]; items.forEach((it, i) => groups[i % 3].push(it));
  groups.forEach((g, k) => instanced(ctx, rockGeo(k * 7 + 3), mats.rock, g, { cast }));
}

/* ======================================================================
   Terrain: one big plane with a warped grid (dense near the easel, coarse far away)
   ====================================================================== */
function terrainGeo(key, { R, N, a = 0.03, tile, height, color, extra }) {
  return memo("terrain:" + key, () => {
    const g = new THREE.PlaneGeometry(2, 2, N, N); g.rotateX(-Math.PI / 2);
    const P = g.attributes.position, UV = g.attributes.uv, n = P.count;
    const warp = (u) => Math.sign(u) * (a * Math.abs(u) + (1 - a) * u * u);
    for (let i = 0; i < n; i++) {
      const x = warp(P.getX(i)) * R, z = warp(P.getZ(i)) * R;
      P.setXYZ(i, x, height(x, z), z); UV.setXY(i, x / tile, z / tile);
    }
    g.computeVertexNormals();
    const NOR = g.attributes.normal, cols = new Float32Array(n * 3), c = new THREE.Color();
    const ex = extra ? new Float32Array(n) : null;
    for (let i = 0; i < n; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      color(x, y, z, NOR.getY(i), c); cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
      if (ex) ex[i] = extra(x, y, z);
    }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    if (ex) g.setAttribute("fmask", new THREE.BufferAttribute(ex, 1));
    g.computeBoundingSphere();
    return g;
  });
}
// linear-space mean colour of a canvas (used to fade the detail texture out with distance)
const meanCache = new WeakMap();
function canvasMean(cv) {
  if (!meanCache.has(cv)) {
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data, lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 13) { r += lin(d[i]); g += lin(d[i + 1]); b += lin(d[i + 2]); n++; }
    meanCache.set(cv, [r / n, g / n, b / n]);
  }
  return meanCache.get(cv);
}
// terrain material: tiled detail texture (+bump) that fades to its mean colour with distance (no far tiling/streaks)
function groundMat(ctx, canvas, tile, opts = {}) {
  const map = ctx.tex(canvas, { repeat: [1, 1], aniso: 16 });
  const m = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.96, bumpMap: map, bumpScale: opts.bump ?? 0.3, ...opts.mat });
  const mean = canvasMean(canvas).map((v) => v.toFixed(4)).join(",");
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <map_fragment>", `float dFade = smoothstep(50.0, 240.0, length(vViewPosition));
        vec4 sampledDiffuseColor = texture2D(map, vMapUv);
        diffuseColor.rgb *= mix(mix(vec3(1.0), sampledDiffuseColor.rgb / vec3(${mean}), ${(opts.detail ?? 0.3).toFixed(2)}) * ${(opts.gain ?? 0.85).toFixed(3)}, vec3(1.0), dFade);`)
      .replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps.replace("dHdxy_fwd()", "dHdxy_fwd() * (1.0 - dFade)"));
    opts.patch?.(sh);
  };
  m.customProgramCacheKey = () => "ground-" + mean + (opts.gain ?? "") + (opts.key || "");
  return m;
}
function addTerrain(ctx, key, opts, mat) {
  const mesh = new THREE.Mesh(terrainGeo(key, opts), mat);
  mesh.receiveShadow = true; ctx.add(mesh); return mesh;
}

/* ======================================================================
   Sky, environment map, fog colour, lights
   ====================================================================== */
function makeSky(T, sunDir) {
  const sky = new Sky();
  const m = sky.material;
  m.uniforms.uBright = { value: T.skyBright };
  m.fragmentShader = "uniform float uBright;\n" + m.fragmentShader.replace("gl_FragColor = vec4( retColor, 1.0 );", "gl_FragColor = vec4( retColor * uBright, 1.0 );");
  const u = m.uniforms;
  u.turbidity.value = T.turbidity; u.rayleigh.value = T.rayleigh; u.mieCoefficient.value = T.mie; u.mieDirectionalG.value = T.mieG;
  u.sunPosition.value.copy(sunDir);
  sky.scale.setScalar(3000);
  sky.frustumCulled = false;
  return sky;
}
// three.js ACESFilmic tone mapping on the CPU → linear display colour (what the sky shows on screen)
function acesDisplay(c, exposure) {
  const r0 = c.r * exposure / 0.6, g0 = c.g * exposure / 0.6, b0 = c.b * exposure / 0.6;
  const r = 0.59719 * r0 + 0.35458 * g0 + 0.04823 * b0, g = 0.076 * r0 + 0.90834 * g0 + 0.01566 * b0, b = 0.0284 * r0 + 0.13383 * g0 + 0.83777 * b0;
  const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const R = fit(r), G = fit(g), B = fit(b);
  return new THREE.Color(clamp(1.60475 * R - 0.53108 * G - 0.07367 * B, 0, 1), clamp(-0.10208 * R + 1.10813 * G - 0.00605 * B, 0, 1), clamp(-0.00327 * R - 0.07276 * G + 1.07602 * B, 0, 1));
}
// average linear sky radiance just above the horizon around the camera's view directions
function sampleHorizon(renderer, envScene, sunAz, sunEl) {
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.FloatType });
  const cam = new THREE.PerspectiveCamera(2, 1, 0.1, 100), buf = new Float32Array(64), acc = new THREE.Color(0, 0, 0);
  const prev = renderer.getRenderTarget();
  let n = 0;
  for (const az of [-20, 0, 20, 40, 60, 80]) {
    if (sunEl < 20 && Math.abs(az - sunAz) < 14) continue;
    cam.position.set(0, 0, 0); cam.lookAt(dirFromAzEl(az, 1.5)); cam.updateMatrixWorld();
    renderer.setRenderTarget(rt); renderer.render(envScene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, 4, 4, buf);
    for (let i = 0; i < 16; i++) { acc.r += buf[i * 4]; acc.g += buf[i * 4 + 1]; acc.b += buf[i * 4 + 2]; n++; }
  }
  renderer.setRenderTarget(prev); rt.dispose();
  return acc.multiplyScalar(1 / n);
}
function disposeScene(s) {
  s.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
}
// shadow-casting sun with an orthographic shadow camera fitted tightly to `box`
function addSun(ctx, color, intensity, lightDir, box) {
  const sun = new THREE.DirectionalLight(color, intensity);
  const target = new V3((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2);
  sun.position.copy(target).addScaledVector(lightDir, 40);
  sun.target.position.copy(target);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.025;
  const cam = sun.shadow.camera;
  cam.position.copy(sun.position); cam.lookAt(target); cam.updateMatrixWorld();
  const inv = cam.matrixWorld.clone().invert(), v = new V3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity;
  for (const x of [box.x0, box.x1]) for (const y of [box.y0, box.y1]) for (const z of [box.z0, box.z1]) {
    v.set(x, y, z).applyMatrix4(inv);
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); z0 = Math.min(z0, v.z);
  }
  Object.assign(cam, { left: x0 - 0.1, right: x1 + 0.1, bottom: y0 - 0.1, top: y1 + 0.1, near: 0.5, far: -z0 + 1 });
  cam.updateProjectionMatrix();
  ctx.add(sun); ctx.add(sun.target);
  return sun;
}
function addHemi(ctx, h) { if (h) ctx.add(new THREE.HemisphereLight(h[0], h[1], h[2])); }
function addFill(ctx, color, intensity, pos = new V3(3, 3.5, 7)) {
  if (intensity <= 0) return;
  const l = new THREE.DirectionalLight(color, intensity); l.position.copy(pos);
  ctx.add(l); ctx.add(l.target);
}
// sky mesh + PMREM environment + horizon-matched fog
function setupSky(ctx, T, sunDir, groundHex, fogDensity, exposure) {
  const { scene, renderer } = ctx;
  ctx.add(makeSky(T, sunDir));
  const envScene = new THREE.Scene();
  envScene.add(makeSky(T, sunDir));
  const gc = C(groundHex).multiplyScalar(T.groundLum);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(90, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: gc }));
  disc.position.y = -2; envScene.add(disc);
  const horizon = sampleHorizon(renderer, envScene, T.az, T.el);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(envScene, 0.015, 0.1, 200);
  pm.dispose(); disposeScene(envScene);
  ctx.keep(rt);
  scene.background = null;
  scene.environment = rt.texture;
  scene.environmentIntensity = T.envI;
  const fogC = acesDisplay(horizon, exposure);
  scene.fog = new THREE.FogExp2(fogC, fogDensity);
  return { horizon, fogC };
}
async function loadWaterNormals() {
  const tex = await memo("tex:waternormals", () => new THREE.TextureLoader().loadAsync(WATERNORMALS_URL)
    .catch((e) => { memoCache.delete("tex:waternormals"); throw e; }));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
function addWater(ctx, normals, sunDir, T, { level, color, distortion, size, speed, sizeXZ = 6000 }) {
  const water = new Water(new THREE.PlaneGeometry(sizeXZ, sizeXZ), {
    textureWidth: 512, textureHeight: 512, waterNormals: normals, sunDirection: sunDir.clone(),
    sunColor: C(T.sun).multiplyScalar(T.el > 20 ? 1 : 1.4), waterColor: C(color), distortionScale: distortion, fog: true,
  });
  water.rotation.x = -Math.PI / 2; water.position.y = level;
  water.material.uniforms.size.value = size;
  // Water keeps its mirror render target private: capture it on first render so dispose() can free it.
  const rec = { rt: null };
  const orig = water.onBeforeRender;
  // Small near-ground clutter (grass, flowers, props) is hidden from the mirror pass: invisible in the
  // reflection anyway, and skipping it keeps the water cheap.
  water.onBeforeRender = function (renderer, ...rest) {
    const hide = ctx.noReflect;
    hide.forEach((o) => { o.userData.vis = o.visible; o.visible = false; });
    const set = renderer.setRenderTarget;
    if (!rec.rt) renderer.setRenderTarget = function (t, ...a) { if (t && !rec.rt) rec.rt = t; return set.call(this, t, ...a); };
    try { orig.call(this, renderer, ...rest); } finally { renderer.setRenderTarget = set; hide.forEach((o) => { o.visible = o.userData.vis; }); }
  };
  ctx.waters.push(rec);
  ctx.updaters.push((dt) => { water.material.uniforms.time.value += dt * speed; });
  ctx.add(water);
  return water;
}

/* ======================================================================
   Painter's props (outdoor): folding stool with an open paint box, water jar with brushes
   ====================================================================== */
function addPainterProps(ctx) {
  const g = new THREE.Group(); g.position.set(1.25, 0, -0.45); g.rotation.y = -0.35; ctx.noReflect.push(g);
  const woodMap = ctx.tex(woodCanvas(), { repeat: [1, 1] });
  const wood = new THREE.MeshStandardMaterial({ map: woodMap, roughness: 0.6 });
  const darkWood = new THREE.MeshStandardMaterial({ map: woodMap, color: "#8a6a50", roughness: 0.55 });
  const cloth = new THREE.MeshStandardMaterial({ color: "#3f4f3a", roughness: 0.95, side: THREE.DoubleSide });
  const metal = new THREE.MeshStandardMaterial({ color: "#c9ccd2", roughness: 0.3, metalness: 0.9 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = g) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = m.receiveShadow = true; parent.add(m); return m;
  };
  // folding stool: two crossed leg pairs + sling seat
  const legLen = 0.56, ang = 0.62;
  for (const sx of [-0.17, 0.17]) {
    add(rbox(0.025, legLen, 0.03), wood, sx, 0.23, 0, ang, 0, 0);
    add(rbox(0.025, legLen, 0.03), wood, sx * 0.86, 0.23, 0, -ang, 0, 0);
  }
  add(new THREE.CylinderGeometry(0.008, 0.008, 0.36, 8), metal, 0, 0.23, 0, 0, 0, Math.PI / 2);
  for (const z of [-0.15, 0.15]) add(new THREE.CylinderGeometry(0.014, 0.014, 0.38, 8), wood, 0, 0.455, z, 0, 0, Math.PI / 2);
  add(rbox(0.34, 0.006, 0.3), cloth, 0, 0.452, 0);
  // paint box with open lid
  const box = new THREE.Group(); box.position.set(0, 0.46, 0); g.add(box);
  add(rbox(0.34, 0.012, 0.24), darkWood, 0, 0.006, 0, 0, 0, 0, box);
  for (const [w, d, x, z] of [[0.34, 0.012, 0, 0.114], [0.34, 0.012, 0, -0.114], [0.012, 0.24, 0.164, 0], [0.012, 0.24, -0.164, 0]])
    add(rbox(w, 0.06, d), wood, x, 0.03, z, 0, 0, 0, box);
  const lid = add(rbox(0.34, 0.012, 0.24), wood, 0, 0.06 + 0.12 * Math.sin(1.4), -0.12 - 0.12 * Math.cos(1.4), 1.75, 0, 0, box);
  lid.castShadow = true;
  const tubeCols = ["#c0392b", "#2471a3", "#f1c40f", "#27ae60", "#ecf0f1", "#8e44ad", "#d35400"];
  tubeCols.forEach((c, i) => {
    add(new THREE.CylinderGeometry(0.011, 0.012, 0.085, 10), new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.4 }), -0.12 + i * 0.04, 0.026, 0.02 + (i % 2) * 0.03, Math.PI / 2, 0.15 * (i % 3), 0, box);
  });
  // jar with water and brushes on the ground
  addJar(add, ctx, g, -0.32, 0, -0.18, 0.05, 0.12, metal);
  ctx.add(g);
}
function addJar(add, ctx, parent, x, y, z, r, h, metal) {
  const glass = new THREE.MeshStandardMaterial({ color: "#dfe9ee", roughness: 0.06, metalness: 0, transparent: true, opacity: 0.32, depthWrite: false });
  const water = new THREE.MeshStandardMaterial({ color: "#8fa6a8", roughness: 0.1, transparent: true, opacity: 0.55, depthWrite: false });
  const jar = add(new THREE.CylinderGeometry(r, r * 0.92, h, 20, 1, true), glass, x, y + h / 2, z, 0, 0, 0, parent); jar.castShadow = false;
  add(new THREE.CylinderGeometry(r * 0.95, r * 0.9, h * 0.6, 20), water, x, y + h * 0.3, z, 0, 0, 0, parent).castShadow = false;
  const handleCols = ["#8e2b1f", "#2d2a26", "#c9a36a", "#1f4e6e"];
  for (let i = 0; i < 4; i++) {
    const a = i * 1.7, tilt = 0.12 + (i % 2) * 0.1, L = 0.24 + i * 0.02;
    const b = new THREE.Group(); b.position.set(x + Math.cos(a) * r * 0.4, y + 0.02, z + Math.sin(a) * r * 0.4);
    b.rotation.set(Math.sin(a) * tilt, 0, -Math.cos(a) * tilt); (parent || ctx.root).add(b);
    add(new THREE.CylinderGeometry(0.0045, 0.0035, L, 8), new THREE.MeshStandardMaterial({ color: handleCols[i], roughness: 0.4 }), 0, L / 2, 0, 0, 0, 0, b);
    add(new THREE.CylinderGeometry(0.005, 0.0045, 0.03, 8), metal, 0, L + 0.012, 0, 0, 0, 0, b);
    add(new THREE.ConeGeometry(0.005, 0.022, 8), new THREE.MeshStandardMaterial({ color: "#2a1d14", roughness: 0.7 }), 0, L + 0.036, 0, 0, 0, 0, b);
  }
}

/* ======================================================================
   OUTDOOR PLACES — each returns { height } after adding its scenery
   ====================================================================== */
const PLACE_CFG = {
  forest: { ground: "#3a4a28", fog: 0.0105, build: buildForest, lowSunExposure: 1.35 },   // shaded clearing: open up at golden hour
  lake: { ground: "#4a5a34", fog: 0.0011, build: buildLake },
  mountain: { ground: "#5c6e3a", fog: 0.00034, build: buildMountain },
  beach: { ground: "#c9b48a", fog: 0.0011, build: buildBeach },
  lavender: { ground: "#6b6a5a", fog: 0.0016, build: buildLavender },
};

// ---------- forest clearing ----------
function forestHeight(x, z) {
  const d = Math.hypot(x + 0.2, z - 0.5);
  return (fbm(x / 22, z / 22, 3, 2) * 1.4 + fbm(x / 140, z / 140, 3, 3) * 22 * sstep(30, 220, d)) * flatMask(x, z);
}
async function buildForest(ctx, T, mats) {
  const h = forestHeight, r = rng(101);
  const grass = C("#5f9a32"), dry = C("#9aae3e"), litter = C("#7a5a34"), moss = C("#4f7a30"), far = C("#2f5a2c");
  const color = (x, y, z, ny, c) => {
    const d = Math.hypot(x + 0.2, z - 0.5), n = fbm(x / 6, z / 6, 3, 7), clear = 1 - sstep(11, 18, d + n * 4);
    c.copy(litter).lerp(moss, 0.5 + 0.5 * fbm(x / 9, z / 9, 2, 8));
    c.lerp(grass.clone().lerp(dry, sstep(-0.1, 0.5, n)), clear);
    c.lerp(far, sstep(60, 160, d)).multiplyScalar(0.85 + 0.25 * n);
  };
  addTerrain(ctx, "forest", { R: 1400, N: 320, a: 0.035, tile: 2.2, height: h, color }, groundMat(ctx, grassDetailCanvas(), 2.2));
  // trees: ring around the clearing, denser in the view directions
  const trees = scatter(380, r, (r) => {
    const a = r() * Math.PI * 2, d = 16 + Math.pow(r(), 0.8) * 85, x = -0.2 + Math.sin(a) * d, z = 0.5 - Math.cos(a) * d;
    if (z > 6 && x > -12 && r() < 0.85) return null;
    return { x, z, s: 0.75 + r() * 0.6, kind: r() < 0.58 ? "conifer" : "broad" };
  }, 3.6);
  // a couple of framing trees on the left
  trees.push({ x: -8.5, z: 1.5, s: 1.15, kind: "broad", variant: 1 }, { x: -11, z: -6, s: 1.2, kind: "conifer", variant: 0 }, { x: 7.5, z: -9, s: 1.0, kind: "conifer", variant: 2 });
  plantTrees(ctx, mats, trees, h);
  const bushes = scatter(70, r, (r) => { const a = r() * 6.28, d = 7 + r() * 25, x = Math.sin(a) * d, z = 0.5 - Math.cos(a) * d; return { x, z, s: 0.8 + r() * 0.9, kind: "bush" }; }, 1.5);
  plantTrees(ctx, mats, bushes, h);
  const ferns = scatter(260, r, (r) => { const a = r() * 6.28, d = 6.5 + Math.pow(r(), 0.7) * 22, x = -0.2 + Math.sin(a) * d, z = 0.5 - Math.cos(a) * d; return { x, z }; }, 0.7);
  instanced(ctx, fernGeo(1), mats.fern, ferns.map((p) => ({ x: p.x, y: h(p.x, p.z), z: p.z, s: 0.8 + r() * 0.9, ry: r() * 6.28, c: new THREE.Color().setHSL(0.24 + r() * 0.04, 0.5, 0.45 + r() * 0.15) })), { chunk: 15 });
  const rocks = scatter(30, r, (r) => { const a = r() * 6.28, d = 6 + r() * 30; return { x: Math.sin(a) * d, z: 0.5 - Math.cos(a) * d, s: 0.25 + Math.pow(r(), 3) * 1.2 }; }, 2);
  rocks.push({ x: -5.6, z: -3.8, s: 1.1 }, { x: -4.6, z: -4.6, s: 0.45 }, { x: 4.2, z: -5.5, s: 0.7 });
  addRocks(ctx, mats, rocks, h);
  // fallen log
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 5.5, 14), new THREE.MeshStandardMaterial({ map: ctx.tex(barkCanvas(), { repeat: [3, 2] }), color: "#b5a090", roughness: 0.95 }));
  log.rotation.set(0, 0.5, Math.PI / 2); log.position.set(-7.2, h(-7.2, -3.5) + 0.22, -3.5); log.castShadow = log.receiveShadow = true; ctx.add(log);
  addGrass(ctx, mats, { count: 14000, outer: 17, height: h, colA: "#4c922c", colB: "#84b83a", hMin: 0.1, hMax: 0.26, accept: (x, z) => Math.hypot(x + 0.2, z - 0.5) < 15 + fbm(x / 5, z / 5) * 3 });
  return { height: h };
}

// ---------- lake shore ----------
const LAKE_LEVEL = -0.35;
function lakeS(x, z) {   // ~signed metres from the shoreline (+ on land)
  const ex = (x + 30) / 200, ez = (z + 175) / 174.5, d = Math.hypot(x, z);
  return (Math.hypot(ex, ez) - 1 + fbm(x / 90, z / 90, 3, 5) * 0.12 * sstep(15, 90, d)) * 175;
}
function lakeHeight(x, z) {
  const s = lakeS(x, z);
  let y = s < 0 ? -3 * (1 - Math.exp(0.05 * s)) : 3 * (1 - Math.exp(-0.05 * s));
  y += s > 0 ? (fbm(x / 220, z / 220, 4, 21) * 0.5 + 0.5) * 55 * sstep(30, 380, s) + ridged(x / 420, z / 420, 4, 22) * 45 * sstep(150, 600, s) : 0;
  y += fbm(x / 12, z / 12, 2, 23) * 0.25 * sstep(1, 8, Math.abs(s));
  return y * flatMask(x, z, 0.6, 4);
}
async function buildLake(ctx, T, mats, sunDir) {
  const h = lakeHeight, r = rng(202);
  const grass = C("#62a03a"), sand = C("#e2cc96"), mud = C("#8a7452"), forest = C("#2f6a3a"), rock = C("#8a8a94");
  const color = (x, y, z, ny, c) => {
    const s = lakeS(x, z), n = fbm(x / 8, z / 8, 3, 24);
    c.copy(grass).multiplyScalar(0.85 + 0.3 * n).lerp(C("#8b8a48"), sstep(0.2, 0.7, n) * 0.5);
    c.lerp(sand, 1 - sstep(-0.4, 0.9, s + n * 0.6));
    c.lerp(mud, 1 - sstep(-1.5, -0.3, s));
    const F = fbm(x / 25, z / 25, 3, 26);
    c.lerp(forest.clone().multiplyScalar(0.7 + 0.6 * (F * 0.5 + 0.5)), sstep(20, 60, s));
    c.lerp(rock, sstep(0.25, 0.5, 1 - ny) * 0.7);
  };
  addTerrain(ctx, "lake", { R: 2600, N: 380, a: 0.022, tile: 2.2, height: h, color }, groundMat(ctx, grassDetailCanvas(), 2.2));
  const normals = await loadWaterNormals();
  addWater(ctx, normals, sunDir, T, { level: LAKE_LEVEL, color: "#22808a", distortion: 0.8, size: 1.6, speed: 0.35 });
  // trees: far shore, left bank, a framing tree
  const trees = scatter(480, r, (r) => {
    const a = r() * Math.PI * 2, rr = 1.03 + Math.pow(r(), 1.6) * 0.5;
    const x = -30 + Math.cos(a) * 200 * rr, z = -175 + Math.sin(a) * 174.5 * rr;
    if (lakeS(x, z) < 5 || Math.hypot(x, z) < 35) return null;
    return { x, z, s: 1.0 + r() * 0.7, kind: r() < 0.65 ? "conifer" : "broad" };
  }, 4);
  // distant forest cover on the hills (cheap trees)
  const farTrees = scatter(2200, r, (r) => {
    const a = r() * Math.PI * 2, rr = 1.12 + r() * 1.6, x = -30 + Math.cos(a) * 200 * rr, z = -175 + Math.sin(a) * 174.5 * rr;
    if (z > -60 || lakeS(x, z) < 25 || fbm(x / 140, z / 140, 2, 27) < -0.25) return null;
    return { x, z, s: 1.1 + r() * 0.8, kind: "far" };
  }, 9);
  plantTrees(ctx, mats, farTrees, h);
  const left = scatter(40, r, (r) => { const x = -12 - r() * 40, z = -14 + r() * 30; return lakeS(x, z) > 3 ? { x, z, s: 0.8 + r() * 0.5, kind: r() < 0.5 ? "broad" : "conifer" } : null; }, 4.5);
  plantTrees(ctx, mats, [...trees, ...left, { x: -8.5, z: 2.5, s: 1.15, kind: "broad", variant: 2 }, { x: 9, z: 4, s: 1.0, kind: "broad", variant: 0 }], h);
  plantTrees(ctx, mats, scatter(24, r, (r) => { const x = -6 - r() * 25, z = -2 + r() * 14; return lakeS(x, z) > 1.5 ? { x, z, s: 0.7 + r() * 0.6, kind: "bush" } : null; }, 1.8), h);
  // reeds along the waterline
  const reeds = [];
  for (let i = 0; i < 9000 && reeds.length < 1600; i++) {
    const x = -38 + r() * 60, z = -12 + r() * 10, y = h(x, z);
    if (y < LAKE_LEVEL - 0.3 || y > LAKE_LEVEL + 0.25 || inWork(x, z, 1.2) || fbm(x / 4, z / 4, 2, 25) < 0.0) continue;
    const s = 1.0 + r() * 0.8;
    reeds.push({ x, y: y - 0.05, z, s, ry: r() * 6.28, rx: (r() - 0.5) * 0.25, rz: (r() - 0.5) * 0.25, c: new THREE.Color(0.9 + r() * 0.3, 0.9 + r() * 0.3, 0.8 + r() * 0.2) });
  }
  const reedMat = foliageMat({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }, 0.05);
  instanced(ctx, reedGeo(false), reedMat, reeds.filter((_, i) => i % 4), { chunk: 10 });
  instanced(ctx, reedGeo(true), reedMat, reeds.filter((_, i) => !(i % 4)), { chunk: 10 });
  addRocks(ctx, mats, scatter(18, r, (r) => { const x = -20 + r() * 34, z = -7 + r() * 4; return Math.abs(h(x, z) - LAKE_LEVEL) < 0.3 && !inWork(x, z, 1) ? { x, z, s: 0.15 + r() * 0.45 } : null; }, 1.2), h);
  addGrass(ctx, mats, { count: 11000, outer: 16, height: h, colA: "#4e962e", colB: "#86b83c", hMax: 0.26, accept: (x, z) => lakeS(x, z) > 1.2 });
  // wooden jetty on the left
  const wood = new THREE.MeshStandardMaterial({ map: ctx.tex(woodCanvas(), { repeat: [1, 0.3] }), color: "#9a8a7a", roughness: 0.85 });
  const jetty = new THREE.Group(); jetty.position.set(-9.5, 0, -4.2); jetty.rotation.y = 0.18;
  for (let i = 0; i < 26; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 0.18), wood); p.position.set((r() - 0.5) * 0.04, 0.32, -i * 0.22);
    p.rotation.y = (r() - 0.5) * 0.03; p.castShadow = p.receiveShadow = true; jetty.add(p);
  }
  for (let i = 0; i < 4; i++) for (const sx of [-0.75, 0.75]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 2.6, 8), wood); post.position.set(sx, -0.9, -0.3 - i * 1.7); jetty.add(post);
  }
  ctx.add(jetty);
  return { height: h };
}

// ---------- mountains ----------
function mountainHeight(x, z) {
  const d = Math.hypot(x, z);
  const meadow = fbm(x / 35, z / 35, 3, 31) * 1.1 + fbm(x / 170, z / 170, 3, 32) * 7 * sstep(25, 220, d);
  // the meadow ends at a valley; the range rises beyond it
  const valley = -50 * sstep(110, 650, d) * (0.7 + 0.3 * fbm(x / 600, z / 600, 2, 38));
  const mid = (fbm(x / 420, z / 420, 4, 33) * 0.5 + 0.5) * 30 * sstep(700, 1600, d);
  const range = Math.pow(ridged(x / 900, z / 900, 4, 34), 1.4) * 700 * sstep(1500, 2600, d);
  return (meadow + valley + mid + range) * flatMask(x, z, 0.6, 6);
}
async function buildMountain(ctx, T, mats) {
  const h = mountainHeight, r = rng(303);
  const meadow = C("#6aa83a"), dry = C("#b8c050"), forest = C("#2c6040"), rockC = C("#8a8a9c"), rockD = C("#6a6880"), snow = C("#f6f8ff");
  const color = (x, y, z, ny, c) => {
    const n = fbm(x / 10, z / 10, 3, 35), N2 = fbm(x / 160, z / 160, 3, 36), d = Math.hypot(x, z);
    c.copy(meadow).lerp(dry, sstep(0.0, 0.6, n) * 0.6).multiplyScalar(0.85 + 0.3 * n);
    const F = fbm(x / 45, z / 45, 3, 39);
    c.lerp(forest.clone().multiplyScalar(0.75 + 0.5 * (F * 0.5 + 0.5)), sstep(-0.05, 0.2, N2 + F * 0.3) * sstep(160, 400, d) * (1 - sstep(60, 160, y)));
    const slope = 1 - ny;
    c.lerp(rockC.clone().lerp(rockD, 0.5 + 0.5 * F), sstep(0.3, 0.5, slope) * sstep(60, 200, d));
    c.lerp(rockC.clone().lerp(rockD, 0.5 + 0.5 * F), sstep(110, 220, y) * 0.85);
    const snowLine = 250 + N2 * 80 + F * 40;
    c.lerp(snow, sstep(snowLine, snowLine + 50, y) * sstep(0.38, 0.62, ny));
  };
  addTerrain(ctx, "mountain", { R: 3800, N: 460, a: 0.018, tile: 2.4, height: h, color }, groundMat(ctx, grassDetailCanvas(), 2.4));
  const trees = [
    ...scatter(45, r, (r) => { const x = -20 - r() * 50, z = 8 + r() * 40; return { x, z, s: 0.7 + r() * 0.6, kind: "conifer" }; }, 4),
    ...scatter(25, r, (r) => { const x = -60 - r() * 60, z = -40 + r() * 50; return { x, z, s: 0.7 + r() * 0.6, kind: "conifer" }; }, 4),
    ...scatter(40, r, (r) => { const x = 18 + r() * 50, z = -110 + r() * 60; return { x, z, s: 0.7 + r() * 0.6, kind: "conifer" }; }, 4),
    ...scatter(160, r, (r) => { const a = r() * 6.28, d = 60 + r() * 300, x = Math.sin(a) * d, z = -Math.cos(a) * d; return fbm(x / 160, z / 160, 3, 36) > 0.0 && h(x, z) > -30 ? { x, z, s: 1 + r() * 0.5, kind: "conifer" } : null; }, 8),
    { x: 9, z: -6, s: 1.0, kind: "conifer", variant: 1 }, { x: 12, z: -2, s: 0.75, kind: "conifer", variant: 2 }, { x: -18, z: 6, s: 1.1, kind: "conifer", variant: 0 },
  ];
  plantTrees(ctx, mats, trees, h);
  addRocks(ctx, mats, scatter(30, r, (r) => { const a = r() * 6.28, d = 6 + r() * 40; return { x: Math.sin(a) * d, z: 1 - Math.cos(a) * d, s: 0.15 + Math.pow(r(), 3) * Math.min(1.3, d / 15) }; }, 2), h);
  addGrass(ctx, mats, { count: 15000, outer: 20, height: h, colA: "#4f9a2e", colB: "#86bb3c", hMin: 0.08, hMax: 0.24 });
  // wildflowers
  const flowerCols = ["#f5f2ea", "#f2d33c", "#7d5fd0", "#4a7fd6", "#e8e2f0", "#d9473a"].map(C);
  const fl = [];
  for (let i = 0; i < 40000 && fl.length < 6000; i++) {
    const x = (r() * 2 - 1) * 30, z = 1 + (r() * 2 - 1) * 30;
    if (inWork(x, z, 0.3) || fbm(x / 6, z / 6, 2, 37) < 0.05) continue;
    fl.push({ x, y: h(x, z), z, s: 0.8 + r() * 0.6, ry: r() * 6.28, c: flowerCols[Math.floor(r() * flowerCols.length)] });
  }
  const head = memo("geo:flower", () => { const p = new Parts(); p.geo(new THREE.IcosahedronGeometry(0.022, 0), m4(new V3(0, 0.2, 0), null, new V3(1, 0.5, 1)), C("#ffffff")); p.geo(new THREE.CylinderGeometry(0.002, 0.003, 0.2, 3), m4(new V3(0, 0.1, 0)), C("#2c4a1a")); return p.build(); });
  instanced(ctx, head, foliageMat({ vertexColors: true, roughness: 0.7 }, 0.6), fl, { chunk: 12 });
  return { height: h };
}

// ---------- beach ----------
const SEA_LEVEL = -0.3;
// waterline z for a given x: straight in front of the easel, curving away to the left into a palm-lined cove
const shoreZ = (x) => { const u = x + 12; return -9 + 1.6 * Math.sin(x / 23) - 0.85 * (Math.sqrt(u * u + 30) - u) / 2 + fbm(x / 40, 3.3, 2, 41) * 3 * sstep(12, 60, Math.abs(x)); };
function beachHeight(x, z) {
  const s = z - shoreZ(x) - 6;   // 0 ≈ 6 m inland of the waterline
  let y = s < 0 ? -3.2 * (1 - Math.exp(s * 0.016)) : 0;
  const dune = Math.max(0, s - 22) + Math.max(0, z - 14);
  y += sstep(0, 40, dune) * (3 + fbm(x / 30, z / 30, 3, 42) * 3) + fbm(x / 9, z / 9, 2, 43) * 0.12 * sstep(2, 10, Math.abs(s));
  return y * flatMask(x, z, 0.6, 5);
}
async function buildBeach(ctx, T, mats, sunDir) {
  const h = beachHeight, r = rng(404);
  const dry = C("#f2dcaa"), wet = C("#c8a87e"), grass = C("#9ab04a");
  const color = (x, y, z, ny, c) => {
    const n = fbm(x / 7, z / 7, 3, 44);
    c.copy(dry).multiplyScalar(0.9 + 0.18 * n);
    c.lerp(wet, 1 - sstep(SEA_LEVEL + 0.02, SEA_LEVEL + 0.28, y));
    c.lerp(grass, sstep(1.5, 3, y) * sstep(0, 0.4, n) * 0.6);
  };
  addTerrain(ctx, "beach", { R: 3000, N: 300, a: 0.03, tile: 3.2, height: h, color }, groundMat(ctx, sandCanvas(), 3.2, { bump: 0.6, gain: 1.0, detail: 0.5 }));
  const normals = await loadWaterNormals();
  addWater(ctx, normals, sunDir, T, { level: SEA_LEVEL, color: "#1592a0", distortion: 1.8, size: 0.9, speed: 0.6 });
  // foam: a strip following the waterline, sliding up/down the sand
  const foamMap = ctx.tex(foamCanvas(), { repeat: [24, 1] });
  foamMap.wrapT = THREE.ClampToEdgeWrapping;
  const fg = new THREE.PlaneGeometry(400, 3.2, 200, 1); fg.rotateX(-Math.PI / 2);
  const P = fg.attributes.position;
  for (let i = 0; i < P.count; i++) P.setZ(i, shoreZ(P.getX(i)) + P.getZ(i));
  const foamMat = new THREE.MeshStandardMaterial({ color: "#ffffff", alphaMap: foamMap, map: foamMap, transparent: true, depthWrite: false, roughness: 0.6 });
  const foam = new THREE.Mesh(fg, foamMat); foam.position.y = SEA_LEVEL + 0.03; ctx.add(foam);
  ctx.updaters.push((dt, t) => { const k = Math.sin(t * 0.55); foam.position.z = -0.6 * k; foamMat.opacity = 0.55 + 0.35 * Math.max(0, -k); foamMap.offset.x = t * 0.004; });
  // palms
  // [x, z, scale, lean direction]; near palms are young (short) so their crowns stay in the wide shot
  const palms = [[-9.5, -5.6, 0.55, 0.6], [-13, 0.5, 0.6, 1.1], [-9.5, 4.5, 0.75, 2.0], [7.5, -4.6, 0.7, -0.6], [10.5, -1.8, 0.9, -1.0], [15, -3, 1.0, -0.3], [24, -5, 1.1, -0.5]]
    .map(([x, z, s, a], i) => ({ x, z, s, ry: Math.PI / 2 + a * 0.4, kind: "palm", variant: i % 3 }));
  // palms along the cove's far beach, leaning toward the water
  for (let i = 0; i < 26; i++) {
    const x = -18 - i * 3.6 - r() * 2.5, z = shoreZ(x) + 7 + r() * 9;
    palms.push({ x, z, s: 0.8 + r() * 0.45, ry: 0.86 + (r() - 0.5) * 0.9, kind: "palm", variant: i % 3 });
  }
  plantTrees(ctx, mats, palms, h, { cast: true });
  addRocks(ctx, mats, [{ x: 5.5, z: -9.5, s: 0.9 }, { x: 6.6, z: -10.3, s: 0.55 }, { x: 4.6, z: -10.6, s: 0.35 }, { x: -6, z: -10.5, s: 0.4 }, { x: -30, z: -42, s: 4.2, flat: 0.9 }, { x: -25, z: -38, s: 2.0 }, { x: -35, z: -38, s: 1.5 }, { x: 70, z: -70, s: 5, flat: 0.8 }], h);
  // dune grass tufts
  const tufts = [];
  for (let i = 0; i < 30000 && tufts.length < 5000; i++) {
    const x = -90 + r() * 105, z = -60 + r() * 84, y = h(x, z);
    if (y < 0.5 || inWork(x, z, 1)) continue;
    if (fbm(x / 3, z / 3, 2, 45) < 0.1) continue;
    tufts.push({ x, y: y - 0.02, z, sx: 1, sy: 0.35 + r() * 0.5, ry: r() * 6.28, rx: (r() - 0.5) * 0.6, rz: (r() - 0.5) * 0.6, c: C("#b0a860").multiplyScalar(0.8 + r() * 0.4) });
  }
  instanced(ctx, bladeGeo(0.035, 0.35), mats.grass, tufts, { chunk: 15 });
  return { height: h };
}

// ---------- lavender field ----------
const ROW = 1.5;
const lavPath = (x, z) => x > -3.7 && x < 3.1 && z > -1.9;           // clear path the painter set up on
function lavField(x, z) {
  const d = Math.hypot(x, z);
  if (lavPath(x, z)) return 0;
  return 1 - sstep(380, 520, d + fbm(x / 120, z / 120, 2, 51) * 80);
}
function lavHeight(x, z) {
  const d = Math.hypot(x, z);
  return (fbm(x / 90, z / 90, 3, 52) * 2.5 * sstep(20, 120, d) + (fbm(x / 500, z / 500, 4, 53) * 0.5 + 0.5) * 85 * sstep(350, 1400, d)) * flatMask(x, z, 0.6, 6);
}
async function buildLavender(ctx, T, mats) {
  const h = lavHeight, r = rng(505);
  const soil = C("#a8805a"), farm = C("#8ab04a"), hills = C("#6a9a4a"), path = C("#c8a87a");
  const color = (x, y, z, ny, c) => {
    const n = fbm(x / 9, z / 9, 3, 54), d = Math.hypot(x, z);
    c.copy(soil).multiplyScalar(0.85 + 0.25 * n);
    if (lavPath(x, z)) c.lerp(path, 0.4).lerp(C("#7a8a42"), sstep(0.1, 0.5, n) * 0.5);
    c.lerp(farm.clone().lerp(hills, sstep(500, 1100, d)), 1 - lavField(x, z) * (1 - sstep(400, 520, d)) - (lavPath(x, z) ? 1 : 0));
  };
  // stripes: purple rows painted in the shader (anti-aliased with fwidth), masked by the `fmask` attribute
  const mat = groundMat(ctx, soilCanvas(), 2.4, { key: "lav", gain: 0.95, patch: (sh) => {
    sh.vertexShader = "attribute float fmask;\nvarying float vMask;\nvarying vec3 vWP;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvMask = fmask;\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = "varying float vMask;\nvarying vec3 vWP;\n" + sh.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      float rowP = vWP.x / ${ROW.toFixed(2)};
      float fw = fwidth(rowP);
      float row = smoothstep(0.62, 0.25, abs(fract(rowP) - 0.5) * 2.0);
      row = mix(row, 0.45, smoothstep(0.15, 0.6, fw));
      float jitter = 0.85 + 0.3 * fract(sin(floor(rowP) * 12.9898) * 43758.5453);
      vec3 lav = mix(vec3(0.16, 0.28, 0.08), vec3(0.36, 0.17, 0.78) * jitter, smoothstep(0.2, 0.9, row));
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * 0.7, lav, row), vMask);`);
  } });
  addTerrain(ctx, "lavender", { R: 3000, N: 340, a: 0.03, tile: 2.4, height: h, color, extra: (x, y, z) => lavField(x, z) }, mat);
  // lavender bushes in rows (near: detailed spikes; mid: low-poly mounds)
  const lavMat = foliageMat({ map: ctx.tex(lavCanvas(), { wrap: false }), vertexColors: true, roughness: 0.85, side: THREE.DoubleSide, alphaTest: 0.4, alphaToCoverage: true }, 0.25);
  const near = [[], [], []], mid = [];
  for (let k = -60; k <= 36; k++) {
    const x0 = k * ROW + ROW / 2;
    for (let z = 10; z > -150; z -= 0.55 + r() * 0.15) {
      const x = x0 + (r() - 0.5) * 0.12, isNear = z > -42 && x > -36 && x < 30;
      if (!isNear && (z > -42 ? x < -60 || x > 50 : Math.abs(x + 5) > 45 + -z * 0.6)) continue;
      if (lavField(x, z) < 0.5 || inWork(x, z, 0.9)) continue;
      const y = h(x, z), s = 0.85 + r() * 0.35;
      const it = { x, y: y - 0.04, z, s, sy: s * (0.9 + r() * 0.25), ry: r() * 6.28, c: new THREE.Color(0.9 + r() * 0.2, 0.9 + r() * 0.2, 0.9 + r() * 0.25) };
      if (isNear) near[Math.floor(r() * 3)].push(it); else mid.push(it);
    }
  }
  near.forEach((list, i) => instanced(ctx, lavenderGeo(60 + i, true), lavMat, list, { chunk: 9 }));
  instanced(ctx, lavenderGeo(70, false), lavMat, mid, { chunk: 20 });
  // trees: oaks along the field edges, cypresses by the farmhouse
  const farmX = -62, farmZ = -165;
  plantTrees(ctx, mats, [
    { x: -14, z: -24, s: 1.1, kind: "broad", variant: 0 }, { x: 22, z: -60, s: 1.2, kind: "broad", variant: 1 }, { x: -9, z: 9, s: 1.0, kind: "broad", variant: 2 },
    ...[0, 1, 2, 3, 4].map((i) => ({ x: farmX + 14 + i * 3.2, z: farmZ + 9, s: 1, sy: 1.15, kind: "slim", variant: i % 3 })),
    ...scatter(40, r, (r) => { const x = -300 + r() * 600, z = -260 - r() * 160; return { x, z, s: 1 + r() * 0.5, kind: r() < 0.6 ? "broad" : "conifer" }; }, 10),
    ...scatter(20, r, (r) => { const x = 60 + r() * 120, z = -40 - r() * 200; return { x, z, s: 1 + r() * 0.4, kind: "broad" }; }, 12),
  ], h);
  // farmhouse
  const house = new THREE.Group(); house.position.set(farmX, h(farmX, farmZ) - 0.3, farmZ); house.rotation.y = 0.35;
  const stone = new THREE.MeshStandardMaterial({ color: "#d8c3a0", roughness: 0.95 }), roof = new THREE.MeshStandardMaterial({ color: "#a4553a", roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: "#2a2420", roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 8), stone); body.position.y = 3; house.add(body);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 7), stone); wing.position.set(9.5, 2.25, 0.5); house.add(wing);
  const gable = (w, d, hgt, x, y) => { const g = new THREE.CylinderGeometry(1, 1, w, 3); g.rotateZ(Math.PI / 2); const m = new THREE.Mesh(g, roof); m.scale.set(1, hgt / 1.5 * 1.0, d / 1.732 * 1.1); m.rotation.x = Math.PI; m.position.set(x, y + hgt * 0.5 - 0.02, 0); house.add(m); return m; };
  gable(14.6, 8, 2.6, 0, 6); const g2 = gable(7.6, 7, 2.2, 9.5, 4.5); g2.position.z = 0.5;
  for (let i = 0; i < 4; i++) { const w = new THREE.Mesh(new THREE.BoxGeometry(1, 1.3, 0.1), dark); w.position.set(-5 + i * 3.3, 3.8, 4.02); house.add(w); }
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.4, 0.1), dark); door.position.set(1.5, 1.2, 4.02); house.add(door);
  ctx.add(house);
  addGrass(ctx, mats, { count: 9000, outer: 10, height: h, colA: "#7aa83a", colB: "#c4c45a", hMin: 0.06, hMax: 0.25, accept: (x, z) => lavPath(x, z) || lavField(x, z) < 0.5 });
  return { height: h };
}

/* ======================================================================
   STUDIO — atelier with a big window on the left wall
   ====================================================================== */
// box with world-space UVs (so plaster/wood tiles at real scale)
function worldBox(w, hgt, d, x, y, z, scale = 1.5) {
  const g = new THREE.BoxGeometry(w, hgt, d); g.translate(x, y, z);
  const P = g.attributes.position, N = g.attributes.normal, UV = g.attributes.uv;
  for (let i = 0; i < P.count; i++) {
    const nx = Math.abs(N.getX(i)), ny = Math.abs(N.getY(i));
    const a = nx > 0.5 ? P.getZ(i) : P.getX(i), b = ny > 0.5 ? P.getZ(i) : P.getY(i);
    UV.setXY(i, a / scale, b / scale);
  }
  return g;
}
async function buildStudio(ctx, T0) {
  const S = T0.studio, T = { ...T0, envI: S.envI };
  const { scene, renderer } = ctx;
  const X0 = -3.2, X1 = 6.0, Z0 = -2.4, Z1 = 6.5, Y1 = 3.3, WT = 0.22;
  const WZ0 = -1.95, WZ1 = 0.35, WY0 = 0.62, WY1 = 2.8;
  const lightDir = dirFromAzEl(S.az, S.el);
  // sky visible through the window + exterior (shares the sun direction)
  ctx.add(makeSky(T, lightDir));
  const envSky = new THREE.Scene(); envSky.add(makeSky(T, lightDir));
  const horizon = sampleHorizon(renderer, envSky, S.az, S.el); disposeScene(envSky);
  scene.fog = new THREE.FogExp2(acesDisplay(horizon, S.exposure), 0.004);
  // interior environment: dim warm room with a bright window panel on the left
  const envScene = new THREE.Scene();
  const roomBox = new THREE.Mesh(rbox(9.2, 3.3, 8.9), new THREE.MeshBasicMaterial({ color: C("#cdbfa8").multiplyScalar(0.18 + 0.12 * (S.el / 50)), side: THREE.BackSide }));
  roomBox.position.set(1.4, 1.65, 2.05); envScene.add(roomBox);
  const floorP = new THREE.Mesh(new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C("#6b4a30").multiplyScalar(0.25) }));
  floorP.position.set(1.4, 0.01, 2); envScene.add(floorP);
  const winP = new THREE.Mesh(new THREE.PlaneGeometry(WZ1 - WZ0, WY1 - WY0).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({ color: horizon.clone().multiplyScalar(2.2) }));
  winP.position.set(X0 + 0.02, (WY0 + WY1) / 2, (WZ0 + WZ1) / 2); envScene.add(winP);
  const pm = new THREE.PMREMGenerator(renderer), rt = pm.fromScene(envScene, 0.04, 0.1, 50); pm.dispose(); disposeScene(envScene);
  ctx.keep(rt); scene.environment = rt.texture; scene.environmentIntensity = S.envI; scene.background = null;
  // lights: sun through the window (shadow camera covers the whole room so walls block it), soft fill
  addSun(ctx, T.sun, S.sunI, lightDir, { x0: X0 - WT, x1: X1, y0: 0, y1: Y1 + 0.2, z0: Z0 - WT, z1: Z1 });
  addFill(ctx, "#ffe8cc", S.fillI, new V3(4, 2.6, 6));
  const hemi = new THREE.HemisphereLight("#fff1dc", "#5a4030", 0.25); ctx.add(hemi);

  const mk = (geo, mat, cast = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; ctx.add(m); return m; };
  // floor
  const pc = plankCanvases();
  const fw = X1 - X0, fd = Z1 - Z0;
  const floorMap = ctx.tex(pc.col, { repeat: [fw / 0.96, fd / 1.92], aniso: 16 }), floorRough = ctx.tex(pc.rough, { repeat: [fw / 0.96, fd / 1.92], srgb: false, aniso: 16 });
  const floor = mk(new THREE.PlaneGeometry(fw, fd).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: floorMap, roughnessMap: floorRough, roughness: 0.75, bumpMap: floorRough, bumpScale: 0.6 }), false);
  floor.position.set((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
  // walls (boxes so they cast shadows) with a window opening on the left
  const plaster = ctx.tex(plasterCanvas(), { repeat: [1, 1] });
  const wallM = new THREE.MeshStandardMaterial({ color: "#f4dcc0", map: plaster, bumpMap: plaster, bumpScale: 0.2, roughness: 0.9 });
  const lx = X0 - WT / 2;
  mk(worldBox(WT, Y1, WZ0 - (Z0 - WT), lx, Y1 / 2, (WZ0 + Z0 - WT) / 2), wallM);
  mk(worldBox(WT, Y1, Z1 + WT - WZ1, lx, Y1 / 2, (WZ1 + Z1 + WT) / 2), wallM);
  mk(worldBox(WT, WY0, WZ1 - WZ0, lx, WY0 / 2, (WZ0 + WZ1) / 2), wallM);
  mk(worldBox(WT, Y1 - WY1, WZ1 - WZ0, lx, (WY1 + Y1) / 2, (WZ0 + WZ1) / 2), wallM);
  mk(worldBox(X1 - X0 + 2 * WT, Y1, WT, (X0 + X1) / 2, Y1 / 2, Z0 - WT / 2), wallM);
  mk(worldBox(WT, Y1, Z1 - Z0 + 2 * WT, X1 + WT / 2, Y1 / 2, (Z0 + Z1) / 2), wallM);
  mk(worldBox(X1 - X0 + 2 * WT, Y1, WT, (X0 + X1) / 2, Y1 / 2, Z1 + WT / 2), wallM);
  mk(worldBox(X1 - X0 + 2 * WT, 0.2, Z1 - Z0 + 2 * WT, (X0 + X1) / 2, Y1 + 0.1, (Z0 + Z1) / 2), new THREE.MeshStandardMaterial({ color: "#efe7da", map: plaster, roughness: 0.95 }));
  // wood: beams, baseboards, window frame
  const woodMap = ctx.tex(woodCanvas(), { repeat: [1, 1] });
  const trim = new THREE.MeshStandardMaterial({ color: "#efe9df", roughness: 0.55 });
  const beamM = new THREE.MeshStandardMaterial({ map: woodMap, color: "#6b4c34", roughness: 0.8 });
  for (const z of [-0.6, 1.8, 4.2]) mk(worldBox(X1 - X0, 0.22, 0.18, (X0 + X1) / 2, Y1 - 0.11, z, 0.8), beamM);
  mk(worldBox(X1 - X0, 0.13, 0.025, (X0 + X1) / 2, 0.065, Z0 + 0.012), trim, false);
  mk(worldBox(0.025, 0.13, Z1 - Z0, X0 + 0.012, 0.065, (Z0 + Z1) / 2), trim, false);
  const frameM = new THREE.MeshStandardMaterial({ map: woodMap, color: "#e8e0d2", roughness: 0.6 });
  const fx = X0 - 0.06, wzc = (WZ0 + WZ1) / 2, wyc = (WY0 + WY1) / 2, ww = WZ1 - WZ0, wh = WY1 - WY0;
  for (const z of [WZ0 + 0.04, WZ1 - 0.04, wzc]) mk(worldBox(0.08, wh, z === wzc ? 0.06 : 0.08, fx, wyc, z, 0.5), frameM);
  for (const y of [WY0 + 0.04, WY1 - 0.04, WY0 + wh / 3, WY0 + 2 * wh / 3]) mk(worldBox(0.08, y === WY0 + 0.04 || y === WY1 - 0.04 ? 0.08 : 0.045, ww, fx, y, wzc, 0.5), frameM);
  mk(worldBox(0.3, 0.04, ww + 0.2, X0 + 0.06, WY0 - 0.02, wzc, 0.5), frameM);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(ww, wh).rotateY(Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#dfeaf0", roughness: 0.03, metalness: 0.1, transparent: true, opacity: 0.08, depthWrite: false }));
  glass.position.set(fx, wyc, wzc); ctx.add(glass);
  // exterior: lawn, hedge and trees beyond the window
  const mats = vegetationMats(ctx);
  const outH = () => -0.05;
  const lawn = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: ctx.tex(grassDetailCanvas(), { repeat: [200, 200] }), color: "#5f7a34", roughness: 1 }));
  lawn.position.set(-303.4, -0.05, 0); ctx.add(lawn);
  plantTrees(ctx, mats, [{ x: -11, z: -3, s: 1.0, kind: "broad", variant: 0 }, { x: -17, z: 3, s: 1.2, kind: "broad", variant: 1 }, { x: -14, z: -11, s: 1.1, kind: "conifer", variant: 2 },
    { x: -24, z: -6, s: 1.3, kind: "broad", variant: 2 }, { x: -9, z: 6, s: 0.9, kind: "conifer", variant: 0 }, { x: -30, z: 8, s: 1.2, kind: "conifer", variant: 1 }], outH);
  plantTrees(ctx, mats, [...Array(14)].map((_, i) => ({ x: -6.5 - (i % 2) * 0.6, z: -12 + i * 1.6, s: 1.1, kind: "bush", variant: i % 3 })), outH);

  // rug under the work area
  const rug = mk(new THREE.PlaneGeometry(3.3, 2.25).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: ctx.tex(rugCanvas(), { wrap: false }), roughness: 1 }), false);
  rug.position.set(-0.35, 0.004, 1.1); rug.rotation.y = 0.04;
  // framed paintings
  const frameWood = new THREE.MeshStandardMaterial({ map: woodMap, color: "#5a3a22", roughness: 0.5 });
  const gilt = new THREE.MeshStandardMaterial({ color: "#b08a4a", roughness: 0.35, metalness: 0.75 });
  const painting = (seed, w, hh, pos, rotY = 0, fm = frameWood) => {
    const g = new THREE.Group(); g.position.copy(pos); g.rotation.y = rotY;
    const f = new THREE.Mesh(rbox(w + 0.1, hh + 0.1, 0.045), fm); f.castShadow = f.receiveShadow = true; g.add(f);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), new THREE.MeshStandardMaterial({ map: ctx.tex(paintingCanvas(seed), { wrap: false }), roughness: 0.85 }));
    p.position.z = 0.024; p.receiveShadow = true; g.add(p); ctx.add(g); return g;
  };
  painting(0, 0.95, 0.7, new V3(-1.85, 1.95, Z0 + 0.03));
  painting(1, 0.62, 0.42, new V3(0.15, 2.6, Z0 + 0.03), 0, gilt);
  painting(2, 0.45, 0.6, new V3(-2.75, 1.55, Z0 + 0.03));
  painting(0 + 3, 0.6, 0.45, new V3(X0 + 0.03, 1.7, 1.2), Math.PI / 2);
  // canvases leaning against the back wall
  const linen = new THREE.MeshStandardMaterial({ color: "#e9e1d0", roughness: 0.95 });
  [[-2.55, 0.75, 0.95, 0.1], [-2.4, 0.6, 0.75, 0.13]].forEach(([x, w, hh, tilt], i) => {
    const m = mk(rbox(w, hh, 0.03), i ? [linen, linen, linen, linen, new THREE.MeshStandardMaterial({ map: ctx.tex(paintingCanvas(4 + i), { wrap: false }), roughness: 0.9 }), linen] : linen);
    m.position.set(x, hh / 2 * Math.cos(tilt), Z0 + 0.05 + hh / 2 * Math.sin(tilt) + i * 0.08); m.rotation.x = -tilt;
  });
  // shelves with books & jars (back wall, right)
  const shelfM = new THREE.MeshStandardMaterial({ map: woodMap, color: "#a37a55", roughness: 0.65 });
  const r = rng(77), bookCols = ["#e05a4a", "#3a7ad8", "#4aa84e", "#f0a93a", "#9a5ad0", "#f2d36a", "#2fb0b0", "#e07aa8", "#c0563a"];
  for (const y of [1.45, 1.98]) {
    mk(rbox(1.9, 0.035, 0.26), shelfM).position.set(2.15, y, Z0 + 0.13);
    for (const x of [1.35, 2.95]) mk(rbox(0.03, 0.16, 0.2), shelfM).position.set(x, y - 0.09, Z0 + 0.1);
  }
  let bx = 1.3;
  while (bx < 2.6) {
    const w = 0.025 + r() * 0.035, hh = 0.2 + r() * 0.1, d = 0.15 + r() * 0.05, lean = bx > 2.4 ? 0.25 : 0;
    const b = mk(rbox(w, hh, d), new THREE.MeshStandardMaterial({ color: bookCols[Math.floor(r() * bookCols.length)], roughness: 0.7 }));
    b.position.set(bx + w / 2 + (lean ? 0.06 : 0), 1.98 + 0.018 + hh / 2 * Math.cos(lean), Z0 + 0.13); b.rotation.z = -lean; bx += w + 0.003;
  }
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = m.receiveShadow = true; (parent || ctx.root).add(m); return m; };
  const metal = new THREE.MeshStandardMaterial({ color: "#c9ccd2", roughness: 0.3, metalness: 0.9 });
  for (const [x, rr, hh] of [[1.6, 0.045, 0.13], [1.95, 0.055, 0.16], [2.35, 0.04, 0.11], [2.75, 0.05, 0.14]]) addJar(add, ctx, null, x, 1.468, Z0 + 0.13, rr, hh, metal);
  const pot = new THREE.MeshStandardMaterial({ color: "#a65a3a", roughness: 0.9 });
  add(new THREE.CylinderGeometry(0.09, 0.07, 0.15, 16), pot, 2.85, 2.07, Z0 + 0.13);
  // side table with paints, jars & brushes
  const tableM = new THREE.MeshStandardMaterial({ map: woodMap, color: "#8a6040", roughness: 0.6 });
  add(rbox(0.62, 0.04, 0.46), tableM, 1.25, 0.72, -0.35);
  for (const [dx, dz] of [[-0.27, -0.19], [0.27, -0.19], [-0.27, 0.19], [0.27, 0.19]]) add(rbox(0.04, 0.7, 0.04), tableM, 1.25 + dx, 0.35, -0.35 + dz);
  add(rbox(0.54, 0.02, 0.38), tableM, 1.25, 0.18, -0.35);
  addJar(add, ctx, null, 1.1, 0.74, -0.42, 0.05, 0.13, metal);
  addJar(add, ctx, null, 1.4, 0.74, -0.25, 0.04, 0.1, metal);
  ["#c0392b", "#2471a3", "#f1c40f", "#27ae60", "#ecf0f1"].forEach((c, i) => add(new THREE.CylinderGeometry(0.012, 0.013, 0.09, 10), new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.4 }), 1.32 + i * 0.035, 0.755, -0.47, Math.PI / 2, 0.3 + i * 0.2, 0));
  add(rbox(0.2, 0.015, 0.15), new THREE.MeshStandardMaterial({ color: "#d8d2c4", roughness: 0.95 }), 1.08, 0.748, -0.2, 0, 0.4, 0);
  // stool by the window, plant in the corner
  const stool = new THREE.Group(); stool.position.set(-2.75, 0, -1.55);
  add(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 20), tableM, 0, 0.66, 0, 0, 0, 0, stool);
  for (let i = 0; i < 3; i++) { const a = i * 2.094; add(new THREE.CylinderGeometry(0.018, 0.022, 0.68, 8), tableM, Math.cos(a) * 0.12, 0.33, Math.sin(a) * 0.12, Math.sin(a) * 0.1, 0, -Math.cos(a) * 0.1, stool); }
  add(new THREE.TorusGeometry(0.115, 0.01, 6, 20), tableM, 0, 0.25, 0, Math.PI / 2, 0, 0, stool);
  ctx.add(stool);
  add(new THREE.CylinderGeometry(0.2, 0.15, 0.36, 20), pot, 3.05, 0.18, -1.85);
  plantTrees(ctx, mats, [{ x: 3.05, z: -1.85, s: 1.0, kind: "bush", variant: 0, ry: 0.3 }], () => 0.35);
  return { exposure: S.exposure };
}

/* ======================================================================
   Entry point
   ====================================================================== */
export async function buildEnvironment({ scene, renderer, place = "forest", time = "noon" }) {
  const t0 = performance.now();
  const T = TIME_CFG[time] || TIME_CFG.noon;
  const ctx = makeCtx(scene, renderer);
  let exposure = T.exposure;
  try {
    if (place === "studio") {
      exposure = (await buildStudio(ctx, T)).exposure;
    } else {
      const P = PLACE_CFG[place] || PLACE_CFG.forest;
      if (T.el < 20) exposure *= P.lowSunExposure ?? 1;
      const sunDir = dirFromAzEl(T.az, T.el);
      setupSky(ctx, T, sunDir, P.ground, P.fog, exposure);
      addSun(ctx, T.sun, T.sunI, dirFromAzEl(T.az, T.lightEl), SHADOW_BOX);
      addFill(ctx, T.fill, T.fillI);
      addHemi(ctx, T.hemi);
      const mats = vegetationMats(ctx);
      await P.build(ctx, T, mats, sunDir);
      addPainterProps(ctx);
    }
    // three.js copies each caster's `map` onto the shadow depth material and keeps it there; with the shared
    // depth material that stale reference re-uploads our textures after dispose(). A per-build depth material
    // confines those references to something we dispose ourselves.
    const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    ctx.root.traverse((o) => { if (o.isMesh && o.castShadow && !o.customDepthMaterial) o.customDepthMaterial = depthMat; });
    // compile shaders now so the first recorded frames don't hitch
    const cam = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 4000); cam.position.set(1.8, 1.55, 3.1); cam.lookAt(-0.15, 1.15, 0.25);
    // (bounded: in a hidden tab the driver may not finish parallel compiles until frames are drawn)
    if (renderer.compileAsync) await Promise.race([renderer.compileAsync(scene, cam), new Promise((r) => setTimeout(r, 800))]);
  } catch (e) {
    disposeCtx(ctx);
    throw e;
  }
  let disposed = false;
  return {
    exposure,
    buildMs: Math.round(performance.now() - t0),
    update(dt, t) { uTime.value = t; for (const f of ctx.updaters) f(dt, t); },
    dispose() { if (disposed) return; disposed = true; disposeCtx(ctx); },
  };
}
