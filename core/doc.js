// The scene document and the operations that change it.
// Pure ES module: the server applies ops; the browser only renders the result.
//
// Conventions: meters, Y up, rotations in degrees (XYZ order), colors as "#rrggbb".
// Every primitive's pivot is at its bottom centre, so position [x, 0, z] sits on the ground.

import { resolveEase, EASES, sampleObject, sampleCamera, PATHS, lensToFov, SHUDDER_SHAPES, SHUDDER_OVER, SHUDDER_DEFAULT } from './curves.js';

export const PRIMITIVES = {
  box: { params: { w: 1, h: 1, d: 1 }, size: ['w', 'h', 'd'], about: 'cuboid, w × h × d' },
  sphere: { params: { r: 0.5 }, size: ['r'], about: 'sphere of radius r, resting on the ground' },
  cylinder: { params: { r: 0.5, h: 1, rTop: null }, size: ['r', 'h'], about: 'cylinder; set rTop for a tapered column' },
  cone: { params: { r: 0.5, h: 1 }, size: ['r', 'h'], about: 'cone' },
  pyramid: { params: { w: 1, h: 1, d: 1 }, size: ['w', 'h', 'd'], about: 'square pyramid' },
  capsule: { params: { r: 0.3, h: 1.8 }, size: ['r', 'h'], about: 'capsule, total height h' },
  torus: { params: { r: 0.5, tube: 0.15 }, size: ['r', 'tube'], about: 'ring lying flat (hole points up)' },
  plane: { params: { w: 4, d: 4 }, size: ['w', 'd'], about: 'flat ground-aligned plane (floor, road, water)' },
  ramp: { params: { w: 1, h: 1, d: 2 }, size: ['w', 'h', 'd'], about: 'wedge rising toward −z (stairs, slopes, roofs)' },
  stairs: { params: { w: 1, h: 1, d: 1.5, steps: 6 }, size: ['w', 'h', 'd'], about: 'staircase rising toward −z' },
  arch: { params: { w: 2, h: 2.5, d: 0.5, t: 0.4 }, size: ['w', 'h', 'd'], about: 'doorway / arch, t = wall thickness' },
  person: {
    params: { h: null, body: 'male', detail: null }, size: ['h'], choices: { body: ['male', 'female', 'child'], detail: ['high', 'low'] },
    about: 'human figure facing +z; body male|female|child, h defaults to 1.8 / 1.65 / 1.3 m; detail high|low (unset: the scene\'s env.people)',
  },
  // An imported GLB (uploaded with "canvas import"), drawn as it comes with its own materials. Its first
  // animation clip plays on the shared action time: offset is the action time where the clip starts, speed its
  // playback rate; before the clip it holds the first frame, after it the last. length (clip seconds) and h
  // (height above the pivot) are measured at upload and only describe it.
  model: {
    params: { file: null, offset: 0, speed: 1, length: null, h: null }, size: [], strings: { file: /^[a-z0-9][a-z0-9._-]*\.glb$/i },
    about: 'imported GLB (canvas import <file>); its animation plays on the action time from offset, at speed',
  },
};

// Model files the scene can hold (a plain file name inside the scene folder's models/).
export const MODEL_FILE = PRIMITIVES.model.strings.file;

// How people are drawn when a person's own detail is not set: 'low' (the default for new scenes) is a box
// body with a cube head, 'high' the jointed mannequin. Set per scene with env.people.
export const PERSON_DETAIL = ['high', 'low'];

// Usual heights (m) for the person bodies, used when h is not set.
export const PERSON_HEIGHT = { male: 1.8, female: 1.65, child: 1.3 };

export const DEFAULT_COLOR = '#d8d4cc';

// Audio files the timeline can hold (a plain file name inside the scene folder's audio/).
export const AUDIO_FILE = /^[a-z0-9][a-z0-9._-]*\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/i;

export function createDoc() {
  return {
    version: 1,
    meta: { name: 'untitled', width: 1280, height: 720 },
    env: { background: '#e9e7e2', ground: true, grid: true, fog: 0, sun: [6, 10, 4], people: 'low' },
    objects: [],
    timeline: {
      duration: 5,
      fps: 24,
      interp: 'smooth',
      speed: 'linear',
      keys: [
        { id: 'k1', t: 0, position: [7, 3.5, 9], target: [0, 1, 0], fov: 40, roll: 0, ease: 'easeInOut' },
        { id: 'k2', t: 5, position: [-6, 2.5, 8], target: [0, 1, 0], fov: 40, roll: 0, ease: 'easeInOut' },
      ],
    },
    // Shots share the set, its people and the audio track (doc.audio, added when loaded); each has its own
    // camera timeline (keys, length, fps).
    // The active shot's timeline is doc.timeline; the others keep theirs in their shots entry.
    shots: [{ id: 'shot-1', name: 'Shot 1' }],
    shot: 'shot-1',
    controls: {},
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const vec3 = (v, name) => {
  if (typeof v === 'number') return [v, v, v];
  if (!isVec3(v)) throw new Error(`${name} must be [x, y, z] numbers, got ${JSON.stringify(v)}`);
  return [...v];
};
const color = (c) => {
  if (c == null) return DEFAULT_COLOR;
  if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`color must be "#rrggbb", got ${JSON.stringify(c)}`);
  return c.toLowerCase();
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'obj';

// Named objects keep their name ("crate", then "crate-2"); unnamed ones count up ("box-1").
function uniqueId(doc, base, { kind = 'objects', named = false } = {}) {
  const taken = new Set((kind === 'keys' ? doc.timeline.keys : doc.objects).map((o) => o.id));
  const sep = kind === 'keys' ? '' : '-';
  if (named && !taken.has(base)) return base;
  let n = named ? 2 : 1;
  while (taken.has(`${base}${sep}${n}`)) n++;
  return `${base}${sep}${n}`;
}

function findObject(doc, id) {
  const o = doc.objects.find((x) => x.id === id || x.name === id);
  if (!o) throw new Error(`no object "${id}" (have: ${doc.objects.map((x) => x.id).join(', ') || 'none'})`);
  return o;
}

function findKey(doc, ref) {
  const keys = doc.timeline.keys;
  let k;
  if (typeof ref === 'number') k = keys.slice().sort((a, b) => a.t - b.t)[ref];
  else k = keys.find((x) => x.id === ref);
  if (!k) throw new Error(`no key ${JSON.stringify(ref)} (have: ${keys.map((x) => `${x.id}@${x.t}`).join(', ') || 'none'})`);
  return k;
}

function normParams(type, params = {}, base) {
  const spec = PRIMITIVES[type];
  const out = { ...(base || spec.params) };
  for (const [k, v] of Object.entries(params)) {
    if (!(k in spec.params)) throw new Error(`${type} has no param "${k}" (params: ${Object.keys(spec.params).join(', ')})`);
    const choices = spec.choices?.[k], pattern = spec.strings?.[k];
    if (pattern) {
      if (v !== null && (typeof v !== 'string' || !pattern.test(v) || v.includes('..'))) throw new Error(`${type}.${k} must be a file name in the scene's models/ folder (.glb), got ${JSON.stringify(v)}`);
    } else if (choices) {
      if (v !== null && !choices.includes(v)) throw new Error(`${type}.${k} must be one of ${choices.join(', ')}, got ${JSON.stringify(v)}`);
    } else if (v !== null && !Number.isFinite(v)) throw new Error(`${type}.${k} must be a number`);
    out[k] = v;
  }
  return out;
}

const OBJECT_FIELDS = new Set(['op', 'type', 'name', 'id', 'newId', 'position', 'rotation', 'scale', 'move', 'color', 'note', 'size', 'params', 'anim', 'shot']);

// Split loose fields ({w:2, r:1}) out of an op into params. Unknown fields are errors (catches typos).
function pickParams(type, op) {
  const spec = PRIMITIVES[type];
  for (const k of Object.keys(op)) {
    if (!OBJECT_FIELDS.has(k) && !(k in spec.params) && op[k] !== undefined) {
      throw new Error(`${type} has no field or param "${k}" (params: ${Object.keys(spec.params).join(', ')}; fields: position, rotation, scale, move, color, name, note, size)`);
    }
  }
  const params = { ...(op.params || {}) };
  for (const k of Object.keys(spec.params)) if (k in op) params[k] = op[k];
  if (op.size != null) {
    const size = Array.isArray(op.size) ? op.size : [op.size];
    spec.size.forEach((k, i) => { if (size[i] != null) params[k] = size[i]; });
  }
  return params;
}

function sortKeys(doc) {
  doc.timeline.keys.sort((a, b) => a.t - b.t);
}

function normKey(k, prev = {}) {
  const out = { ...prev };
  if (k.t != null) { if (!Number.isFinite(k.t) || k.t < 0) throw new Error('key.t must be a time ≥ 0 in seconds'); out.t = round(k.t); }
  if (k.position != null) out.position = vec3(k.position, 'position');
  if (k.target != null) out.target = vec3(k.target, 'target');
  if (k.fov != null) { if (!(k.fov > 1 && k.fov < 170)) throw new Error('fov must be between 1 and 170 degrees'); out.fov = k.fov; }
  if (k.roll != null) out.roll = Number(k.roll);
  if (k.ease != null) { resolveEase(k.ease); out.ease = k.ease; }
  if (k.path !== undefined) { const p = normPath(k.path); if (p) out.path = p; else delete out.path; }
  if (k.shudder !== undefined) { const sh = normShudder(k.shudder, prev.shudder); if (sh) out.shudder = sh; else delete out.shudder; }
  if (out.ease == null) out.ease = 'easeInOut';
  if (out.fov == null) out.fov = 40;
  if (out.roll == null) out.roll = 0;
  return out;
}

const round = (n) => Math.round(n * 1000) / 1000;

// A key's path: how the camera travels from it to the next key. null or "smooth" is the usual spline.
//   { type: 'straight' }                          a straight line (dolly, truck, crane)
//   { type: 'orbit', center, angle?, around? }    round the vertical axis through center; angle (deg,
//                                                 + to the camera's right) says which way and how far
//   { type: 'turn', angle? }                      pan / tilt on the spot (angle: + pans right)
//   { type: 'dollyZoom' }                         straight, with the lens holding the subject's size
const PATH_ALIASES = { 'dolly-zoom': 'dollyZoom', dollyzoom: 'dollyZoom', line: 'straight' };
function normPath(p) {
  if (p == null || p === 'smooth' || p === false) return null;
  if (typeof p === 'string') p = { type: p };
  if (typeof p !== 'object' || Array.isArray(p)) throw new Error('path must be a type name or { type, ... }');
  const type = PATH_ALIASES[p.type] || p.type;
  if (type === 'smooth') return null;
  if (!PATHS.includes(type)) throw new Error(`unknown path "${p.type}" (paths: smooth, ${PATHS.join(', ')})`);
  const out = { type };
  if (type === 'orbit' && p.center != null) out.center = vec3(p.center, 'path.center').map(round);
  if ((type === 'orbit' || type === 'turn') && p.angle != null) {
    if (!Number.isFinite(+p.angle)) throw new Error('path.angle must be degrees');
    out.angle = round(+p.angle);
  }
  if (type === 'orbit' && p.around != null) out.around = String(p.around);
  // the preset that made it and its settings, so the Moves menu can reopen and change it
  if (p.move != null) {
    if (!MOVES[p.move]) throw new Error(`unknown move "${p.move}" (moves: ${Object.keys(MOVES).join(', ')})`);
    out.move = p.move;
    out.params = moveParams(p.params || {});
  }
  return out;
}
// A key's shudder: exact jerks back and forth along the segment after it, on top of its ease (see
// shudderOffset in core/curves.js). Partial settings change the key's current shudder (or the defaults);
// null, false, "off" or amount 0 removes it.
function normShudder(sh, prev) {
  if (sh == null || sh === false || sh === 'off') return null;
  if (sh === true || sh === 'on') sh = {};
  if (typeof sh !== 'object' || Array.isArray(sh)) throw new Error('shudder must be { jerks, amount, shape, over, from, to } or "off"');
  const out = { ...SHUDDER_DEFAULT, ...prev, ...Object.fromEntries(Object.entries(sh).filter(([, v]) => v != null)) };
  const jerks = Math.round(+out.jerks), amount = +out.amount;
  if (!(jerks >= 1 && jerks <= 60)) throw new Error('shudder.jerks must be a whole number from 1 to 60');
  if (!(amount >= 0 && amount <= 50)) throw new Error('shudder.amount is how far each jerk pulls back, as a % of the move: 0 to 50');
  if (!SHUDDER_SHAPES.includes(out.shape)) throw new Error(`shudder.shape must be one of ${SHUDDER_SHAPES.join(', ')}`);
  if (!SHUDDER_OVER.includes(out.over)) throw new Error(`shudder.over must be one of ${SHUDDER_OVER.join(', ')}`);
  const from = +out.from, to = +out.to;
  if (!(from >= 0 && to <= 1 && to - from >= 0.01)) throw new Error('shudder.from / shudder.to are where it starts and stops, as shares of the segment (0–1), from before to');
  if (amount === 0) return null;
  return { jerks, amount: round(amount), shape: out.shape, over: out.over, ...(from > 0 && { from: round(from) }), ...(to < 1 && { to: round(to) }) };
}
const MOVE_PARAMS = ['angle', 'by', 'lens', 'fov', 'rise'];
function moveParams(src) {
  const out = {};
  for (const k of MOVE_PARAMS) if (src[k] != null) { if (!Number.isFinite(+src[k])) throw new Error(`${k} must be a number`); out[k] = round(+src[k]); }
  if (src.around != null) out.around = typeof src.around === 'string' ? src.around : vec3(src.around, 'around').map(round);
  return out;
}

// ----- object animation: obj.anim = [{ t, position, rotation, scale, ease }], sorted by t -----
function normAnimKey(k, base) {
  if (!Number.isFinite(k.t) || k.t < 0) throw new Error('an animation key needs a time t ≥ 0 in seconds');
  const ease = k.ease ?? 'easeInOut';
  resolveEase(ease);
  return {
    t: round(k.t),
    position: (k.position != null ? vec3(k.position, 'position') : [...base.position]).map(round),
    rotation: (k.rotation != null ? vec3(k.rotation, 'rotation') : [...base.rotation]).map(round),
    scale: (k.scale != null ? vec3(k.scale, 'scale') : [...base.scale]).map(round),
    ease,
  };
}
// Keep keys sorted and the object's own transform equal to its first key, so lists and the gizmo agree.
function syncAnim(o) {
  o.anim.sort((a, b) => a.t - b.t);
  const f = o.anim[0];
  o.position = [...f.position]; o.rotation = [...f.rotation]; o.scale = [...f.scale];
}
// Object keys are stored in action time, shared by every shot; a shot shows the action from its
// timeline.start (default 0). Ops take shot time, like the playhead.
const actionStart = (doc) => doc.timeline.start || 0;
// Add or replace a key at shot time t; missing fields come from where the object is at t.
function putAnimKey(doc, o, k) {
  const at = sampleObject(o, { ...doc.timeline, speed: 'linear' }, k.t);
  const key = normAnimKey({ ...k, t: k.t + actionStart(doc) }, at);
  o.anim ||= [];
  const i = o.anim.findIndex((x) => Math.abs(x.t - key.t) < 1e-3);
  if (i >= 0) { if (k.ease == null) key.ease = o.anim[i].ease; o.anim[i] = key; } else o.anim.push(key);
  syncAnim(o);
  const shotT = round(key.t - actionStart(doc));
  if (shotT > doc.timeline.duration) doc.timeline.duration = shotT;
  return { ...key, t: shotT };
}

// ----- preset camera moves (cam.move) -----
const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
};
const unit = (a) => { const l = v3.len(a) || 1; return v3.mul(a, 1 / l); };
const R = Math.PI / 180;
// Turn p round the vertical axis through c by deg (+ moves a camera to its right, i.e. a growing atan2(x, z)).
function spin(p, c, deg) {
  const u = v3.sub(p, c), a = deg * R;
  return [c[0] + u[0] * Math.cos(a) + u[2] * Math.sin(a), p[1], c[2] - u[0] * Math.sin(a) + u[2] * Math.cos(a)];
}
// Roughly where to aim at an object: its pivot (bottom centre) plus most of its height.
function objectCentre(doc, id, t) {
  const o = findObject(doc, id);
  const at = sampleObject(o, { ...doc.timeline, speed: 'linear' }, t);
  const p = o.params || {};
  const h = (p.h ?? (o.type === 'person' ? PERSON_HEIGHT[p.body || 'male'] : null) ?? (p.r != null ? p.r * 2 : 1)) * (at.scale?.[1] ?? 1);
  return [at.position[0], at.position[1] + h * (o.type === 'person' ? 0.75 : 0.5), at.position[2]];
}
const num = (v, name, def) => {
  if (v == null) { if (def === undefined) throw new Error(`this move needs ${name}`); return def; }
  if (!Number.isFinite(+v)) throw new Error(`${name} must be a number`);
  return +v;
};
const r3 = (v) => v.map(round);

/**
 * The preset moves. Each makes the end framing from the start one, and the path the segment travels.
 * Signs: angle + is right (pan, orbit) or up (tilt), clockwise for roll; by + is in (push), right (truck), up (crane).
 */
export const MOVES = {
  pan: { name: 'pan', params: 'angle (deg, + right)', about: 'turn left or right on the spot', make(s, op) {
    const angle = num(op.angle, 'angle', 45);
    return { end: { ...s, target: r3(spin(s.target, s.position, -angle)) }, path: { type: 'turn', angle } };
  } },
  tilt: { name: 'tilt', params: 'angle (deg, + up)', about: 'turn up or down on the spot', make(s, op) {
    const angle = num(op.angle, 'angle', 20);
    const d = v3.sub(s.target, s.position), flat = Math.hypot(d[0], d[2]), dist = v3.len(d);
    const pitch = Math.max(-89, Math.min(89, Math.atan2(d[1], flat) / R + angle)) * R;
    const yaw = Math.atan2(d[0], d[2]);
    const dir = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    return { end: { ...s, target: r3(v3.add(s.position, v3.mul(dir, dist))) }, path: { type: 'turn', angle: 0 } };
  } },
  orbit: { name: 'orbit', params: 'angle (deg, + right), around (object id or x,y,z; default the aim), rise (m)', about: 'circle round the subject, keeping it in frame', make(s, op, doc, t) {
    const angle = num(op.angle, 'angle', 90);
    const around = typeof op.around === 'string' ? op.around : null;
    const center = around ? objectCentre(doc, around, t) : op.around != null ? vec3(op.around, 'around') : s.target;
    const rise = num(op.rise, 'rise', 0);
    const position = spin(s.position, center, angle); position[1] += rise;
    return { end: { ...s, position: r3(position), target: r3(spin(s.target, center, angle)) }, path: { type: 'orbit', center: r3(center), angle, ...(around ? { around } : {}) } };
  } },
  push: { name: 'push', params: 'by (m, + toward the aim; − pulls out)', about: 'dolly toward or away from the subject', make(s, op) {
    const dist = v3.len(v3.sub(s.target, s.position));
    let by = num(op.by, 'by', dist / 3);
    if (op.pull) by = -Math.abs(by); // pull-out: a push the other way
    by = Math.min(by, dist - 0.1);
    return { end: { ...s, position: r3(v3.add(s.position, v3.mul(unit(v3.sub(s.target, s.position)), by))) }, path: { type: 'straight' } };
  } },
  truck: { name: 'truck', params: 'by (m, + right)', about: 'slide sideways, camera and aim together', make(s, op) {
    const f = v3.sub(s.target, s.position), right = unit([-f[2], 0, f[0]]);
    const d = v3.mul(right, num(op.by, 'by', 2));
    return { end: { ...s, position: r3(v3.add(s.position, d)), target: r3(v3.add(s.target, d)) }, path: { type: 'straight' } };
  } },
  pedestal: { name: 'pedestal', params: 'by (m, + up)', about: 'rise or drop, camera and aim together', make(s, op) {
    const d = [0, num(op.by, 'by', 1.5), 0];
    return { end: { ...s, position: r3(v3.add(s.position, d)), target: r3(v3.add(s.target, d)) }, path: { type: 'straight' } };
  } },
  crane: { name: 'crane', params: 'by (m, + up)', about: 'rise or drop while keeping the subject framed', make(s, op) {
    return { end: { ...s, position: r3(v3.add(s.position, [0, num(op.by, 'by', 2), 0])) }, path: { type: 'straight' } };
  } },
  zoom: { name: 'zoom', params: 'lens (mm) or fov (deg)', about: 'change focal length, the camera stays put', make(s, op) {
    const fov = op.lens != null ? lensToFov(num(op.lens, 'lens')) : num(op.fov, 'lens or fov', s.fov * 0.6);
    if (!(fov > 1 && fov < 170)) throw new Error('the lens must give a fov between 1 and 170 degrees');
    return { end: { ...s, fov: round(fov) }, path: { type: 'straight' } };
  } },
  dollyZoom: { name: 'dollyZoom', params: 'by (m, + toward the aim; the lens widens to hold the subject)', about: 'push in while widening the lens (or pull out while tightening) so the subject keeps its size', make(s, op) {
    const dist = v3.len(v3.sub(s.target, s.position));
    const by = Math.min(num(op.by, 'by', dist / 2), dist - 0.1);
    const fov = 2 * Math.atan((Math.tan((s.fov * R) / 2) * dist) / (dist - by)) / R;
    if (!(fov > 1 && fov < 170)) throw new Error('that dolly zoom needs a lens wider than 170°: use a smaller by');
    return { end: { ...s, position: r3(v3.add(s.position, v3.mul(unit(v3.sub(s.target, s.position)), by))), fov: round(fov) }, path: { type: 'dollyZoom' } };
  } },
  roll: { name: 'roll', params: 'angle (deg, + clockwise)', about: 'dutch angle: tilt the horizon', make(s, op) {
    return { end: { ...s, roll: round(s.roll + num(op.angle, 'angle', 15)) }, path: { type: 'straight' } };
  } },
};
const MOVE_ALIASES = { 'push-in': 'push', pushIn: 'push', dolly: 'push', 'pull-out': 'push', 'dolly-zoom': 'dollyZoom', dollyzoom: 'dollyZoom', vertigo: 'dollyZoom', dutch: 'roll', arc: 'orbit', boom: 'crane' };
export const MOVE_NAMES = Object.keys(MOVES);

/** Operation handlers. Each mutates doc in place and returns a result. */
export const OPS = {
  add(doc, op) {
    const type = op.type;
    if (!PRIMITIVES[type]) throw new Error(`unknown type "${type}" (types: ${Object.keys(PRIMITIVES).join(', ')})`);
    const id = op.id ? slug(op.id) : op.name ? uniqueId(doc, slug(op.name), { named: true }) : uniqueId(doc, type);
    if (doc.objects.some((o) => o.id === id)) throw new Error(`id "${id}" already exists`);
    const obj = {
      id,
      name: op.name || id,
      type,
      params: normParams(type, pickParams(type, op)),
      position: op.position != null ? vec3(op.position, 'position') : [0, 0, 0],
      rotation: op.rotation != null ? vec3(op.rotation, 'rotation') : [0, 0, 0],
      scale: op.scale != null ? vec3(op.scale, 'scale') : [1, 1, 1],
      color: color(op.color),
    };
    if (type === 'model' && !obj.params.file) throw new Error('a model needs a file: upload it with "canvas import <file.glb>"');
    if (op.note) obj.note = String(op.note);
    if (Array.isArray(op.anim) && op.anim.length) { obj.anim = op.anim.map((k) => normAnimKey(k, obj)); syncAnim(obj); }
    doc.objects.push(obj);
    return { id };
  },

  update(doc, op) {
    const o = findObject(doc, op.id);
    if (op.type && op.type !== o.type) {
      if (!PRIMITIVES[op.type]) throw new Error(`unknown type "${op.type}"`);
      o.type = op.type;
      o.params = normParams(op.type, {});
    }
    const params = pickParams(o.type, op);
    if (Object.keys(params).length) o.params = normParams(o.type, params, o.params);
    if (o.type === 'model' && !o.params.file) throw new Error('a model needs a file: upload it with "canvas import <file.glb>"');
    if (op.name != null) o.name = String(op.name);
    // On an animated object, changing its transform shifts the whole move (every key) by the same amount.
    const before = { position: [...o.position], rotation: [...o.rotation], scale: [...o.scale] };
    if (op.position != null) o.position = vec3(op.position, 'position');
    if (op.rotation != null) o.rotation = vec3(op.rotation, 'rotation');
    if (op.scale != null) o.scale = vec3(op.scale, 'scale');
    if (op.move != null) o.position = vec3(op.move, 'move').map((v, i) => round(o.position[i] + v));
    if (o.anim?.length) {
      for (const k of o.anim) {
        k.position = k.position.map((v, i) => round(v + o.position[i] - before.position[i]));
        k.rotation = k.rotation.map((v, i) => round(v + o.rotation[i] - before.rotation[i]));
        k.scale = k.scale.map((v, i) => round(before.scale[i] ? v * (o.scale[i] / before.scale[i]) : o.scale[i]));
      }
      syncAnim(o);
    }
    if (op.color != null) o.color = color(op.color);
    if (op.note != null) o.note = String(op.note);
    return { id: o.id };
  },

  remove(doc, op) {
    const ids = [].concat(op.ids ?? op.id);
    for (const id of ids) {
      const o = findObject(doc, id);
      doc.objects = doc.objects.filter((x) => x !== o);
    }
    return { removed: ids };
  },

  duplicate(doc, op) {
    const src = findObject(doc, op.id);
    const copy = clone(src);
    copy.id = op.newId ? uniqueId(doc, slug(op.newId), { named: true }) : uniqueId(doc, src.id.replace(/-\d+$/, ''), { named: !/-\d+$/.test(src.id) });
    copy.name = op.name || copy.id;
    const off = op.offset != null ? vec3(op.offset, 'offset') : [1, 0, 0];
    copy.position = copy.position.map((v, i) => round(v + off[i]));
    doc.objects.push(copy);
    return { id: copy.id };
  },

  clear(doc, op) {
    const n = doc.objects.length;
    doc.objects = [];
    if (op.keys) doc.timeline.keys = [];
    return { removed: n };
  },

  env(doc, op) {
    for (const k of ['background', 'ground', 'grid', 'fog', 'sun', 'people']) {
      if (op[k] === undefined) continue;
      if (k === 'background') doc.env.background = color(op.background);
      else if (k === 'people') {
        if (!PERSON_DETAIL.includes(op.people)) throw new Error(`env.people must be one of ${PERSON_DETAIL.join(', ')}, got ${JSON.stringify(op.people)}`);
        doc.env.people = op.people;
      }
      else if (k === 'sun') doc.env.sun = vec3(op.sun, 'sun');
      else if (k === 'fog') doc.env.fog = Math.max(0, Number(op.fog) || 0);
      else doc.env[k] = !!op[k];
    }
    return { env: doc.env };
  },

  meta(doc, op) {
    if (op.name != null) doc.meta.name = String(op.name);
    for (const k of ['width', 'height']) {
      if (op[k] == null) continue;
      const v = Math.round(op[k]);
      if (!(v >= 16 && v <= 4096)) throw new Error(`${k} must be 16–4096 px`);
      doc.meta[k] = v + (v % 2); // encoders want even sizes
    }
    return { meta: doc.meta };
  },

  'key.add'(doc, op) {
    const tl = doc.timeline;
    const t = op.t ?? 0;
    const existing = tl.keys.find((k) => Math.abs(k.t - t) < 1e-3);
    if (existing) {
      const next = normKey({ ...op, t }, existing);
      if (!next.path) delete existing.path;
      if (!next.shudder) delete existing.shudder;
      Object.assign(existing, next);
      sortKeys(doc);
      return { id: existing.id, replaced: true };
    }
    if (op.position == null || op.target == null) throw new Error('key.add needs position and target (or use "canvas key --from-view")');
    const id = op.id || uniqueId(doc, 'k', { kind: 'keys' });
    tl.keys.push({ id, ...normKey({ ...op, t }) });
    if (t > tl.duration) tl.duration = round(t);
    sortKeys(doc);
    return { id };
  },

  'key.update'(doc, op) {
    const k = findKey(doc, op.id ?? op.index);
    const { id, index, ...rest } = op;
    const next = normKey(rest, k);
    if (!next.path) delete k.path; // path: "smooth" clears it
    if (!next.shudder) delete k.shudder; // shudder: "off" clears it
    Object.assign(k, next);
    if (k.t > doc.timeline.duration) doc.timeline.duration = k.t;
    sortKeys(doc);
    return { id: k.id };
  },

  /**
   * A preset camera move (see MOVES): from the camera's framing at shot time t (or op.from), over `over`
   * seconds. Writes a key at t that carries the move's path and ease, and a key where the move ends;
   * keys in between are replaced. Both are ordinary keys afterwards: drag, re-key or ease them.
   */
  'cam.move'(doc, op) {
    const tl = doc.timeline;
    // edit: <keyId|index> redoes the move that starts at that key, from the same framing; its end key is
    // replaced. Settings not given keep the ones it was made with.
    let edit = null, oldEnd = null;
    if (op.edit != null) {
      edit = findKey(doc, op.edit);
      const sorted = [...tl.keys].sort((a, b) => a.t - b.t);
      oldEnd = edit.path ? sorted[sorted.indexOf(edit) + 1] || null : null;
      const was = edit.path?.move ? { move: edit.path.move, ...edit.path.params } : {};
      op = { ...was, ease: edit.ease, over: oldEnd ? round(oldEnd.t - edit.t) : undefined, ...Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined)), t: edit.t };
      delete op.from;
      if (op.move == null) throw new Error(`key ${edit.id} has no move to edit: pass move`);
    }
    const name = MOVE_ALIASES[op.move] || op.move;
    const def = MOVES[name];
    if (!def) throw new Error(`unknown move "${op.move}" (moves: ${Object.keys(MOVES).join(', ')})`);
    const t0 = round(op.t ?? 0);
    if (!(t0 >= 0)) throw new Error('t must be a time ≥ 0 in seconds');
    const over = op.over ?? 3;
    if (!(over >= 1 / (tl.fps || 24) && over <= 3600)) throw new Error('over (the move\'s length) must be at least one frame, in seconds');
    const t1 = round(t0 + over);
    if (oldEnd) tl.keys = tl.keys.filter((k) => k !== oldEnd);
    const here = edit || tl.keys.find((k) => Math.abs(k.t - t0) < 1e-3);
    let start = op.from ? normKey({ ...op.from, t: t0 }) : here || sampleCamera({ ...tl, speed: 'linear' }, t0);
    if (!start) throw new Error('the shot has no camera keys yet: key a framing first, or pass from (canvas cam ... --from-view)');
    start = { position: start.position.map(round), target: start.target.map(round), fov: round(start.fov ?? 40), roll: round(start.roll ?? 0) };
    const args = op.move === 'pull-out' ? { ...op, by: -Math.abs(op.by ?? 0) || undefined, pull: true } : op;
    const made = def.make(start, args, doc, t0);
    const params = moveParams(args);
    if (args.pull && params.by == null) params.by = round(v3.len(v3.sub(made.end.position, start.position)) * -1);
    const path = { ...made.path, move: def.name, params };
    const ease = op.ease ?? 'easeInOut';
    resolveEase(ease);
    // replace what was inside the move, then key both ends
    tl.keys = tl.keys.filter((k) => k === here && !op.from ? true : !(k.t > t0 - 1e-3 && k.t < t1 + 1e-3));
    let a = tl.keys.find((k) => Math.abs(k.t - t0) < 1e-3);
    if (a) Object.assign(a, normKey({ ease, path }, a));
    else tl.keys.push(a = { id: uniqueId(doc, 'k', { kind: 'keys' }), ...normKey({ t: t0, ...start, ease, path }) });
    const b = { id: oldEnd && !tl.keys.some((k) => k.id === oldEnd.id) ? oldEnd.id : uniqueId(doc, 'k', { kind: 'keys' }), ...normKey({ t: t1, ...made.end, ease: oldEnd?.ease ?? 'easeInOut' }) };
    tl.keys.push(b);
    if (t1 > tl.duration) tl.duration = t1;
    sortKeys(doc);
    return { move: def.name, keys: [a.id, b.id], from: t0, to: t1, path: path.type, edited: !!edit };
  },

  /**
   * Give every camera segment the same ease (each key but the last). Cuts (hold keys) stay cuts unless
   * cuts: true. Pass from: <keyId> to copy that key's ease instead of naming one.
   */
  /** One ease on every camera segment: the active shot, or every shot with allShots (cuts stay cuts unless op.cuts). */
  'key.easeAll'(doc, op) {
    const ease = op.from != null ? findKey(doc, op.from).ease : op.ease;
    if (ease == null) throw new Error('key.easeAll needs ease or from');
    const tls = op.allShots && doc.shots?.length ? shotList(doc).map((s) => s.timeline) : [doc.timeline];
    let n = 0, shots = 0;
    for (const tl of tls) {
      const keys = [...tl.keys].sort((a, b) => a.t - b.t);
      let hit = false;
      for (const k of keys.slice(0, -1)) {
        if (!op.cuts && resolveEase(k.ease) === 'hold') continue;
        Object.assign(k, normKey({ ease }, k));
        n++; hit = true;
      }
      if (hit) shots++;
    }
    return { updated: n, shots, ease };
  },

  'key.remove'(doc, op) {
    const k = findKey(doc, op.id ?? op.index);
    doc.timeline.keys = doc.timeline.keys.filter((x) => x !== k);
    return { removed: k.id };
  },

  'key.clear'(doc) {
    const n = doc.timeline.keys.length;
    doc.timeline.keys = [];
    return { removed: n };
  },

  // ----- object animation -----
  /** Key an object's transform at time t (fields left out keep where the object is at t). */
  'anim.key'(doc, op) {
    const o = findObject(doc, op.id);
    const k = putAnimKey(doc, o, { t: op.t ?? 0, position: op.position, rotation: op.rotation, scale: op.scale, ease: op.ease });
    return { id: o.id, t: k.t, keys: o.anim.length };
  },

  /**
   * Move an object over time: from `at` (default 0) to `at + over` (default 1 s), ending at `to`
   * (or shifted `by`), optionally rotating/scaling. Keeps where it is at `at` as the start key.
   */
  'anim.move'(doc, op) {
    const o = findObject(doc, op.id);
    const at = op.at ?? 0, over = op.over ?? 1;
    if (!(at >= 0)) throw new Error('at must be a time ≥ 0');
    if (!(over > 0)) throw new Error('over must be a duration > 0');
    const speedless = { ...doc.timeline, speed: 'linear' };
    const start = sampleObject(o, speedless, at);
    putAnimKey(doc, o, { t: at, ...start, ease: op.ease });
    const end = {};
    if (op.to != null) end.position = vec3(op.to, 'to');
    if (op.by != null) end.position = vec3(op.by, 'by').map((v, i) => round((end.position ?? start.position)[i] + v));
    if (op.rotation != null) end.rotation = vec3(op.rotation, 'rotation');
    if (op.turn != null) end.rotation = vec3(op.turn, 'turn').map((v, i) => round((end.rotation ?? start.rotation)[i] + v));
    if (op.scale != null) end.scale = vec3(op.scale, 'scale');
    if (!Object.keys(end).length) throw new Error('anim.move needs to, by, rotation, turn or scale');
    putAnimKey(doc, o, { t: at + over, ...start, ...end, ease: op.ease });
    return { id: o.id, from: round(at), to: round(at + over), keys: o.anim.length };
  },

  'anim.remove'(doc, op) {
    const o = findObject(doc, op.id);
    const before = o.anim?.length || 0;
    const t0 = actionStart(doc);
    o.anim = (o.anim || []).filter((k) => !(op.t != null ? Math.abs(k.t - t0 - op.t) < 1e-3 : true));
    if (op.t != null && o.anim.length === before) throw new Error(`${o.id} has no key at ${op.t}s (keys at: ${(o.anim || []).map((k) => round(k.t - t0)).join(', ') || 'none'})`);
    if (o.anim.length) syncAnim(o); else delete o.anim;
    return { id: o.id, keys: o.anim?.length || 0 };
  },

  timeline(doc, op) {
    const tl = doc.timeline;
    if (op.duration != null) {
      if (!(op.duration > 0 && op.duration <= 600)) throw new Error('duration must be 0–600 s');
      if (op.retime) { // scale key times to the new duration
        const f = op.duration / tl.duration;
        tl.keys.forEach((k) => { k.t = round(k.t * f); });
        // the action is shared, so with several shots only this shot's camera is stretched. One shot: its
        // object keys stretch with it, from where the shot picks up the action (and move with a new start)
        const s0 = tl.start || 0, s1 = op.start != null ? Number(op.start) : s0;
        if (doc.shots.length < 2) doc.objects.forEach((o) => o.anim?.forEach((k) => { k.t = round(Math.max(0, s1 + (k.t - s0) * f)); }));
      }
      tl.duration = round(op.duration);
    }
    if (op.fps != null) {
      if (!(op.fps >= 1 && op.fps <= 120)) throw new Error('fps must be 1–120');
      tl.fps = Math.round(op.fps * 1000) / 1000; // decimals allowed (23.976)
    }
    if (op.interp != null) {
      if (!['smooth', 'linear'].includes(op.interp)) throw new Error('interp must be "smooth" or "linear"');
      tl.interp = op.interp;
    }
    if (op.speed != null) {
      if (op.speed === 'hold') throw new Error('the shot speed curve cannot be "hold"');
      resolveEase(op.speed);
      tl.speed = op.speed;
    }
    if (op.ease != null) { resolveEase(op.ease); tl.keys.forEach((k) => { k.ease = op.ease; }); }
    if (op.start != null) {
      if (!(op.start >= 0 && op.start <= 3600)) throw new Error('start (where this shot picks up the action) must be 0–3600 s');
      if (op.start) tl.start = round(op.start); else delete tl.start;
    }
    return { timeline: { duration: tl.duration, fps: tl.fps, interp: tl.interp, speed: tl.speed, start: tl.start || 0, keys: tl.keys.length } };
  },

  /**
   * The scene's audio track (music or dialogue to pace the cameras to; it is mixed into the export). One
   * track for the whole sequence: it sits on the action-time axis that every shot shares, so each shot plays
   * the part of it under its span of the action, and shots that follow on from each other play it straight
   * through. The file lives in the scene folder's audio/ (uploaded with "canvas audio <file>" or dropped on
   * the timeline). offset: the action time where the file's first sample sits (negative skips into the file).
   * in / out: trim, in seconds of the file: only that part is heard (null = from the start / to the end).
   * length: the file's duration, filled in by the browser once decoded.
   * beats: show the beat grid on the audio lane (a view setting kept with the scene).
   * fit: make the active shot end where the audio ends. clear: remove the track.
   */
  audio(doc, op) {
    if (op.clear) { const had = !!doc.audio; delete doc.audio; return { audio: null, removed: had }; }
    const a = { ...(doc.audio || {}) };
    if (op.file != null) {
      const f = String(op.file);
      if (!AUDIO_FILE.test(f) || f.includes('..')) throw new Error(`audio.file must be a file name in the scene's audio/ folder (mp3, wav, m4a, aac, ogg, opus, flac, webm), got ${JSON.stringify(op.file)}`);
      if (f !== a.file) { delete a.length; delete a.in; delete a.out; a.offset = 0; }
      a.file = f;
      a.name = op.name != null ? String(op.name) : f;
    } else if (op.name != null) a.name = String(op.name);
    if (!a.file) throw new Error('no audio on the timeline yet: load a file first ("canvas audio <file>")');
    if (op.offset != null) { if (!Number.isFinite(op.offset) || Math.abs(op.offset) > 3600) throw new Error('audio.offset must be seconds (−3600…3600)'); a.offset = round(op.offset); }
    if (op.volume != null) { if (!(op.volume >= 0 && op.volume <= 4)) throw new Error('audio.volume must be 0–4 (1 = as recorded)'); a.volume = round(op.volume); }
    if (op.muted != null) a.muted = !!op.muted;
    if (op.beats != null) { if (op.beats) a.beats = true; else delete a.beats; }
    if (op.length != null) { if (!(op.length > 0)) throw new Error('audio.length must be > 0 seconds'); a.length = round(op.length); }
    for (const k of ['in', 'out']) {
      if (op[k] === undefined) continue;
      if (op[k] === null) { delete a[k]; continue; }
      if (!(Number.isFinite(op[k]) && op[k] >= 0 && op[k] <= 7200)) throw new Error(`audio.${k} must be seconds into the file (0–7200), or null to clear the trim`);
      a[k] = round(op[k]);
    }
    if (a.length) { // a trim past the end of the file is no trim
      if (a.out != null && a.out >= a.length - 1e-3) delete a.out;
      if (a.in != null && a.in >= a.length) throw new Error(`audio.in must be inside the file (it is ${a.length}s long)`);
    }
    if (!(a.in > 0)) delete a.in;
    if (a.out != null && !(a.out > (a.in || 0))) throw new Error('audio.out must be after audio.in');
    a.offset ??= 0; a.volume ??= 1; a.muted ??= false;
    const tl = doc.timeline;
    if (op.fit) {
      const end = a.out ?? a.length;
      if (!end) throw new Error('the audio length is not known yet: open the canvas tab so it can read the file, then try again');
      const d = round(a.offset + end - (tl.start || 0));
      if (!(d > 0)) throw new Error('the audio ends before the shot starts (check the offset)');
      tl.duration = Math.min(600, d);
    }
    doc.audio = a;
    return { audio: a, duration: tl.duration };
  },

  // ----- shots: one set, several cameras -----
  /**
   * Add a shot after the current one and switch to it. It starts as a copy of the current shot's camera
   * and settings (from: another shot to copy instead; blank: true for the default two-key move), and picks
   * up the action where the current shot ends (start: another action time, e.g. 0 for coverage).
   * frame: true starts it on one key instead: the copied shot's framing at the moment it picks up (its last
   * frame for the next shot). duration: its length (default the copied shot's).
   * switch: false keeps the current shot active.
   */
  'shot.add'(doc, op) {
    const src = op.blank ? createDoc().timeline : shotTimeline(doc, op.from ?? doc.shot);
    const tl = clone(src);
    if (op.blank) { tl.fps = doc.timeline.fps; }
    // it picks up the action where the current shot ends (start: to choose another moment)
    const st = op.start != null ? Number(op.start) : (doc.timeline.start || 0) + doc.timeline.duration;
    if (!(st >= 0 && st <= 3600)) throw new Error('start must be 0–3600 s');
    if (st) tl.start = round(st); else delete tl.start;
    if (op.frame && !op.blank) {
      const t = Math.max(0, Math.min(src.duration, st - (src.start || 0)));
      const p = sampleCamera(src, t);
      const r3 = (v) => round(v);
      tl.keys = p ? [{ id: 'k1', ...normKey({ t: 0, position: p.position.map(r3), target: p.target.map(r3), fov: r3(p.fov), roll: r3(p.roll), ease: 'easeInOut' }) }] : [];
      tl.speed = 'linear';
    }
    if (op.duration != null) {
      if (!(op.duration > 0 && op.duration <= 600)) throw new Error('duration must be 0–600 s');
      tl.duration = round(op.duration);
    }
    const n = doc.shots.length + 1;
    const taken = new Set(doc.shots.map((s) => s.id));
    let id = op.id || op.name ? slug(op.id || op.name) : `shot-${n}`;
    if (taken.has(id)) { let i = 2; while (taken.has(`${id}-${i}`)) i++; id = `${id}-${i}`; }
    const name = op.name != null ? String(op.name) : op.id ? String(op.id) : `Shot ${n}`;
    const at = doc.shots.findIndex((s) => s.id === doc.shot);
    doc.shots.splice(at + 1, 0, { id, name, timeline: tl });
    if (op.switch !== false) activate(doc, id);
    return { id, name, start: round(st), shots: doc.shots.length, active: doc.shot };
  },

  /**
   * Cut: split the active shot at shot time `t` into two shots. This one ends at t on the framing it has
   * there; the new one (inserted after it, made active unless switch: false) picks up the action at that
   * moment with the same framing, the rest of the keys and the rest of the length.
   */
  'shot.split'(doc, op) {
    const tl = doc.timeline, F = tl.fps, f = 1 / F;
    const t = round(Math.round(Number(op.t) * F) / F);
    if (!(t >= f - 1e-6 && t <= tl.duration - f + 1e-6)) throw new Error(`cut inside the shot: t must be ${round(f)}–${round(tl.duration - f)} s`);
    if ((tl.speed ?? 'linear') !== 'linear') throw new Error('this shot has a speed curve: set it to linear before cutting (canvas timeline --speed linear)');
    const keys = [...tl.keys].sort((a, b) => a.t - b.t);
    const pose = sampleCamera(tl, t);
    const here = keys.find((k) => Math.abs(k.t - t) < 1e-3);
    const r3 = (v) => round(v);
    const framing = pose && { position: pose.position.map(r3), target: pose.target.map(r3), fov: r3(pose.fov), roll: r3(pose.roll) };
    const freeId = (ks) => { let n = 1; while (ks.some((k) => k.id === `k${n}`)) n++; return `k${n}`; };
    // the new shot: the keys after t, moved to its own time, behind a first key on the same framing
    const rest = clone(tl);
    rest.keys = keys.filter((k) => k.t > t + 1e-3).map((k) => ({ ...clone(k), t: round(k.t - t) }));
    if (here) rest.keys.unshift({ ...clone(here), t: 0, ease: here.ease === 'hold' && !rest.keys.length ? 'easeInOut' : here.ease });
    else if (framing) {
      const seg = keys[pose.segment]; // the move carries on into the new shot
      const ease = seg && seg.ease !== 'hold' && pose.segment < keys.length - 1 ? seg.ease : 'easeInOut';
      rest.keys.unshift({ id: freeId(rest.keys), ...normKey({ t: 0, ...framing, ease }) });
    }
    rest.duration = round(tl.duration - t);
    rest.start = round((tl.start || 0) + t);
    // this shot: ends at t
    tl.keys = keys.filter((k) => k.t < t + 1e-3);
    if (!here && framing) tl.keys.push({ id: freeId(tl.keys), ...normKey({ t, ...framing, ease: 'easeInOut' }) });
    tl.duration = t;
    const n = doc.shots.length + 1;
    const taken = new Set(doc.shots.map((s) => s.id));
    let id = op.id || op.name ? slug(op.id || op.name) : `shot-${n}`;
    if (taken.has(id)) { let i = 2; while (taken.has(`${id}-${i}`)) i++; id = `${id}-${i}`; }
    const name = op.name != null ? String(op.name) : op.id ? String(op.id) : `Shot ${n}`;
    doc.shots.splice(doc.shots.findIndex((s) => s.id === doc.shot) + 1, 0, { id, name, timeline: rest });
    if (op.switch !== false) activate(doc, id);
    return { id, name, at: t, shots: doc.shots.length, active: doc.shot };
  },

  /** Make a shot the active one: the timeline, camera and exports follow it. */
  'shot.use'(doc, op) {
    const s = findShot(doc, op.id ?? op.index);
    activate(doc, s.id);
    return { id: s.id, name: s.name };
  },

  'shot.update'(doc, op) {
    const s = findShot(doc, op.id ?? op.index ?? doc.shot);
    if (op.name != null) {
      const name = String(op.name).trim();
      if (!name) throw new Error('a shot needs a name');
      s.name = name;
    }
    return { id: s.id, name: s.name };
  },

  'shot.remove'(doc, op) {
    const s = findShot(doc, op.id ?? op.index ?? doc.shot);
    if (doc.shots.length < 2) throw new Error('a scene needs at least one shot');
    const i = doc.shots.indexOf(s);
    if (s.id === doc.shot) activate(doc, doc.shots[i + 1 < doc.shots.length ? i + 1 : i - 1].id);
    doc.shots.splice(doc.shots.indexOf(s), 1);
    return { removed: s.id, active: doc.shot };
  },

  /** Reorder: put a shot at position `to` (1 = first) in the sequence. */
  'shot.move'(doc, op) {
    const s = findShot(doc, op.id ?? op.index ?? doc.shot);
    const to = Math.round(op.to);
    if (!(to >= 1 && to <= doc.shots.length)) throw new Error(`to must be a position 1–${doc.shots.length}`);
    doc.shots.splice(doc.shots.indexOf(s), 1);
    doc.shots.splice(to - 1, 0, s);
    return { id: s.id, order: doc.shots.map((x) => x.id) };
  },

  'controls.set'(doc, op) {
    if (!op.key) throw new Error('controls.set needs a key');
    if (op.value === undefined) delete doc.controls[op.key];
    else doc.controls[op.key] = clone(op.value);
    return { key: op.key };
  },

  load(doc, op) {
    const next = migrate(op.doc);
    for (const k of Object.keys(doc)) delete doc[k];
    Object.assign(doc, next);
    return { objects: doc.objects.length, keys: doc.timeline.keys.length };
  },

  batch(doc, op) {
    return { results: (op.ops || []).map((o) => applyOneInPlace(doc, o)) };
  },
};

function applyOneInPlace(doc, op) {
  if (!op || typeof op.op !== 'string') throw new Error(`each op needs an "op" field, got ${JSON.stringify(op)}`);
  const fn = OPS[op.op];
  if (!fn) throw new Error(`unknown op "${op.op}" (ops: ${Object.keys(OPS).join(', ')})`);
  // shot: apply a camera/timeline op to another shot without switching to it
  if (op.shot != null && !op.op.startsWith('shot.') && op.op !== 'load' && op.op !== 'batch') {
    const target = findShot(doc, op.shot).id, was = doc.shot;
    if (target === was) return fn(doc, op);
    activate(doc, target);
    try { return fn(doc, op); } finally { activate(doc, was); }
  }
  return fn(doc, op);
}

// ----- shots -----
/** A shot by id, name or 1-based position ("2"). */
export function findShot(doc, ref) {
  const list = doc.shots || [];
  let s = list.find((x) => x.id === ref || x.name === ref);
  if (!s && /^\d+$/.test(String(ref ?? ''))) s = list[Number(ref) - 1];
  if (!s) throw new Error(`no shot ${JSON.stringify(ref)} (shots: ${list.map((x, i) => `${i + 1} ${x.id}`).join(', ') || 'none'})`);
  return s;
}

/** The timeline of a shot (the live doc.timeline for the active one). */
export function shotTimeline(doc, ref) {
  const s = findShot(doc, ref ?? doc.shot);
  return s.id === doc.shot ? doc.timeline : s.timeline;
}

/** Every shot in sequence order with its timeline: [{ id, name, active, timeline }]. */
export function shotList(doc) {
  return (doc.shots || []).map((s) => ({ id: s.id, name: s.name, active: s.id === doc.shot, timeline: s.id === doc.shot ? doc.timeline : s.timeline }));
}

// Swap the active shot: park doc.timeline in the current shot's entry and bring the other one in.
function activate(doc, id) {
  if (id === doc.shot) return;
  const cur = doc.shots.find((s) => s.id === doc.shot);
  const next = doc.shots.find((s) => s.id === id);
  if (cur) cur.timeline = doc.timeline;
  doc.timeline = next.timeline;
  delete next.timeline;
  doc.shot = id;
}

/**
 * Apply one op or an array of ops atomically. Returns { doc, results }.
 * Throws (leaving the input untouched) if any op fails.
 */
export function applyOps(doc, ops) {
  const next = clone(doc);
  const list = Array.isArray(ops) ? ops : [ops];
  const results = list.map((op, i) => {
    try {
      return applyOneInPlace(next, op);
    } catch (e) {
      e.message = list.length > 1 ? `op ${i} (${op?.op}): ${e.message}` : e.message;
      throw e;
    }
  });
  return { doc: next, results };
}

/** Fill in defaults so older or hand-written scene files load. */
export function migrate(input) {
  const base = createDoc();
  const d = clone(input || {});
  const doc = {
    ...base,
    ...d,
    meta: { ...base.meta, ...(d.meta || {}) },
    // scenes saved before env.people existed were drawn with the mannequin, so they keep it
    env: { ...base.env, people: 'high', ...(d.env || {}) },
    timeline: { ...base.timeline, ...(d.timeline || {}) },
    controls: { ...(d.controls || {}) },
    objects: [],
  };
  doc.timeline = normTimeline(d.timeline);
  // Scenes from before shots had one timeline: that becomes the only shot.
  const shots = [];
  for (const [i, s] of (Array.isArray(d.shots) ? d.shots : []).entries()) {
    let id = slug(s?.id || s?.name || `shot-${i + 1}`);
    while (shots.some((x) => x.id === id)) id += '-2';
    shots.push({ id, name: String(s?.name || id), ...(s?.timeline ? { timeline: normTimeline(s.timeline) } : {}) });
  }
  if (!shots.length) shots.push({ id: 'shot-1', name: 'Shot 1' });
  const active = shots.find((s) => s.id === d.shot) || shots[0];
  for (const s of shots) {
    if (s === active) delete s.timeline; // the active shot's timeline is doc.timeline
    else s.timeline ||= normTimeline();
  }
  doc.shots = shots;
  doc.shot = active.id;
  // Scenes from before the audio track spanned the sequence kept it on a shot's timeline (offset in that
  // shot's time): the active shot's (else the first shot's that has one) becomes the scene's, in action time.
  if (!d.audio) {
    const own = [{ id: active.id, timeline: d.timeline }, ...(Array.isArray(d.shots) ? d.shots : [])].find((s) => s?.timeline?.audio?.file);
    if (own) { const a = { ...own.timeline.audio }; a.offset = round((a.offset || 0) + (own.timeline.start > 0 ? own.timeline.start : 0)); doc.audio = a; }
  }
  if (!doc.audio?.file) delete doc.audio;
  for (const o of d.objects || []) {
    let params = o.params;
    // People made before bodies existed were all stored at h 1.8; let them use their body's usual height.
    if (o.type === 'person' && params && params.body == null && params.h === 1.8) params = { ...params, h: null };
    // A saved file may carry params this version does not have (from an older or unmerged build, e.g. a
    // person's pose); drop them so the rest of the scene still opens instead of refusing the whole file.
    const known = PRIMITIVES[o.type]?.params;
    if (known && params) params = Object.fromEntries(Object.entries(params).filter(([k]) => k in known));
    const { doc: tmp } = applyOps(doc, { op: 'add', ...o, params });
    doc.objects = tmp.objects;
  }
  doc.version = 1;
  return doc;
}

function normTimeline(input) {
  const base = createDoc().timeline;
  const tl = { ...base, ...(input || {}) };
  if (!input?.keys) tl.keys = base.keys;
  tl.keys = tl.keys.map((k, i) => ({ id: k.id || `k${i + 1}`, ...normKey(k) })).sort((a, b) => a.t - b.t);
  if (!(tl.start > 0)) delete tl.start;
  delete tl.audio; // the audio track is the scene's now (doc.audio)
  return tl;
}

/** One-line description of an object, for agents. */
export function describe(o) {
  const p = Object.entries(o.params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(' ');
  const r = o.rotation.some((v) => v) ? ` rot=${o.rotation.join(',')}` : '';
  const s = o.scale.some((v) => v !== 1) ? ` scale=${o.scale.join(',')}` : '';
  const a = o.anim?.length ? ` anim: ${o.anim.map((k) => `${k.t}s@${k.position.join(',')}${k.rotation.some((v) => v) ? ` rot=${k.rotation.join(',')}` : ''}`).join(' → ')}` : '';
  return `${o.id} (${o.type} ${p}) pos=${o.position.join(',')}${r}${s} ${o.color}${o.note ? ` — ${o.note}` : ''}${a}`;
}

export const EASE_NAMES = Object.keys(EASES);
