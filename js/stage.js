// Renderer, camera moves, and the easel with the painted canvas.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// "realistic cartoon" grade: a touch more saturation, warm lift in the shadows, soft vignette
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, sat: { value: 1.14 }, warm: { value: 0.035 }, vig: { value: 0.28 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float sat, warm, vig; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, sat);
      c.rgb += warm * vec3(1.0, 0.55, 0.2) * (1.0 - smoothstep(0.0, 0.6, l));
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vig * smoothstep(0.25, 0.75, dot(d, d) * 2.0);
      gl_FragColor = c;
    }`,
};

export const CANVAS_DEPTH = 0.03;
const CANVAS_BOTTOM = 0.82;

// procedural wood with grain + knots, used for the easel
function woodTexture(base = [128, 84, 50]) {
  const c = document.createElement("canvas"); c.width = 128; c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = `rgb(${base})`; g.fillRect(0, 0, 128, 512);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 128, w = 0.5 + Math.random() * 2.5, d = Math.random() * 30 - 18;
    g.strokeStyle = `rgba(${base[0] + d},${base[1] + d * 0.8},${base[2] + d * 0.6},${0.35 + Math.random() * 0.4})`;
    g.lineWidth = w; g.beginPath(); g.moveTo(x, 0);
    for (let y = 0; y <= 512; y += 16) g.lineTo(x + Math.sin(y * 0.02 + i) * 2.5, y);
    g.stroke();
  }
  for (let i = 0; i < 2; i++) {
    const x = 20 + Math.random() * 88, y = Math.random() * 512;
    for (let r = 10; r > 1; r -= 2) { g.strokeStyle = `rgba(60,35,20,${0.15 + (10 - r) * 0.04})`; g.beginPath(); g.ellipse(x, y, r * 0.6, r * 1.6, 0, 0, 7); g.stroke(); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
// coarse linen weave for the canvas sides/back
function linenTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#eee6d6"; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 128; i += 2) {
    g.fillStyle = `rgba(120,100,70,${0.06 + Math.random() * 0.06})`; g.fillRect(0, i, 128, 1); g.fillRect(i, 0, 1, 128);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4);
  return t;
}

export function createStage(canvasEl) {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 4000);

  // linear HDR chain; OutputPass applies the renderer's tone mapping + sRGB at the end
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1280, 720, { type: THREE.HalfFloatType, samples: 4 }));
  composer.setPixelRatio(1);
  composer.addPass(new RenderPass(scene, camera));
  const ao = new GTAOPass(scene, camera, 1280, 720);
  ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 8 });
  ao.updatePdMaterial({ samples: 8, rings: 2 });   // low-sample AO + light denoise: ~7 ms cheaper per frame
  ao.blendIntensity = 0.85;
  composer.addPass(ao);
  const bloom = new UnrealBloomPass(new THREE.Vector2(640, 360), 0.22, 0.6, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass(GradeShader));
  const render = () => composer.render();

  /* ---------- easel ---------- */
  const easel = new THREE.Group(); scene.add(easel);
  const woodMap = woodTexture();
  const easelM = new THREE.MeshStandardMaterial({ map: woodMap, roughness: 0.62, metalness: 0 });
  const linenM = new THREE.MeshStandardMaterial({ map: linenTexture(), roughness: 0.95 });
  const brassM = new THREE.MeshStandardMaterial({ color: "#b08d57", roughness: 0.35, metalness: 0.9 });
  const depthM = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  let canvasTex = null, canvasMesh = null, front = null, reliefTex = null;
  const flatBump = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); flatBump.needsUpdate = true;
  const dims = { wC: 1, hC: 1, cC: new THREE.Vector3() };

  const add = (geo, m, x, y, z) => {
    const o = new THREE.Mesh(geo, m); o.position.set(x, y, z);
    o.castShadow = o.receiveShadow = true; easel.add(o); return o;
  };

  // `view` is the 2D canvas shown on the easel; a new texture per size (WebGL storage can't grow).
  function buildEasel(view) {
    easel.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    easel.clear();
    const a = view.width / view.height;
    const hC = Math.min(0.95, 1.2 / a), wC = hC * a;
    dims.wC = wC; dims.hC = hC; dims.cC.set(0, CANVAS_BOTTOM + hC / 2, 0);
    if (canvasTex) canvasTex.dispose();
    canvasTex = new THREE.CanvasTexture(view);
    canvasTex.colorSpace = THREE.SRGBColorSpace; canvasTex.anisotropy = 8;
    // a little self-lit so the painting stays readable at sunrise/sunset or with the sun behind it
    // bump map is always set (flat until the paint relief arrives) so swapping it never recompiles the shader
    front = new THREE.MeshStandardMaterial({ map: canvasTex, roughness: 0.75, emissive: "#ffffff", emissiveMap: canvasTex, emissiveIntensity: 0.45, bumpMap: reliefTex || flatBump, bumpScale: 0 });
    canvasMesh = add(new THREE.BoxGeometry(wC, hC, CANVAS_DEPTH), [linenM, linenM, linenM, linenM, front, linenM], 0, dims.cC.y, 0);
    // own depth material: three r170's shared one would keep a reference to the disposed canvas texture
    canvasMesh.customDepthMaterial = depthM;
    // stretcher bars visible from the side/back
    for (const [w, h, x, y] of [[wC, 0.04, 0, hC / 2 - 0.02], [wC, 0.04, 0, -hC / 2 + 0.02], [0.04, hC, wC / 2 - 0.02, 0], [0.04, hC, -wC / 2 + 0.02, 0]]) {
      add(new THREE.BoxGeometry(w, h, 0.02), easelM, x, dims.cC.y + y, -CANVAS_DEPTH / 2 - 0.01);
    }
    const top = CANVAS_BOTTOM + hC + 0.18;
    const leg = (x, z, tiltX, tiltZ, len) => {
      const m = add(new THREE.BoxGeometry(0.042, len, 0.032), easelM, x, len / 2 * Math.cos(tiltX), z);
      m.rotation.set(tiltX, 0, tiltZ); return m;
    };
    leg(-wC * 0.32, -0.05, -0.04, -0.06, top + 0.05);
    leg(wC * 0.32, -0.05, -0.04, 0.06, top + 0.05);
    const back = leg(0, -0.45, 0.32, 0, top);
    back.position.y = top / 2 * Math.cos(0.32);
    add(new THREE.BoxGeometry(0.034, top - 0.2, 0.03), easelM, 0, (top - 0.2) / 2 + 0.2, -0.04);           // mast
    add(new THREE.BoxGeometry(wC + 0.14, 0.03, 0.09), easelM, 0, CANVAS_BOTTOM - 0.017, 0.02);             // ledge
    add(new THREE.BoxGeometry(wC + 0.14, 0.035, 0.012), easelM, 0, CANVAS_BOTTOM - 0.005, 0.06);           // ledge lip
    add(new THREE.BoxGeometry(0.11, 0.035, 0.06), easelM, 0, CANVAS_BOTTOM + hC + 0.015, 0.0);             // top clamp
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 12), brassM, 0, CANVAS_BOTTOM + hC + 0.015, 0.035).rotation.x = Math.PI / 2; // clamp knob
    add(new THREE.BoxGeometry(wC * 0.7, 0.025, 0.025), easelM, 0, 0.42, -0.05);                            // cross brace
  }

  const updateCanvas = () => { if (canvasTex) canvasTex.needsUpdate = true; };
  // paint relief (grey height canvas) for the finished painting; amount 0..1
  function setRelief(height) {
    if (reliefTex) reliefTex.dispose();
    reliefTex = height ? new THREE.CanvasTexture(height) : null;
    if (front) front.bumpMap = reliefTex || flatBump;
  }
  const setReliefAmount = a => { if (front) front.bumpScale = 3 * a; };
  const sheetToWorld = (u, v) => canvasMesh.localToWorld(new THREE.Vector3((u - 0.5) * dims.wC, (0.5 - v) * dims.hC, CANVAS_DEPTH / 2 + 0.004));

  /* ---------- format & camera ---------- */
  let W = 1280, H = 720;
  function setFormat(land) {
    W = land ? 1280 : 720; H = land ? 720 : 1280;
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
    camera.aspect = W / H; camera.fov = land ? 34 : 52; camera.updateProjectionMatrix();
  }
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  let camInit = true;
  // wide establishing shot → over-the-shoulder close-up following the brush → straight-on view of the finished painting
  function placeCamera(t, dt, endBlend, hand) {
    const { wC, hC, cC } = dims, land = W > H;
    const a = 0.55 + 0.05 * Math.sin(t * 0.15), r = land ? 3.3 : 3.0;
    const pos = new THREE.Vector3(Math.sin(a) * r, 1.55 + 0.04 * Math.sin(t * 0.21), 0.4 + Math.cos(a) * r);
    const look = new THREE.Vector3(-0.15, cC.y - 0.1, 0.25);
    if (hand) {
      look.copy(hand).lerp(cC, 0.3);
      pos.copy(look).add(new THREE.Vector3(0.55 + 0.04 * Math.sin(t * 0.3), 0.18, land ? 1.05 : 1.3));
    }
    if (endBlend > 0) {
      const e = endBlend * endBlend * (3 - 2 * endBlend);
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const d = Math.max((hC / 2) / tanV, (wC / 2) / (tanV * camera.aspect)) * 1.1 + CANVAS_DEPTH / 2;
      pos.lerp(new THREE.Vector3(cC.x, cC.y, cC.z + d), e);
      look.lerp(cC, e);
    }
    const k = camInit ? 1 : 1 - Math.exp(-dt * (hand ? 1.4 : 2.2));
    camPos.lerp(pos, k); camLook.lerp(look, k); camInit = false;
    camera.position.copy(camPos); camera.lookAt(camLook);
  }
  const resetCamera = () => { camInit = true; };

  return { renderer, scene, camera, dims, render, post: { composer, ao, bloom }, buildEasel, updateCanvas, setRelief, setReliefAmount, sheetToWorld, setFormat, placeCamera, resetCamera };
}
