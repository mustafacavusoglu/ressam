// The painter's hand: a rigged human drives the arm IK and the pencil-style brush grip, but only the right
// forearm and hand are drawn (the rest of the body stays invisible).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { handOnly } from "./hand.js";

const MODEL_URL = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/gltf/Michelle.glb";
const V3 = THREE.Vector3, Q = THREE.Quaternion;
const wp = (o, v = new V3()) => o.getWorldPosition(v);
const wq = (o, q = new Q()) => o.getWorldQuaternion(q);

/* ---------- pose helpers ---------- */
const _q1 = new Q(), _q2 = new Q(), _q3 = new Q();
// Rotate `bone` (shortest arc, world space) so bone→child points along `dir`; weight blends.
function aim(bone, child, dir, weight = 1) {
  bone.updateWorldMatrix(true, false); child.updateWorldMatrix(false, false);
  const cur = wp(child).sub(wp(bone)).normalize();
  _q1.setFromUnitVectors(cur, dir.clone().normalize());
  if (weight < 1) _q1.slerp(_q3.identity(), 1 - weight);
  wq(bone, _q2); wq(bone.parent, _q3);
  bone.quaternion.copy(_q3.invert().multiply(_q1.multiply(_q2)));
  bone.updateMatrixWorld(true);
}
function setWorldQuat(bone, q) {
  wq(bone.parent, _q3);
  bone.quaternion.copy(_q3.invert().multiply(q));
  bone.updateMatrixWorld(true);
}
// analytic two-bone IK: wrist to T, elbow pushed toward `pole`
function twoBone(arm, fore, hand, T, pole) {
  const S = wp(arm), E0 = wp(fore), H0 = wp(hand);
  const a = S.distanceTo(E0), b = E0.distanceTo(H0);
  const toT = T.clone().sub(S); let d = toT.length();
  d = Math.min(Math.max(d, Math.abs(a - b) + 1e-3), a + b - 1e-3);
  const dir = toT.normalize();
  const x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - x * x));
  const pv = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  const E = S.clone().add(dir.clone().multiplyScalar(x)).add(pv.multiplyScalar(h));
  aim(arm, fore, E.clone().sub(S));
  aim(fore, hand, S.clone().add(dir.multiplyScalar(d)).sub(E));
}
// rotation taking orthonormalised frame (a, b) to the world/local axes X, Y
function frameQuat(a, b) {
  const x = a.clone().normalize(), y = b.clone().sub(x.clone().multiplyScalar(b.dot(x))).normalize();
  return new Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, new V3().crossVectors(x, y)));
}

/* ---------- props ---------- */
const mat = (color, rough = 0.8, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
function mesh(geo, m, parent, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; parent.add(o); return o;
}
// brush: tip at origin, handle along +y. Filbert bristles, crimped ferrule, lacquered tapered handle.
const BRISTLE_LEN = 0.026, FERRULE_END = 0.058, GRIP_FROM_TIP = 0.07;
function makeBrush() {
  const g = new THREE.Group();
  const paintM = mat("#000000", 0.45);
  const tip = mesh(new THREE.SphereGeometry(0.0052, 14, 10), paintM, g, 0, 0.005, 0); tip.scale.set(1, 1.6, 0.55);
  mesh(new THREE.CylinderGeometry(0.0055, 0.0046, BRISTLE_LEN - 0.008, 14), mat("#cdb78f", 0.7), g, 0, 0.008 + (BRISTLE_LEN - 0.008) / 2, 0).scale.z = 0.6;
  mesh(new THREE.CylinderGeometry(0.0052, 0.0058, FERRULE_END - BRISTLE_LEN, 16), mat("#c8ccd3", 0.22, 1), g, 0, (BRISTLE_LEN + FERRULE_END) / 2, 0);
  mesh(new THREE.CylinderGeometry(0.0059, 0.0059, 0.003, 16), mat("#9ea3ab", 0.3, 1), g, 0, BRISTLE_LEN + 0.012, 0);  // crimp
  const handleM = new THREE.MeshPhysicalMaterial({ color: "#7a1f14", roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.15 });
  const handle = new THREE.LatheGeometry([[0.0058, 0], [0.0068, 0.04], [0.0062, 0.11], [0.0042, 0.2], [0.0034, 0.215], [0, 0.218]].map(([r, y]) => new THREE.Vector2(r, y)), 18);
  mesh(handle, handleM, g, 0, FERRULE_END, 0);
  return { group: g, paintM };
}
/* ---------- hand anatomy (measured once on the bind pose) ---------- */
const CURL = { Index: [0.3, 0.5, 0.35], Middle: [0.55, 0.85, 0.5], Ring: [1.0, 1.15, 0.75], Pinky: [1.1, 1.2, 0.8] };

function measureHand(B, side) {
  const hand = B(`${side}Hand`), mid = B(`${side}HandMiddle1`), idx = B(`${side}HandIndex1`), pk = B(`${side}HandPinky1`);
  const H = wp(hand), F = wp(mid).sub(H).normalize();
  const T = wp(idx).sub(wp(pk)); T.sub(F.clone().multiplyScalar(T.dot(F))).normalize();
  const N = (side === "Right" ? new V3().crossVectors(T, F) : new V3().crossVectors(F, T)).normalize();   // out of the palm
  // finger curl axes (bone-local) with a sign that bends toward the palm
  const curls = [];
  for (const finger of ["Index", "Middle", "Ring", "Pinky"]) for (let s = 1; s <= 3; s++) {
    const bone = B(`${side}Hand${finger}${s}`), child = bone && bone.children.find(c => c.isBone);
    if (!bone || !child) continue;
    const axis = T.clone().applyQuaternion(wq(bone).invert()).normalize();
    const before = wp(child), q0 = bone.quaternion.clone();
    bone.quaternion.multiply(new Q().setFromAxisAngle(axis, 0.3)); bone.updateMatrixWorld(true);
    const sign = wp(child).sub(before).dot(N) >= 0 ? 1 : -1;
    bone.quaternion.copy(q0); bone.updateMatrixWorld(true);
    curls.push({ bone, axis, sign, finger, s });
  }
  const qInv = wq(hand).invert();
  return {
    hand, len: wp(mid).distanceTo(H), curls,
    f: F.applyQuaternion(qInv), t: T.applyQuaternion(qInv), n: N.applyQuaternion(qInv),
    thumb: [1, 2, 3, 4].map(i => B(`${side}HandThumb${i}`)), index: [1, 2, 3, 4].map(i => B(`${side}HandIndex${i}`)),
  };
}
function curlFingers(h, table) {
  for (const c of h.curls) c.bone.quaternion.multiply(_q1.setFromAxisAngle(c.axis, c.sign * table[c.finger][c.s - 1]));
  h.hand.updateMatrixWorld(true);
}
// thumb tip meets the side of the index finger's last joint: the pinch that holds the brush
function pinchThumb(h, N) {
  const [t1, t2, t3, t4] = h.thumb, target = wp(h.index[2]).add(N.clone().multiplyScalar(0.008));
  if (t1 && t2) aim(t1, t2, target.clone().sub(wp(t1)), 0.35);
  if (t2 && t3) aim(t2, t3, target.clone().sub(wp(t2)), 0.65);
  if (t3 && t4) aim(t3, t4, target.clone().sub(wp(t3)), 0.8);
}

/* ---------- painter ---------- */
export function createPainter(scene) {
  const brush = makeBrush(); scene.add(brush.group);
  const P = { ready: false };
  const handT = new V3(), body = { x: -0.3 };
  let first = true;

  const loaded = new GLTFLoader().loadAsync(MODEL_URL).then(gltf => {
    const m = gltf.scene;
    m.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.frustumCulled = false; } });
    const box = new THREE.Box3().setFromObject(m);
    m.scale.multiplyScalar(1.72 / (box.max.y - box.min.y));
    const root = new THREE.Group(); root.add(m); scene.add(root);
    root.updateMatrixWorld(true);
    m.position.y -= new THREE.Box3().setFromObject(m).min.y;
    root.updateMatrixWorld(true);
    const bones = {}; m.traverse(o => { if (o.isBone) bones[o.name.replace(/^mixamorig:?/, "")] = o; });
    const B = n => bones[n];
    handOnly(m);
    Object.assign(P, { root, spine: B("Spine1"), spine2: B("Spine2"), rArm: B("RightArm"), rFore: B("RightForeArm"), rHand: B("RightHand") });
    P.rest = Object.values(bones).map(b => [b, b.quaternion.clone()]);
    P.R = measureHand(B, "Right");

    // measure the grip once: pinch point and the brush axis (pinch → web of the thumb), in hand space
    const R = P.R, qW = wq(R.hand), Nw = R.n.clone().applyQuaternion(qW);
    curlFingers(R, CURL); pinchThumb(R, Nw);
    const H = wp(R.hand);
    const pinch = wp(R.index[2]).lerp(wp(R.thumb[3] || R.thumb[2]), 0.5);
    const web = wp(R.index[0]).add(Nw.clone().multiplyScalar(-0.012)).lerp(wp(R.thumb[1]), 0.35);
    const qInv = qW.clone().invert();
    R.grip = pinch.clone().sub(H).applyQuaternion(qInv);                 // wrist → pinch, hand space (metres)
    R.handle = web.clone().sub(pinch).normalize().applyQuaternion(qInv);   // brush handle direction, hand space
    for (const [b, q] of P.rest) b.quaternion.copy(q);

    root.rotation.y = Math.PI;   // face the easel (−z)
    root.updateMatrixWorld(true);
    P.ready = true;
  });

  // brush handle points back toward the painter and a little up, the palm faces the canvas, angled down
  const D = new V3(0.32, 0.2, 0.93).normalize();
  const PALM = new V3(-0.25, -0.55, -0.8).normalize();
  const tmp = new V3();

  function placeBrush(tip, dir) {
    brush.group.position.copy(tip);
    brush.group.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir);
  }

  // tip: world point the brush should touch (or null when resting); dims: easel canvas size/centre
  function update(tip, dt, t, dims) {
    const { wC, hC, cC } = dims;
    const rest = new V3(cC.x - wC / 2 - 0.4, cC.y - hC * 0.3, 0.3);   // moves aside so the painting shows
    const goal = tip || rest;
    handT.lerp(goal, first ? 1 : 1 - Math.exp(-dt * (tip ? 16 : 3)));
    body.x += (THREE.MathUtils.clamp(handT.x - 0.3, -wC / 2 - 0.8, wC / 2 - 0.15) - body.x) * (first ? 1 : 1 - Math.exp(-dt * (tip ? 1.6 : 2.5)));
    first = false;

    if (!P.ready) { placeBrush(handT, D); return; }
    for (const [b, q] of P.rest) b.quaternion.copy(q);
    P.root.position.set(body.x, 0, 0.5 + 0.012 * Math.sin(t * 0.7));
    P.root.updateMatrixWorld(true);

    // torso leans toward the work (moves the shoulder the arm hangs from)
    const reach = handT.clone().sub(wp(P.spine2)).normalize();
    aim(P.spine, P.spine2, new V3(0, 1, 0).lerp(reach, 0.16 + 0.03 * Math.sin(t * 1.3)), 0.9);

    // right hand: orientation from the grip frame, wrist placed so the bristles land on `handT`
    const R = P.R;
    const qHand = frameQuat(D, PALM).multiply(frameQuat(R.handle, R.n).invert());
    const pinchW = handT.clone().add(D.clone().multiplyScalar(GRIP_FROM_TIP));
    const wrist = pinchW.clone().sub(R.grip.clone().applyQuaternion(qHand));
    twoBone(P.rArm, P.rFore, P.rHand, wrist, new V3(0.7, -0.65, 0.3));
    setWorldQuat(P.rHand, qHand);
    curlFingers(R, CURL);
    pinchThumb(R, R.n.clone().applyQuaternion(qHand));
    // if the arm couldn't quite reach, the brush follows the hand (never floats)
    const realTip = wp(P.rHand, tmp).add(R.grip.clone().applyQuaternion(qHand)).sub(D.clone().multiplyScalar(GRIP_FROM_TIP));
    placeBrush(realTip, D);
  }

  return { update, loaded, setPaint: col => brush.paintM.color.set(col), hand: handT };
}
