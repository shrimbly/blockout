// Primitive geometry builders. Every shape has its pivot at the bottom centre (y = 0 is the ground).
// To add a primitive: add it to PRIMITIVES in core/doc.js, then add a builder here with the same params.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mannequin } from './mannequin.js';
import { blockman } from './blockman.js';
import { PERSON_HEIGHT } from '/core/doc.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ---------- imported models (.glb in the scene's models/) ----------
// A model is drawn like every other object: one clay mesh in the object's colour. Its meshes are merged
// into one triangle soup in model space, textures and materials dropped, pivot moved to the bottom centre.
const models = new Map(); // file -> { state: 'loading' | 'ready' | 'error', geo, size, triangles, error, promise }
let loader;
function gltfLoader() {
  if (loader) return loader;
  const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
  loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  return loader;
}
function mergeModel(root) {
  root.updateMatrixWorld(true);
  const chunks = [];
  const v = new THREE.Vector3();
  root.traverse((m) => {
    if (!m.isMesh || !m.geometry?.attributes.position) return;
    if (m.material && [].concat(m.material).every((x) => x.visible === false)) return;
    const pos = m.geometry.attributes.position, index = m.geometry.index;
    const n = index ? index.count : pos.count;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(m.matrixWorld);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    chunks.push(out);
  });
  const all = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  if (!b.isEmpty()) geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.computeBoundingBox();
  return { geo, size: geo.boundingBox.isEmpty() ? [0, 0, 0] : geo.boundingBox.getSize(new THREE.Vector3()).toArray(), triangles: all.length / 9 };
}
/** 'none' | 'loading' | 'ready' | 'error' for a model file. */
export const modelState = (file) => models.get(file)?.state || 'none';
export const modelError = (file) => models.get(file)?.error || null;
/** Start loading a model file (once); resolves when it is ready or has failed. */
export function loadModel(file) {
  let m = models.get(file);
  if (m) return m.promise;
  m = { state: 'loading' };
  models.set(file, m);
  m.promise = gltfLoader().loadAsync(`/models/${encodeURIComponent(file)}`)
    .then((gltf) => { Object.assign(m, mergeModel(gltf.scene), { state: 'ready' }); })
    .catch((e) => { Object.assign(m, { state: 'error', error: e?.message || String(e) }); });
  return m.promise;
}

const up = (g, y) => g.translate(0, y, 0);

export const BUILDERS = {
  box: ({ w, h, d }) => up(new THREE.BoxGeometry(w, h, d), h / 2),
  sphere: ({ r }) => up(new THREE.SphereGeometry(r, 40, 20), r),
  cylinder: ({ r, h, rTop }) => up(new THREE.CylinderGeometry(rTop ?? r, r, h, 40), h / 2),
  cone: ({ r, h }) => up(new THREE.ConeGeometry(r, h, 40), h / 2),
  pyramid: ({ w, h, d }) => new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0).scale(w, h, d),
  capsule: ({ r, h }) => up(new THREE.CapsuleGeometry(r, Math.max(0.001, h - 2 * r), 8, 24), h / 2),
  torus: ({ r, tube }) => up(new THREE.TorusGeometry(r, tube, 16, 56).rotateX(Math.PI / 2), tube),
  plane: ({ w, d }) => up(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), 0.003),
  ramp({ w, h, d }) {
    const s = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(d, 0), new THREE.Vector2(d, h)]);
    return new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-w / 2, 0, d / 2);
  },
  stairs({ w, h, d, steps }) {
    const n = Math.max(1, Math.round(steps));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const sh = (h * (i + 1)) / n, sd = d / n;
      parts.push(new THREE.BoxGeometry(w, sh, sd).translate(0, sh / 2, d / 2 - sd * (i + 0.5)));
    }
    return mergeGeometries(parts.map((g) => g.toNonIndexed()));
  },
  arch({ w, h, d, t }) {
    const ow = Math.max(0.05, w - 2 * t), r = ow / 2;
    const spring = Math.max(0, h - t - r); // height where the curve starts
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0); s.lineTo(-ow / 2, 0); s.lineTo(-ow / 2, spring);
    s.absarc(0, spring, r, Math.PI, 0, true);
    s.lineTo(ow / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 24 }).translate(0, 0, -d / 2);
  },
  // A person (male, female or child), h tall (default: the body's usual height), facing +z. Detail 'high'
  // is the jointed artist's mannequin; 'low' is a box body with a cube head and a drawn-on face.
  person({ h, body, detail }) {
    const H = h ?? PERSON_HEIGHT[body] ?? PERSON_HEIGHT.male;
    return (detail === 'low' ? blockman(body) : mannequin(body)).clone().scale(H, H, H);
  },
  // An imported .glb (see loadModel): empty until its file has loaded, then scaled to h tall if h is set.
  model({ file, h }) {
    const m = models.get(file);
    if (m?.state !== 'ready') return new THREE.BufferGeometry();
    const k = h && m.size[1] > 0 ? h / m.size[1] : 1;
    return m.geo.clone().scale(k, k, k);
  },
};

export function buildGeometry(type, params) {
  const b = BUILDERS[type];
  if (!b) throw new Error(`no builder for ${type}`);
  const g = b(params);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}
