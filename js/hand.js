// Keeps only the right forearm and hand of the rigged model visible, and gives that skin a light tone.
import * as THREE from "three";

const SKIN = [238, 199, 172];
const KEEP = /^Right(ForeArm|Hand)/;
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
// the model's skin: warm brown, hue ≈ 18–29°, saturation ≥ 0.48
const isSkin = (r, g, b) => {
  if (!(r > g && g > b) || lum(r, g, b) < 30 || lum(r, g, b) > 180) return false;
  const hue = ((g - b) / (r - b)) * 60, sat = (r - b) / r;
  return hue >= 18 && hue <= 29 && sat >= 0.48;
};

export function handOnly(model) {
  model.traverse(o => {
    if (!o.isSkinnedMesh) return;
    // triangles whose vertices all mostly follow the right forearm/hand bones
    const g = o.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, idx = g.index.array;
    const names = o.skeleton.bones.map(b => b.name.replace(/^mixamorig:?/, ""));
    const hand = new Uint8Array(si.count);
    for (let i = 0; i < si.count; i++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
      hand[i] = KEEP.test(names[si.getComponent(i, best)]) ? 1 : 0;
    }
    const keep = [];
    for (let t = 0; t < idx.length; t += 3) if (hand[idx[t]] && hand[idx[t + 1]] && hand[idx[t + 2]]) keep.push(idx[t], idx[t + 1], idx[t + 2]);
    g.setIndex(keep);
    o.material.side = THREE.DoubleSide;   // the cut end of the forearm shows its inside instead of a hole

    // light skin, keeping the texture's shading
    const map = o.material.map;
    if (!map || !map.image) return;
    const c = document.createElement("canvas"); c.width = map.image.width; c.height = map.image.height;
    const x = c.getContext("2d"); x.drawImage(map.image, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
    let sum = 0, n = 0;
    for (let i = 0; i < p.length; i += 4) if (isSkin(p[i], p[i + 1], p[i + 2])) { sum += lum(p[i], p[i + 1], p[i + 2]); n++; }
    const avg = n ? sum / n : 100;
    for (let i = 0; i < p.length; i += 4) {
      if (!isSkin(p[i], p[i + 1], p[i + 2])) continue;
      const f = Math.pow(lum(p[i], p[i + 1], p[i + 2]) / avg, 0.7);
      for (let k = 0; k < 3; k++) p[i + k] = Math.min(255, SKIN[k] * f);
    }
    x.putImageData(d, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.flipY = map.flipY; t.colorSpace = map.colorSpace; t.wrapS = map.wrapS; t.wrapT = map.wrapT; t.anisotropy = 8;
    o.material.map = t; o.material.needsUpdate = true;
  });
}
