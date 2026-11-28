import http from 'node:http';
// Fast checks: core document ops, easing math, and that the skill copies are in sync. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, applyOps, migrate, PRIMITIVES, shotList, shotTimeline, PERSON_POSES, PERSON_JOINTS, objectHeight, parseJoints, describe } from '../core/doc.js';
import { shotBrief, briefText, describeMove, ratioOf, timelineBrief, timelineText } from '../core/brief.js';
import { findSlots, fillRecipe, listRecipes, BUILTIN } from '../skills/blockout-render/scripts/recipe.mjs';
import { bezier, sampleCamera, sampleObject, resolveEase, EASES, remapTime, fovToLens, lensToFov, isCut, sweep, splitEase, removeEasePoint, easeName, easeSegments, shudderOffset } from '../core/curves.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('add assigns readable ids and validates', () => {
  const { doc, results } = applyOps(createDoc(), [
    { op: 'add', type: 'box' }, { op: 'add', type: 'box' }, { op: 'add', type: 'box', name: 'Crate' }, { op: 'add', type: 'box', name: 'crate' },
  ]);
  assert.deepEqual(results.map((r) => r.id), ['box-1', 'box-2', 'crate', 'crate-2']);
  assert.throws(() => applyOps(doc, { op: 'add', type: 'box', w: 'x' }), /must be a number/);
  assert.throws(() => applyOps(doc, { op: 'add', type: 'box', r: 1 }), /no field or param "r"/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'nope' }), /no object/);
});

test('ops are atomic', () => {
  const d0 = createDoc();
  assert.throws(() => applyOps(d0, [{ op: 'add', type: 'box' }, { op: 'add', type: 'nope' }]), /op 1/);
  assert.equal(d0.objects.length, 0);
});

test('size maps to each type’s main params', () => {
  const { doc } = applyOps(createDoc(), [{ op: 'add', type: 'cylinder', size: [0.3, 4] }, { op: 'add', type: 'box', size: [2, 3, 4] }]);
  assert.deepEqual(doc.objects[0].params, { r: 0.3, h: 4, rTop: null });
  assert.deepEqual(doc.objects[1].params, { w: 2, h: 3, d: 4 });
});

test('key.add at an existing time updates that key; keys stay sorted', () => {
  let { doc } = applyOps(createDoc(), { op: 'key.add', t: 2, position: [1, 1, 1], target: [0, 0, 0] });
  ({ doc } = applyOps(doc, { op: 'key.add', t: 2, fov: 30 }));
  assert.deepEqual(doc.timeline.keys.map((k) => k.t), [0, 2, 5]);
  assert.equal(doc.timeline.keys[1].fov, 30);
  ({ doc } = applyOps(doc, { op: 'key.update', index: 1, t: 6 }));
  assert.deepEqual(doc.timeline.keys.map((k) => k.t), [0, 5, 6]);
  assert.equal(doc.timeline.duration, 6);
});

test('timeline retime scales key times', () => {
  const { doc } = applyOps(createDoc(), { op: 'timeline', duration: 10, retime: true });
  assert.deepEqual(doc.timeline.keys.map((k) => k.t), [0, 10]);
});

test('timeline retime from the left edge: one shot stretches its object keys from its new start', () => {
  let { doc } = applyOps(createDoc(), { op: 'add', type: 'box', name: 'car' });
  ({ doc } = applyOps(doc, [{ op: 'anim.key', id: 'car', t: 0, position: [0, 0, 0] }, { op: 'anim.key', id: 'car', t: 5, position: [5, 0, 0] }]));
  // drag the left edge 1 s right: the shot shows 1..5 of the action, 4 s long, everything squeezed into it
  ({ doc } = applyOps(doc, { op: 'timeline', start: 1, duration: 4, retime: true }));
  assert.equal(doc.timeline.start, 1);
  assert.deepEqual(doc.timeline.keys.map((k) => k.t), [0, 4]);
  assert.deepEqual(doc.objects[0].anim.map((k) => k.t), [1, 5]);
});

test('bezier easing', () => {
  for (const [name, b] of Object.entries(EASES)) {
    if (b === 'hold') continue;
    assert.equal(bezier(b, 0), 0, name); assert.equal(bezier(b, 1), 1, name);
  }
  assert.ok(Math.abs(bezier(EASES.easeInOut, 0.5) - 0.5) < 1e-6);
  assert.ok(bezier(EASES.easeIn, 0.25) < 0.25 && bezier(EASES.easeOut, 0.25) > 0.25);
  assert.ok(bezier(EASES.overshoot, 0.6) > 1);
  assert.equal(bezier('hold', 0.99), 0);
  assert.throws(() => resolveEase('wobble'), /unknown ease/);
});

test('multi-point eases: add points without changing the shape, pass through them, remove them', () => {
  const near = (b, c) => { let m = 0; for (let i = 0; i <= 200; i++) m = Math.max(m, Math.abs(bezier(b, i / 200) - bezier(c, i / 200))); return m; };
  for (const [name, b] of Object.entries(EASES)) {
    if (b === 'hold') continue;
    let e = b;
    for (const x of [0.37, 0.8, 0.1]) e = splitEase(e, x).ease;
    assert.equal(e.length, 4 + 6 * 3, name);
    assert.ok(near(b, e) < 1e-3, `${name} keeps its shape after adding points`);
    assert.equal(easeName(e), 'custom');
  }
  const { ease, point } = splitEase('linear', 0.5);
  assert.equal(point, 1);
  // move the point up: the curve passes through it and still starts at 0 and ends at 1
  const up = [...ease]; up[5] = 0.8;
  assert.ok(Math.abs(bezier(resolveEase(up), 0.5) - 0.8) < 1e-6);
  assert.equal(bezier(resolveEase(up), 0), 0); assert.equal(bezier(resolveEase(up), 1), 1);
  assert.equal(easeSegments(up).length, 2);
  // removing the only point gives back a one-segment curve
  assert.equal(removeEasePoint(up, 1).length, 4);
  // removing a point that was only added gives back the curve it came from
  for (const [name, x] of [['easeInOut', 0.5], ['easeIn', 0.3], ['snap', 0.8], ['overshoot', 0.2]]) {
    assert.equal(easeName(removeEasePoint(splitEase(name, x).ease, 1)), name, `${name} comes back`);
  }
  assert.throws(() => resolveEase([0.1, 0, 0.2, 1, 0.5]), /bad ease/);
  // point x is kept moving forward
  const r = resolveEase([0.2, 0, 0.3, 0.4, 1.5, 0.5, 0.2, 0.6, 0.9, 1]);
  assert.equal(r[4], 1);
  // a camera key and the speed curve take them, and an old 4-number curve still loads
  let { doc } = applyOps(createDoc(), [{ op: 'key.update', id: 'k1', ease: up }, { op: 'timeline', speed: up }]);
  assert.deepEqual(doc.timeline.keys[0].ease, up);
  const mid = sampleCamera({ ...doc.timeline, speed: 'linear' }, doc.timeline.keys[1].t / 2);
  assert.ok(Math.abs(mid.local - 0.8) < 1e-6);
  ({ doc } = applyOps(doc, { op: 'key.easeAll', from: 'k1', allShots: true }));
  assert.deepEqual(doc.timeline.keys[0].ease, up);
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', ease: [0.2, 0, 0.3, 1] }));
  assert.deepEqual(doc.timeline.keys[0].ease, [0.2, 0, 0.3, 1]);
});

test('camera sampling hits keys and respects ease and speed', () => {
  const tl = { duration: 4, interp: 'linear', speed: 'linear', keys: [
    { t: 0, position: [0, 0, 0], target: [0, 0, -1], fov: 40, ease: 'linear' },
    { t: 4, position: [4, 0, 0], target: [0, 0, -1], fov: 20, ease: 'linear' }] };
  assert.deepEqual(sampleCamera(tl, 2).position, [2, 0, 0]);
  assert.equal(sampleCamera(tl, 2).fov, 30);
  assert.deepEqual(sampleCamera(tl, 9).position, [4, 0, 0]);
  tl.keys[0].ease = 'hold';
  assert.deepEqual(sampleCamera(tl, 3.9).position, [0, 0, 0]);
  tl.keys[0].ease = 'linear'; tl.speed = 'easeIn';
  assert.ok(remapTime(tl, 1) < 1 && sampleCamera(tl, 1).position[0] < 1);
  tl.interp = 'smooth';
  const s = sampleCamera(tl, 4); assert.deepEqual(s.position, [4, 0, 0]);
});

test('a hold key is a clean cut: the smooth path on each side ignores the other shot', () => {
  const tl = { duration: 4, interp: 'smooth', speed: 'linear', keys: [
    { t: 0, position: [0, 0, 0], target: [0, 0, -5], fov: 40, ease: 'linear' },
    { t: 2, position: [2, 0, 0], target: [2, 0, -5], fov: 40, ease: 'hold' }, // shot A ends: cut
    { t: 2 + 1 / 24, position: [10, 0, 10], target: [10, 0, 5], fov: 30, ease: 'linear' }, // shot B starts a frame later
    { t: 4, position: [10, 0, 14], target: [10, 0, 9], fov: 30, ease: 'linear' }] };
  assert.ok(isCut(tl.keys[1]) && !isCut(tl.keys[0]));
  const a = sampleCamera(tl, 1), b = sampleCamera(tl, 3);
  assert.ok(Math.abs(a.position[2]) < 1e-9 && Math.abs(a.position[0] - 1) < 1e-9, `shot A stays on its own line (${a.position})`);
  assert.ok(Math.abs(b.position[0] - 10) < 1e-9, `shot B stays on its own line (${b.position})`);
  assert.deepEqual(sampleCamera(tl, 2).position, [2, 0, 0]); // last frame of shot A
  assert.deepEqual(sampleCamera(tl, 2 + 1 / 24).position, [10, 0, 10]); // next frame is shot B
  assert.equal(sampleCamera(tl, 2.02).fov, 40); // nothing blends during the cut
});

test('lens ↔ fov', () => { assert.ok(Math.abs(fovToLens(lensToFov(35)) - 35) < 1e-9); });

test('migrate fills defaults and round-trips', () => {
  const d = migrate({ objects: [{ type: 'sphere', position: [1, 0, 0] }] });
  assert.equal(d.objects[0].id, 'sphere-1');
  assert.equal(d.timeline.keys.length, 2);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(d))), d);
});

test('migrate drops params this version does not know instead of refusing the scene', () => {
  const d = migrate({ objects: [{ id: 'fig', type: 'person', params: { body: 'female', wingspan: 2 } }] });
  assert.equal(d.objects[0].params.body, 'female');
  assert.ok(!('wingspan' in d.objects[0].params));
  assert.throws(() => applyOps(d, { op: 'add', type: 'person', params: { wingspan: 2 } }), /no param "wingspan"/);
});

test('every primitive has a geometry builder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/geometry.js'), 'utf8');
  for (const t of Object.keys(PRIMITIVES)) assert.match(src, new RegExp(`\\b${t}[:(]`), t);
});

test('skill copies for Claude and Codex match the canonical skills', () => {
  const list = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
  for (const skill of ['blockout', 'blockout-render']) {
    const src = path.join(ROOT, 'skills', skill);
    for (const copy of [path.join(ROOT, '.claude/skills', skill), path.join(ROOT, '.agents/skills', skill)]) {
      assert.deepEqual(list(copy), list(src), `${copy}: run npm run skills:sync`);
      for (const f of list(src)) assert.equal(fs.readFileSync(path.join(copy, f), 'utf8'), fs.readFileSync(path.join(src, f), 'utf8'), `${skill}/${f}: run npm run skills:sync`);
    }
  }
});

test('frame rate defaults to 24 and accepts decimals', () => {
  assert.equal(createDoc().timeline.fps, 24);
  const { doc } = applyOps(createDoc(), [{ op: 'timeline', fps: 23.976 }]);
  assert.equal(doc.timeline.fps, 23.976);
  assert.throws(() => applyOps(createDoc(), [{ op: 'timeline', fps: 0.5 }]));
});

test('objects move over time with anim.move and stay put without keys', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'add', type: 'person', name: 'hero', position: [0, 0, 5] }]);
  const still = sampleObject(doc.objects[0], doc.timeline, 2);
  assert.deepEqual(still.position, [0, 0, 5]);
  ({ doc } = applyOps(doc, { op: 'anim.move', id: 'hero', to: [0, 0, -1], at: 1, over: 3, ease: 'linear' }));
  const o = doc.objects[0];
  assert.deepEqual(o.anim.map((k) => k.t), [1, 4]);
  assert.deepEqual(sampleObject(o, doc.timeline, 0).position, [0, 0, 5]);
  assert.deepEqual(sampleObject(o, doc.timeline, 2.5).position, [0, 0, 2]);
  assert.deepEqual(sampleObject(o, doc.timeline, 9).position, [0, 0, -1]);
  // chaining: the next move starts where the last one ended
  ({ doc } = applyOps(doc, { op: 'anim.move', id: 'hero', by: [2, 0, 0], turn: [0, 90, 0], at: 4, over: 1 }));
  assert.deepEqual(doc.objects[0].anim.at(-1).position, [2, 0, -1]);
  assert.deepEqual(doc.objects[0].anim.at(-1).rotation, [0, 90, 0]);
  assert.equal(doc.timeline.duration, 5);
  // moving an animated object shifts the whole move; the scene file round-trips
  ({ doc } = applyOps(doc, { op: 'update', id: 'hero', move: [1, 0, 0] }));
  assert.deepEqual(doc.objects[0].anim.map((k) => k.position[0]), [1, 1, 3]);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(doc))).objects[0].anim, doc.objects[0].anim);
  ({ doc } = applyOps(doc, { op: 'anim.remove', id: 'hero' }));
  assert.equal(doc.objects[0].anim, undefined);
  assert.throws(() => applyOps(doc, { op: 'anim.move', id: 'hero', at: 0, over: 1 }), /needs to, by/);
});

test('the builder helper definition is generated from the skill reference', () => {
  const ref = fs.readFileSync(path.join(ROOT, 'skills/blockout/references/builder.md'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, '.claude/agents/canvas-builder.md'), 'utf8');
  const body = ref.replace(/^# .*\n+(<!--[\s\S]*?-->\n+)?/, '');
  assert.ok(agent.startsWith('---\nname: canvas-builder\n'), 'frontmatter');
  assert.ok(agent.endsWith(body), 'run npm run skills:sync after editing references/builder.md');
});

test('person bodies: male, female or child, height follows the body unless set', () => {
  const { doc } = applyOps(createDoc(), [
    { op: 'add', type: 'person', name: 'a' },
    { op: 'add', type: 'person', name: 'b', body: 'female' },
    { op: 'add', type: 'person', name: 'c', body: 'child', h: 1.1 },
  ]);
  assert.deepEqual(doc.objects.map((o) => o.params), [{ h: null, body: 'male', detail: null, pose: 'stand', joints: null }, { h: null, body: 'female', detail: null, pose: 'stand', joints: null }, { h: 1.1, body: 'child', detail: null, pose: 'stand', joints: null }]);
  assert.throws(() => applyOps(doc, { op: 'add', type: 'person', body: 'robot' }), /one of male, female, child/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'a', body: 2 }), /one of/);
  // scenes saved before bodies existed stored every person at 1.8 m; they now take their body's height
  const old = migrate({ objects: [{ type: 'person', id: 'p', params: { h: 1.8 } }, { type: 'person', id: 'q', params: { h: 1.2 } }] });
  assert.deepEqual(old.objects.map((o) => o.params.h), [null, 1.2]);
});

test('person detail: high or low per person, else the scene\'s env.people', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'add', type: 'person', name: 'a' }, { op: 'add', type: 'person', name: 'b', detail: 'low' }]);
  assert.equal(doc.env.people, 'low');
  assert.deepEqual(doc.objects.map((o) => o.params.detail), [null, 'low']);
  ({ doc } = applyOps(doc, { op: 'env', people: 'high' }));
  assert.equal(doc.env.people, 'high');
  assert.equal(migrate(doc).env.people, 'high');
  assert.equal(migrate(createDoc()).env.people, 'low');
  assert.throws(() => applyOps(doc, { op: 'env', people: 'medium' }), /env.people must be one of high, low/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'a', detail: 'medium' }), /one of high, low/);
  // scenes saved before env.people existed draw people in high detail
  assert.equal(migrate({ objects: [] }).env.people, 'high');
});

test('a mannequin exists for every body: closed parts, 1 unit tall, feet on the ground, facing +z', async () => {
  const { mannequin, BODIES } = await import('../app/mannequin.js');
  assert.deepEqual(Object.keys(BODIES).sort(), [...PRIMITIVES.person.choices.body].sort());
  for (const body of Object.keys(BODIES)) {
    const g = mannequin(body), p = g.attributes.position.array, i = g.index.array;
    assert.equal(mannequin(body), g, `${body} is built once`);
    assert.ok(i.length / 3 <= 4000, `${body}: ${i.length / 3} triangles`);
    assert.ok(i.every((k) => k < p.length / 3), `${body}: indices in range`);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < p.length; k++) { lo[k % 3] = Math.min(lo[k % 3], p[k]); hi[k % 3] = Math.max(hi[k % 3], p[k]); }
    assert.ok(lo[1] === 0 && hi[1] === 1, `${body} spans y ${lo[1]}..${hi[1]}`);
    assert.ok(Math.abs(lo[0] + hi[0]) < 1e-6, `${body}: left mirrors right`);
    assert.ok(hi[2] > -lo[2] * 1.5, `${body}: the toes point to +z`);
    // every part is a closed surface facing outward: each edge joins two triangles, and the volume is positive
    const edges = new Map();
    let volume = 0;
    for (let t = 0; t < i.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((e) => [p[i[t + e] * 3], p[i[t + e] * 3 + 1], p[i[t + e] * 3 + 2]]);
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      for (let e = 0; e < 3; e++) { const m = i[t + e], n = i[t + (e + 1) % 3], key = m < n ? `${m},${n}` : `${n},${m}`; edges.set(key, (edges.get(key) || 0) + 1); }
    }
    for (const [key, count] of edges) assert.equal(count, 2, `${body}: edge ${key} has ${count} triangles`);
    assert.ok(volume > 0.01 && volume < 0.03, `${body}: volume ${volume.toFixed(4)} of a 1 unit cube`);
  }
});

test('person poses: a named pose plus joint overrides; old scenes with pose sit load', async () => {
  let { doc } = applyOps(createDoc(), [
    { op: 'add', type: 'person', name: 'a', pose: 'sit' },
    { op: 'add', type: 'person', name: 'b', joints: { kneeL: 45, shoulderR: [80, 0, 10.00001] } },
  ]);
  assert.equal(doc.objects[0].params.pose, 'sit');
  assert.deepEqual(doc.objects[1].params.joints, { kneeL: 45, shoulderR: [80, 0, 10] });
  assert.throws(() => applyOps(doc, { op: 'update', id: 'a', pose: 'moonwalk' }), /one of stand, walk/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'a', joints: { tail: 3 } }), /no joint "tail"/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'a', joints: { kneeL: [1, 2, 3, 4] } }), /degrees/);
  ({ doc } = applyOps(doc, { op: 'update', id: 'b', joints: null }));
  assert.equal(doc.objects[1].params.joints, null);
  // a seated person stands lower, so the camera aims lower at them
  assert.ok(objectHeight(doc.objects[0]) < 1.5 && objectHeight(doc.objects[1]) === 1.8);
  // the CLI's text form of joints, and how ls shows them (stand is not shown)
  assert.deepEqual(parseJoints('kneeL=90 shoulderR=80,0,10'), { kneeL: 90, shoulderR: [80, 0, 10] });
  assert.deepEqual(parseJoints('{"neck": [0, 0, 20]}'), { neck: [0, 0, 20] });
  assert.equal(parseJoints('null'), null);
  assert.throws(() => parseJoints('kneeL'), /joint=degrees/);
  ({ doc } = applyOps(doc, { op: 'update', id: 'b', joints: { kneeL: 90, shoulderR: [80, 0, 10] } }));
  assert.match(describe(doc.objects[1]), /\(person body=male joints="kneeL=90 shoulderR=80,0,10"\)/);
  assert.match(describe(doc.objects[0]), /pose=sit/);
  // the unmerged chat-sidebar build saved people with pose stand|sit (and the bedroom scene sits one)
  const old = migrate({ objects: [{ type: 'person', id: 'fig', params: { h: null, body: 'female', detail: null, pose: 'sit' } }] });
  assert.equal(old.objects[0].params.pose, 'sit');
});

test('every pose and joint has a mannequin: same parts, feet or seat on the ground, standing scale kept', async () => {
  const { mannequin, POSES, JOINTS } = await import('../app/mannequin.js');
  assert.deepEqual(Object.keys(POSES), Object.keys(PERSON_POSES));
  assert.deepEqual([...JOINTS].sort(), [...PERSON_JOINTS].sort());
  for (const [pose, joints] of Object.entries(POSES)) for (const j of Object.keys(joints)) assert.ok(JOINTS.includes(j), `${pose}: ${j}`);
  const stand = mannequin('male');
  assert.equal(mannequin('male', 'stand'), stand);
  for (const pose of Object.keys(POSES)) {
    const g = mannequin('male', pose), p = g.attributes.position.array;
    assert.equal(g.index.count, stand.index.count, `${pose}: same triangles`);
    let lo = Infinity, hi = -Infinity;
    for (let k = 1; k < p.length; k += 3) { lo = Math.min(lo, p[k]); hi = Math.max(hi, p[k]); }
    assert.ok(Math.abs(lo) < 1e-6, `${pose}: lowest point on the ground`);
    // the core's height for the pose matches the figure (raised arms may go higher)
    assert.ok(hi >= PERSON_POSES[pose].top - 0.03, `${pose}: top ${hi.toFixed(3)} vs ${PERSON_POSES[pose].top}`);
    if (!['reach-up', 'wave'].includes(pose)) assert.ok(hi <= PERSON_POSES[pose].top + 0.03, `${pose}: top ${hi.toFixed(3)} vs ${PERSON_POSES[pose].top}`);
  }
  // joints override the pose; the same body, pose and joints is built once
  const bent = mannequin('female', 'stand', { elbowR: 90 });
  assert.notEqual(bent, mannequin('female'));
  assert.equal(mannequin('female', 'stand', { elbowR: 90 }), bent);
});

test('the Claude Code plugin manifests parse and their hooks run the same CLI as the checkout hooks', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const plugin = read('.claude-plugin/plugin.json'), market = read('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'blockout');
  assert.ok(market.plugins.some((p) => p.name === plugin.name && p.source === './'));
  for (const a of plugin.agents || []) assert.ok(fs.existsSync(path.join(ROOT, a)), `${a} is missing`);
  const pluginHooks = read('hooks/hooks.json').hooks, repoHooks = read('.claude/settings.json').hooks;
  for (const ev of ['Stop', 'UserPromptSubmit']) {
    const a = pluginHooks[ev][0].hooks[0].command.split('bin/canvas.mjs')[1];
    const b = repoHooks[ev][0].hooks[0].command.split('bin/canvas.mjs')[1];
    assert.equal(a, b, `${ev} hook differs between hooks/hooks.json and .claude/settings.json`);
  }
  assert.ok(fs.statSync(path.join(ROOT, 'bin/canvas')).mode & 0o111, 'bin/canvas must be executable');
});

test('the plugin has no fixed version, so installed copies follow main', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(m.version, undefined);
  const mk = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
  assert.ok(mk.plugins.every((p) => p.version === undefined));
});

test('launchInfo tells Claude Code, Codex and a terminal apart, and finds the plugin', async () => {
  const { launchInfo } = await import('../server/index.mjs');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-'));
  assert.equal(launchInfo({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: none }).by, 'claude');
  assert.equal(launchInfo({ CODEX_SANDBOX: 'seatbelt', CLAUDE_CONFIG_DIR: none }).by, 'codex');
  const t = launchInfo({ CLAUDE_CONFIG_DIR: none });
  assert.equal(t.by, 'terminal');
  assert.equal(t.plugin, false);
  fs.mkdirSync(path.join(none, 'plugins'));
  fs.writeFileSync(path.join(none, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'blockout@blockout': [{}] } }));
  assert.equal(launchInfo({ CLAUDE_CONFIG_DIR: none }).plugin, true);
  assert.equal(launchInfo({}, '/Users/x/.claude/plugins/cache/blockout/0.3.0').plugin, true);
});

test('audio op: load, offset, volume, fit, replace, clear', () => {
  assert.throws(() => applyOps(createDoc(), { op: 'audio', offset: 1 }), /no audio on the timeline/);
  assert.throws(() => applyOps(createDoc(), { op: 'audio', file: '../x.mp3' }), /file name/);
  assert.throws(() => applyOps(createDoc(), { op: 'audio', file: 'song.txt' }), /file name/);
  let { doc } = applyOps(createDoc(), { op: 'audio', file: 'song-1.mp3', name: 'Song.mp3' });
  assert.deepEqual(doc.audio, { file: 'song-1.mp3', name: 'Song.mp3', offset: 0, volume: 1, muted: false });
  assert.equal(doc.timeline.audio, undefined, 'the track is the scene\'s, not the shot\'s');
  assert.throws(() => applyOps(doc, { op: 'audio', fit: true }), /length is not known/);
  ({ doc } = applyOps(doc, { op: 'audio', length: 12.3456, offset: -2, volume: 0.5, muted: true }));
  assert.equal(doc.audio.length, 12.346);
  assert.equal(doc.audio.offset, -2);
  assert.equal(doc.audio.muted, true);
  ({ doc } = applyOps(doc, { op: 'audio', fit: true }));
  assert.equal(doc.timeline.duration, 10.346);
  assert.throws(() => applyOps(doc, { op: 'audio', volume: 9 }), /volume/);
  // a new file resets the offset, trim and the known length, keeps volume
  ({ doc } = applyOps(doc, { op: 'audio', in: 1, out: 5 }));
  ({ doc } = applyOps(doc, { op: 'audio', file: 'other.wav' }));
  assert.equal(doc.audio.offset, 0);
  assert.equal(doc.audio.length, undefined);
  assert.equal(doc.audio.in, undefined); assert.equal(doc.audio.out, undefined);
  assert.equal(doc.audio.volume, 0.5);
  assert.equal(migrate(doc).audio.file, 'other.wav');
  ({ doc } = applyOps(doc, { op: 'audio', beats: true }));
  assert.equal(doc.audio.beats, true, 'beats shown');
  ({ doc } = applyOps(doc, { op: 'audio', file: 'third.wav' }));
  assert.equal(doc.audio.beats, true, 'showing beats survives replacing the file');
  ({ doc } = applyOps(doc, { op: 'audio', beats: false }));
  assert.equal('beats' in doc.audio, false, 'hiding beats leaves no field');
  ({ doc } = applyOps(doc, { op: 'audio', clear: true }));
  assert.equal(doc.audio, undefined);
});

test('audio: one track spans every shot, trims, fits the active shot, migrates from a shot', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'timeline', duration: 4 }, { op: 'audio', file: 'song.mp3', length: 20 }, { op: 'shot.add' }]);
  assert.equal(doc.shot, 'shot-2');
  assert.equal(doc.audio.file, 'song.mp3', 'every shot has the same track');
  for (const s of shotList(doc)) assert.equal(s.timeline.audio, undefined);
  // trim: in / out are seconds into the file
  ({ doc } = applyOps(doc, { op: 'audio', in: 2.5, out: 11 }));
  assert.equal(doc.audio.in, 2.5); assert.equal(doc.audio.out, 11);
  assert.throws(() => applyOps(doc, { op: 'audio', in: 12 }), /after audio.in/);
  assert.throws(() => applyOps(doc, { op: 'audio', in: 25 }), /inside the file/);
  assert.throws(() => applyOps(doc, { op: 'audio', out: -1 }), /seconds into the file/);
  assert.equal(applyOps(doc, { op: 'audio', out: 30 }).doc.audio.out, undefined, 'out past the end is no trim');
  assert.equal(applyOps(doc, { op: 'audio', in: 0 }).doc.audio.in, undefined);
  assert.equal(applyOps(doc, { op: 'audio', in: null, out: null }).doc.audio.in, undefined);
  // fit: the active shot (starting at 4 s of the action) ends where the trimmed clip ends (offset 1 + 11)
  ({ doc } = applyOps(doc, { op: 'audio', offset: 1, fit: true }));
  assert.equal(doc.timeline.start, 4); assert.equal(doc.timeline.duration, 8);
  assert.equal(shotTimeline(doc, 'shot-1').duration, 4, 'the other shot keeps its length');
  // splitting a shot leaves the track alone
  const off = doc.audio.offset;
  ({ doc } = applyOps(doc, { op: 'shot.split', t: 2 }));
  assert.equal(doc.audio.offset, off);
  // old scenes kept it on a shot's timeline in that shot's time: it moves to the scene, in action time
  const old = createDoc();
  old.shots = [{ id: 'shot-1', name: 'Shot 1', timeline: { ...old.timeline, audio: { file: 'x.wav', name: 'x.wav', offset: 0.5, volume: 1, muted: false } } }, { id: 'shot-2', name: 'Shot 2' }];
  old.shot = 'shot-2';
  old.timeline = { ...old.timeline, start: 3, audio: { file: 'y.wav', name: 'y.wav', offset: -1, volume: 1, muted: false } };
  const m = migrate(old);
  assert.equal(m.audio.file, 'y.wav', 'the active shot\'s track wins');
  assert.equal(m.audio.offset, 2, 'its offset moves into action time');
  for (const s of shotList(m)) assert.equal(s.timeline.audio, undefined);
  delete old.timeline.audio;
  assert.equal(migrate(old).audio.offset, 0.5, 'else the first shot that has one');
});

test('key.easeAll gives every segment one ease, keeps cuts, and can copy a key', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'key.clear' },
    { op: 'key.add', t: 0, position: [0, 1, 5], target: [0, 1, 0] },
    { op: 'key.add', t: 1, position: [1, 1, 5], target: [0, 1, 0], ease: 'hold' },
    { op: 'key.add', t: 1.1, position: [3, 1, 5], target: [0, 1, 0] },
    { op: 'key.add', t: 3, position: [4, 1, 5], target: [0, 1, 0], ease: 'linear' }]);
  const ids = () => [...doc.timeline.keys].sort((a, b) => a.t - b.t);
  const first = ids()[0].id;
  ({ doc } = applyOps(doc, { op: 'key.update', id: first, ease: [0.2, 0, 0.3, 1] }));
  const r = applyOps(doc, { op: 'key.easeAll', from: first });
  doc = r.doc;
  assert.equal(r.results[0].updated, 2);
  assert.deepEqual(ids().map((k) => k.ease), [[0.2, 0, 0.3, 1], 'hold', [0.2, 0, 0.3, 1], 'linear']);
  ({ doc } = applyOps(doc, { op: 'key.easeAll', ease: 'easeIn', cuts: true }));
  assert.deepEqual(ids().slice(0, 3).map((k) => k.ease), ['easeIn', 'easeIn', 'easeIn']);
});

test('key.easeAll with allShots reaches every shot, active or not', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'key.clear' },
    { op: 'key.add', t: 0, position: [0, 1, 5], target: [0, 1, 0] },
    { op: 'key.add', t: 2, position: [1, 1, 5], target: [0, 1, 0] }]);
  ({ doc } = applyOps(doc, { op: 'shot.add', blank: true }));
  const [s1, s2] = doc.shots.map((s) => s.id);
  ({ doc } = applyOps(doc, [{ op: 'key.clear', shot: s2 }, { op: 'key.add', shot: s2, t: 0, position: [5, 1, 5], target: [0, 1, 0] },
    { op: 'key.add', shot: s2, t: 1, position: [6, 1, 5], target: [0, 1, 0], ease: 'hold' },
    { op: 'key.add', shot: s2, t: 1.1, position: [6, 1, 4], target: [0, 1, 0] },
    { op: 'key.add', shot: s2, t: 3, position: [7, 1, 5], target: [0, 1, 0] }]));
  const eases = (id) => [...shotTimeline(doc, id).keys].sort((a, b) => a.t - b.t).slice(0, -1).map((k) => k.ease);
  // without allShots only the targeted shot changes
  const one = applyOps(doc, { op: 'key.easeAll', shot: s1, ease: 'easeIn' }).doc;
  assert.ok(!shotTimeline(one, s2).keys.some((k) => k.ease === 'easeIn'));
  const r = applyOps(doc, { op: 'key.easeAll', ease: [0.1, 0, 0.4, 1], allShots: true });
  doc = r.doc;
  assert.equal(r.results[0].shots, 2);
  assert.deepEqual(eases(s1), [[0.1, 0, 0.4, 1]]);
  assert.deepEqual(eases(s2), [[0.1, 0, 0.4, 1], 'hold', [0.1, 0, 0.4, 1]]);
});

test('new chat archives the conversation; past chats list and read back', async () => {
  const os = await import('node:os');
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-chats-'));
  // an archive left by an older version (agent replies only) is moved into chats/
  fs.mkdirSync(path.join(dir, '.canvas'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.canvas', 'log-1000.jsonl'), JSON.stringify({ from: 'agent', text: 'old reply', at: 1000 }) + '\n');
  const port = 5391;
  // in its own process: the server watches the app folder for live reload, which would keep this one alive
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'serve', '--scene', path.join(dir, 'scene.json'), '--port', String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/api/chats`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const api = async (method, route, body) => (await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  try {
    assert.ok(!fs.existsSync(path.join(dir, '.canvas', 'log-1000.jsonl')));
    let { chats } = await api('GET', '/api/chats');
    assert.deepEqual(chats.map((c) => [c.id, c.title, c.count]), [['1000', 'old reply', 1]]);

    const { prompt } = await api('POST', '/api/prompt', { text: 'a red   box\non a table' });
    await api('POST', '/api/prompt/status', { id: prompt.id, status: 'taken' });
    await api('POST', '/api/say', { text: 'Added it', reply: prompt.id });
    const { prompt: queued } = await api('POST', '/api/prompt', { text: 'still waiting' });
    const r = await api('POST', '/api/chat/new');
    assert.equal(r.kept, 1); // the queued prompt stays in the new chat
    ({ chats } = await api('GET', '/api/chats'));
    assert.equal(chats[0].id, r.archived);
    assert.equal(chats[0].title, 'a red box on a table');
    assert.equal(chats[0].count, 2);
    const { chat } = await api('GET', `/api/chats/get?id=${r.archived}`);
    assert.deepEqual(chat.prompts.map((p) => p.text), ['a red   box\non a table']);
    assert.deepEqual(chat.messages.map((m) => m.text), ['Added it']);
    assert.deepEqual((await api('GET', '/api/prompts')).prompts.map((p) => p.id), [queued.id]);
    assert.equal((await api('GET', '/api/chats/get?id=../scene')).ok, false);
    // an empty chat is not archived
    await api('POST', '/api/prompt/status', { id: queued.id, status: 'done' });
    await api('POST', '/api/chat/new');
    assert.equal((await api('POST', '/api/chat/new')).archived, null);
  } finally { srv.kill(); }
});

test('shots: one set, several camera timelines; add copies, use swaps, ops can aim at a shot', () => {
  let { doc, results } = applyOps(createDoc(), [{ op: 'add', type: 'box', name: 'house' }, { op: 'shot.add', name: 'Close up' }]);
  assert.equal(results[1].id, 'close-up');
  assert.equal(doc.shot, 'close-up');
  assert.deepEqual(doc.shots.map((s) => s.id), ['shot-1', 'close-up']);
  assert.ok(!doc.shots[1].timeline && doc.shots[0].timeline, 'the active shot keeps its timeline in doc.timeline');
  ({ doc } = applyOps(doc, [{ op: 'key.clear' }, { op: 'key.add', t: 0, position: [1, 1, 1], target: [0, 1, 0] }, { op: 'timeline', duration: 2 }]));
  assert.equal(shotTimeline(doc, 'shot-1').keys.length, 2, 'the copy is independent');
  ({ doc } = applyOps(doc, { op: 'shot.use', id: '1' }));
  assert.equal(doc.timeline.duration, 5);
  assert.equal(shotTimeline(doc, 'close-up').duration, 2);
  // aim an op at another shot without switching
  ({ doc } = applyOps(doc, { op: 'timeline', fps: 30, shot: 'close-up' }));
  assert.equal(doc.shot, 'shot-1');
  assert.equal(doc.timeline.fps, 24);
  assert.equal(shotTimeline(doc, 'close-up').fps, 30);
  assert.equal(doc.objects.length, 1, 'objects are shared');
  // blank, stay, rename, reorder, remove
  ({ doc } = applyOps(doc, [{ op: 'shot.add', name: 'Reverse', blank: true, switch: false }, { op: 'shot.update', id: 'reverse', name: 'Reverse angle' }]));
  assert.equal(doc.shot, 'shot-1');
  assert.deepEqual(shotList(doc).map((s) => s.name), ['Shot 1', 'Reverse angle', 'Close up']);
  ({ doc } = applyOps(doc, { op: 'shot.move', id: 'reverse', to: 3 }));
  assert.deepEqual(doc.shots.map((s) => s.id), ['shot-1', 'close-up', 'reverse']);
  ({ doc } = applyOps(doc, { op: 'shot.remove', id: 'shot-1' }));
  assert.equal(doc.shot, 'close-up');
  assert.equal(doc.timeline.duration, 2);
  ({ doc } = applyOps(doc, { op: 'shot.remove', id: 'reverse' }));
  assert.throws(() => applyOps(doc, { op: 'shot.remove' }), /at least one shot/);
  assert.throws(() => applyOps(doc, { op: 'shot.use', id: 'nope' }), /no shot "nope"/);
});

test('shots: split cuts the active shot in two at a time, same framing either side', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'key.clear' },
    { op: 'key.add', t: 0, position: [0, 1, 10], target: [0, 1, 0], ease: 'linear' },
    { op: 'key.add', t: 4, position: [8, 1, 10], target: [0, 1, 0] },
    { op: 'timeline', duration: 5, interp: 'linear' }]);
  let results;
  ({ doc, results } = applyOps(doc, { op: 'shot.split', t: 2 }));
  assert.equal(results[0].id, 'shot-2');
  assert.equal(doc.shot, 'shot-2');
  const a = shotTimeline(doc, 'shot-1'), b = doc.timeline;
  assert.equal(a.duration, 2); assert.equal(b.duration, 3); assert.equal(b.start, 2);
  assert.deepEqual(a.keys.map((k) => k.t), [0, 2]);
  assert.deepEqual(b.keys.map((k) => k.t), [0, 2]);
  assert.deepEqual(a.keys[1].position, [4, 1, 10]);
  assert.deepEqual(b.keys[0].position, [4, 1, 10], 'the new shot starts on the framing the first ends on');
  assert.equal(b.keys[0].ease, 'linear', 'the move carries on');
  assert.throws(() => applyOps(doc, { op: 'shot.split', t: 0 }), /cut inside the shot/);
  // on an existing key: it ends this shot and starts the next
  ({ doc } = applyOps(doc, { op: 'shot.split', t: 2, switch: false, name: 'tail' }));
  assert.equal(doc.shot, 'shot-2');
  assert.deepEqual(doc.shots.map((s) => s.id), ['shot-1', 'shot-2', 'tail']);
  assert.equal(doc.timeline.keys.length, 2);
  assert.equal(shotTimeline(doc, 'tail').keys.length, 1);
  assert.equal(shotTimeline(doc, 'tail').start, 4);
});

test('shots: old single-timeline scenes migrate to one shot and shots round-trip', () => {
  const old = createDoc(); delete old.shots; delete old.shot; old.timeline.duration = 7;
  const m = migrate(old);
  assert.deepEqual(m.shots, [{ id: 'shot-1', name: 'Shot 1' }]);
  assert.equal(m.shot, 'shot-1');
  assert.equal(m.timeline.duration, 7);
  const { doc } = applyOps(m, [{ op: 'shot.add', name: 'B' }, { op: 'timeline', duration: 3 }, { op: 'shot.use', id: 'shot-1' }]);
  const back = migrate(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(back, doc);
  assert.equal(shotTimeline(back, 'b').duration, 3);
});

test('shots: shot.add frame starts on one key, the source framing at that moment; duration sets its length', () => {
  let doc = createDoc();
  const src = doc.timeline, last = [...src.keys].sort((a, b) => a.t - b.t).pop();
  let results;
  ({ doc, results } = applyOps(doc, { op: 'shot.add', frame: true }));
  assert.equal(results[0].start, src.duration, 'the next shot, from where the first ends');
  assert.equal(doc.timeline.keys.length, 1);
  assert.equal(doc.timeline.keys[0].t, 0);
  assert.deepEqual(doc.timeline.keys[0].position, last.position, 'on the first shot\'s last frame');
  assert.equal(doc.timeline.duration, src.duration);
  ({ doc, results } = applyOps(doc, [{ op: 'shot.use', id: 'shot-1' }, { op: 'shot.add', frame: true, start: 2, duration: 1.5 }]));
  const p = sampleCamera(shotTimeline(doc, 'shot-1'), 2);
  assert.equal(results[1].start, 2);
  assert.equal(doc.timeline.duration, 1.5);
  assert.equal(doc.timeline.start, 2);
  doc.timeline.keys[0].position.forEach((v, i) => assert.ok(Math.abs(v - p.position[i]) < 1e-3, 'framing of shot 1 at 2 s'));
  assert.deepEqual(doc.shots.map((s) => s.id), ['shot-1', 'shot-3', 'shot-2'], 'inserted after the active shot');
  assert.throws(() => applyOps(doc, { op: 'shot.add', duration: 0 }), /duration must be/);
});

test('shots: timeline.start picks up the shared action later; object key ops use shot time', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'add', type: 'box', name: 'car' }, { op: 'anim.move', id: 'car', to: [10, 0, 0], at: 0, over: 4, ease: 'linear' }]);
  ({ doc } = applyOps(doc, { op: 'shot.add', name: 'next' }));
  assert.equal(doc.timeline.start, 5, 'a new shot picks up the action where the current one ends');
  ({ doc } = applyOps(doc, [{ op: 'shot.remove' }, { op: 'shot.add', name: 'later', start: 0 }, { op: 'timeline', start: 2 }]));
  const car = doc.objects[0];
  assert.equal(sampleObject(car, doc.timeline, 0).position[0], 5, 'shot time 0 is action time 2');
  assert.equal(sampleObject(car, shotTimeline(doc, 'shot-1'), 0).position[0], 0);
  ({ doc } = applyOps(doc, { op: 'anim.key', id: 'car', t: 1, position: [6, 1, 0] }));
  assert.ok(doc.objects[0].anim.some((k) => k.t === 3 && k.position[1] === 1), 'stored at action time 3');
  ({ doc } = applyOps(doc, { op: 'anim.remove', id: 'car', t: 1 }));
  assert.equal(doc.objects[0].anim.length, 2);
  // stretching one shot leaves the shared action alone when there are several shots
  ({ doc } = applyOps(doc, { op: 'timeline', duration: 10, retime: true }));
  assert.deepEqual(doc.objects[0].anim.map((k) => k.t), [0, 4]);
  ({ doc } = applyOps(doc, { op: 'timeline', start: 0 }));
  assert.equal(doc.timeline.start, undefined);
});

test('camera moves: cam.move writes two keys with a path; paths arc, turn and hold the subject size', () => {
  const start = (doc) => { doc.timeline.keys = [{ id: 'k1', t: 0, position: [0, 2, 10], target: [0, 1, 0], fov: 40, roll: 0, ease: 'easeInOut' }]; return doc; };
  // orbit: radius and height stay, the subject stays centred, + goes to the camera's right (+x from +z)
  let { doc, results } = applyOps(start(createDoc()), { op: 'cam.move', move: 'orbit', t: 1, over: 2, angle: 90, ease: 'linear' });
  assert.deepEqual(results[0].keys.length, 2);
  assert.equal(doc.timeline.keys.length, 3);
  const a = doc.timeline.keys.find((k) => k.t === 1);
  assert.equal(a.path.type, 'orbit');
  assert.equal(a.ease, 'linear');
  const mid = sampleCamera(doc.timeline, 2);
  assert.ok(Math.abs(Math.hypot(mid.position[0], mid.position[2]) - 10) < 1e-6, 'an orbit keeps its radius');
  assert.ok(mid.position[0] > 6 && mid.position[2] > 6, 'halfway round: 45° to the right');
  assert.deepEqual(sampleCamera(doc.timeline, 3).position.map(Math.round), [10, 2, 0]);
  // the angle hint takes the long way round
  ({ doc } = applyOps(start(createDoc()), { op: 'cam.move', move: 'orbit', t: 0, over: 2, angle: 270, ease: 'linear' }));
  const q = sampleCamera(doc.timeline, 1);
  assert.ok(q.position[2] < -6, '270°: halfway is behind the subject');
  // around an object: the pivot is the object
  ({ doc } = applyOps(start(createDoc()), [{ op: 'add', type: 'box', name: 'car', position: [5, 0, 0] }, { op: 'cam.move', move: 'orbit', around: 'car', t: 0, over: 1, angle: 180 }]));
  assert.equal(doc.timeline.keys[0].path.around, 'car');
  assert.deepEqual(doc.timeline.keys[0].path.center, [5, 0.5, 0]);
  // pan: the camera stays, the aim turns right
  ({ doc } = applyOps(start(createDoc()), { op: 'cam.move', move: 'pan', t: 0, over: 1, angle: 90 }));
  const pan = sampleCamera(doc.timeline, 1);
  assert.deepEqual(pan.position, [0, 2, 10]);
  assert.ok(pan.target[0] > 9, 'looking along +x after panning right from looking down -z');
  // dolly zoom: the frame keeps its width at the subject
  ({ doc } = applyOps(start(createDoc()), { op: 'cam.move', move: 'dolly-zoom', t: 0, over: 2, by: 5 }));
  const w = (s) => Math.tan((s.fov * Math.PI) / 360) * Math.hypot(...s.position.map((v, i) => v - s.target[i]));
  const w0 = w(sampleCamera(doc.timeline, 0));
  for (const t of [0.5, 1, 1.5, 2]) assert.ok(Math.abs(w(sampleCamera(doc.timeline, t)) - w0) < 1e-2, `dolly zoom width at ${t}s`);
  assert.ok(doc.timeline.keys[1].fov > 60, 'the lens widened');
  // push replaces keys inside the move; pull-out goes back; zoom, crane, truck, roll
  ({ doc } = applyOps(start(createDoc()), [{ op: 'key.add', t: 1, position: [3, 3, 3], target: [0, 0, 0] }, { op: 'cam.move', move: 'push', t: 0, over: 2, by: 4 }]));
  assert.deepEqual(doc.timeline.keys.map((k) => k.t), [0, 2]);
  assert.ok(Math.abs(doc.timeline.keys[1].position[2] - (10 - 4 * Math.cos(Math.atan(1 / 10)))) < 0.01);
  ({ doc } = applyOps(start(createDoc()), { op: 'cam.move', move: 'pull-out', t: 0, by: 2 }));
  assert.ok(doc.timeline.keys[1].position[2] > 10);
  ({ doc } = applyOps(start(createDoc()), { op: 'cam.move', move: 'zoom', t: 0, lens: 85 }));
  assert.equal(Math.round(fovToLens(doc.timeline.keys[1].fov)), 85);
  ({ doc } = applyOps(start(createDoc()), { op: 'cam.move', move: 'crane', t: 0, by: 2 }));
  assert.deepEqual([doc.timeline.keys[1].position[1], doc.timeline.keys[1].target[1]], [4, 1]);
  ({ doc } = applyOps(start(createDoc()), { op: 'cam.move', move: 'truck', t: 0, by: 1 }));
  assert.deepEqual(doc.timeline.keys[1].position, [1, 2, 10]);
  ({ doc } = applyOps(start(createDoc()), { op: 'cam.move', move: 'dutch', t: 0, angle: 12 }));
  assert.equal(doc.timeline.keys[1].roll, 12);
  // no keys: needs from
  assert.throws(() => applyOps({ ...createDoc(), timeline: { ...createDoc().timeline, keys: [] } }, { op: 'cam.move', move: 'pan' }), /no camera keys/);
  ({ doc } = applyOps({ ...createDoc(), timeline: { ...createDoc().timeline, keys: [] } }, { op: 'cam.move', move: 'pan', from: { position: [0, 2, 5], target: [0, 1, 0] } }));
  assert.equal(doc.timeline.keys.length, 2);
  assert.throws(() => applyOps(createDoc(), { op: 'cam.move', move: 'spin' }), /unknown move/);
});

test('key paths: set, clear with smooth, survive a reload, and stay off cuts', () => {
  let { doc } = applyOps(createDoc(), { op: 'key.update', id: 'k1', path: 'orbit' });
  assert.deepEqual(doc.timeline.keys[0].path, { type: 'orbit' });
  // an orbit without a center turns round the key's aim point
  const s = sampleCamera(doc.timeline, 2.5);
  const r0 = Math.hypot(7, 9), r1 = Math.hypot(-6, 8);
  assert.ok(Math.abs(Math.hypot(s.position[0], s.position[2]) - (r0 + r1) / 2) < 0.2);
  doc = migrate(JSON.parse(JSON.stringify(doc)));
  assert.equal(doc.timeline.keys[0].path.type, 'orbit');
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', path: 'smooth' }));
  assert.equal(doc.timeline.keys[0].path, undefined);
  assert.throws(() => applyOps(doc, { op: 'key.update', id: 'k1', path: 'zigzag' }), /unknown path/);
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', path: { type: 'dolly-zoom' } }));
  assert.equal(doc.timeline.keys[0].path.type, 'dollyZoom');
  // a hold key cuts: its path is ignored
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', ease: 'hold' }));
  assert.deepEqual(sampleCamera(doc.timeline, 2.5).position, [7, 3.5, 9]);
});

test('sweep: shortest way round unless the hint says otherwise', () => {
  const d = (x) => +(x * 180 / Math.PI).toFixed(6);
  assert.equal(d(sweep(0, Math.PI / 2)), 90);
  assert.equal(d(sweep(0, Math.PI / 2, -270)), -270);
  assert.equal(d(sweep(0, 0, 360)), 360);
  assert.equal(d(sweep(0, -Math.PI / 2, 270)), 270);
});

test('camera moves remember their settings and can be edited in place', () => {
  let { doc, results } = applyOps(createDoc(), { op: 'cam.move', move: 'orbit', t: 1, over: 2, angle: 90, ease: 'linear' });
  const [a, b] = results[0].keys;
  const k = () => doc.timeline.keys.find((x) => x.id === a);
  assert.deepEqual([k().path.move, k().path.params], ['orbit', { angle: 90 }]);
  const startPos = [...k().position];
  // change the angle and length: same start framing, the old end key is replaced (and keeps its id)
  ({ doc, results } = applyOps(doc, { op: 'cam.move', edit: a, angle: 180, over: 3 }));
  assert.deepEqual(results[0].keys, [a, b]);
  assert.equal(results[0].edited, true);
  assert.deepEqual(k().position, startPos);
  assert.equal(k().ease, 'linear', 'settings left out keep their values');
  assert.equal(k().path.params.angle, 180);
  assert.deepEqual(doc.timeline.keys.map((x) => x.t), [0, 1, 4, 5]);
  // a shorter move leaves later keys alone
  ({ doc } = applyOps(doc, { op: 'cam.move', edit: a, over: 1 }));
  assert.deepEqual(doc.timeline.keys.map((x) => x.t), [0, 1, 2, 5]);
  // switch it to another move
  ({ doc } = applyOps(doc, { op: 'cam.move', edit: a, move: 'push', by: 1 }));
  assert.deepEqual([k().path.type, k().path.move], ['straight', 'push']);
  // a path picked by hand is no longer a preset move
  ({ doc } = applyOps(doc, { op: 'key.update', id: a, path: 'orbit' }));
  assert.equal(k().path.move, undefined);
  assert.throws(() => applyOps(doc, { op: 'cam.move', edit: 'k1' }), /no move to edit/);
});

test('shudder: exact jerks along the segment, keys still land, set / change / clear', () => {
  let { doc } = applyOps(createDoc(), { op: 'key.update', id: 'k1', ease: 'linear', shudder: { jerks: 4, amount: 10 } });
  const k1 = () => doc.timeline.keys[0];
  assert.deepEqual(k1().shudder, { jerks: 4, amount: 10, shape: 'jerk', over: 'even' });
  const tl = doc.timeline, [a, b] = tl.keys, T = b.t - a.t;
  // jerk: each beat snaps back by the full amount at 12% of the beat, then recovers by the next beat
  assert.ok(Math.abs(shudderOffset(k1().shudder, 0.03) - 0.1) < 1e-9);
  for (const u of [0, 0.25, 0.5, 0.75, 1]) assert.ok(shudderOffset(k1().shudder, u) < 1e-9, `on the beat at ${u}`);
  // the camera is back where a plain linear move would be on each beat, and behind it just after
  assert.ok(Math.abs(sampleCamera(tl, a.t + T * 0.5).local - 0.5) < 1e-9);
  assert.ok(Math.abs(sampleCamera(tl, a.t + T * 0.28).local - (0.28 - 0.1)) < 1e-9);
  assert.deepEqual(sampleCamera(tl, b.t).position, b.position);
  // the shudder never pulls the camera back past the start key
  assert.ok(sampleCamera(tl, a.t + T * 0.01).local >= 0);
  // partial settings change only what is given; fade dies out towards the end
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', shudder: { shape: 'wobble', over: 'fade' } }));
  assert.deepEqual(k1().shudder, { jerks: 4, amount: 10, shape: 'wobble', over: 'fade' });
  assert.ok(shudderOffset(k1().shudder, 0.125) > shudderOffset(k1().shudder, 0.875));
  assert.throws(() => applyOps(doc, { op: 'key.update', id: 'k1', shudder: { shape: 'zigzag' } }), /shape/);
  assert.throws(() => applyOps(doc, { op: 'key.update', id: 'k1', shudder: { jerks: 0 } }), /jerks/);
  doc = migrate(JSON.parse(JSON.stringify(doc)));
  assert.equal(k1().shudder.shape, 'wobble');
  // other key edits keep it; off removes it
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', ease: 'snap' }));
  assert.equal(k1().shudder.jerks, 4);
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', shudder: 'off' }));
  assert.equal(k1().shudder, undefined);
  // a cut has no shudder to play
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', ease: 'hold', shudder: {} }));
  assert.equal(sampleCamera(doc.timeline, a.t + T * 0.28).local, 0);
});

test('shudder from / to: only plays in that section of the segment', () => {
  let { doc } = applyOps(createDoc(), { op: 'key.update', id: 'k1', ease: 'linear', shudder: { jerks: 2, amount: 10, from: 0.5, to: 0.9 } });
  const sh = doc.timeline.keys[0].shudder;
  assert.deepEqual(sh, { jerks: 2, amount: 10, shape: 'jerk', over: 'even', from: 0.5, to: 0.9 });
  for (const u of [0.1, 0.3, 0.5, 0.7, 0.9, 0.95]) assert.ok(shudderOffset(sh, u) < 1e-9, `quiet at ${u}`);
  // first jerk peaks 12% into its beat: the beat is 0.2 of the segment, so at 0.524
  assert.ok(Math.abs(shudderOffset(sh, 0.524) - 0.1) < 1e-9);
  assert.throws(() => applyOps(doc, { op: 'key.update', id: 'k1', shudder: { from: 0.95 } }), /from/);
  // back to the whole segment
  ({ doc } = applyOps(doc, { op: 'key.update', id: 'k1', shudder: { from: 0, to: 1 } }));
  assert.equal(doc.timeline.keys[0].shudder.from, undefined);
});

test('brief: a shot\'s camera work in words, with times, framings, moving objects and its audio', () => {
  let { doc } = applyOps(createDoc(), [
    { op: 'meta', width: 720, height: 1280 },
    { op: 'add', type: 'person', name: 'hero' },
    { op: 'key.clear' },
    { op: 'key.add', t: 0, position: [0, 1.6, 8], target: [0, 1.3, 0], fov: lensToFov(24) },
    { op: 'cam.move', move: 'push', t: 0, over: 1.2, by: 3, ease: 'easeIn' },
    { op: 'cam.move', move: 'orbit', t: 1.5, over: 0.25, angle: 90, around: 'hero' },
    { op: 'key.add', t: 3, position: [0.5, 0.3, 2], target: [0, 1.4, 0], fov: lensToFov(35), ease: 'hold' },
    { op: 'key.add', t: 4, position: [0, 6, 0.1], target: [0, 0, 0], fov: lensToFov(35) },
    { op: 'anim.move', id: 'hero', to: [0, 0, -2], at: 1, over: 2 },
    { op: 'audio', file: 'song-12345678.mp3', name: 'song.mp3', offset: -3 },
  ]);
  const b = shotBrief(doc);
  assert.equal(b.shot.ratio.nearest, '9:16');
  assert.equal(b.shot.frames, 120);
  assert.match(b.start.text, /^wide of hero · front · eye level \(1\.6 m\) · 8 m away · 24mm$/);
  const [push, hold, orbit, , cut, end] = b.segments;
  assert.deepEqual([push.from, push.to, push.kind, push.ease, push.move.preset], [0, 1.2, 'move', 'easeIn', 'push']);
  assert.match(push.text, /^push in 3 m/);
  assert.equal(push.end.size, 'full shot');
  assert.deepEqual([hold.from, hold.to, hold.kind], [1.2, 1.5, 'hold']);
  assert.equal(orbit.move.orbit, 90);
  assert.equal(orbit.pace, 'snap');
  assert.match(orbit.text, /^orbit 90° to the right around hero/);
  assert.match(orbit.end.side, /^side, their left$/);
  assert.equal(cut.kind, 'cut');
  assert.equal(cut.end.height, 'top-down');
  assert.deepEqual([end.from, end.to, end.kind], [4, 5, 'hold']);
  assert.deepEqual(b.objects.map((o) => [o.id, o.from, o.to, o.moved]), [['hero', 1, 3, 2]]);
  // the audio starts 3 s before the action, so the shot plays 3–8 s of the file
  assert.deepEqual([b.audio.from, b.audio.to, b.audio.fileFrom, b.audio.fileTo], [0, 5, 3, 8]);
  const text = briefText(b, { tempo: 120, beat: 0.5, beats: [0.5, 1], onsets: [0.5] });
  assert.match(text, /^shot 1\/1 shot-1 "Shot 1": 5s @ 24fps \(120 frames\), 720x1280 \(9:16\)/);
  assert.match(text, /1\.50–1\.75s {2}orbit 90° to the right around hero \[snap, ease easeInOut\]/);
  assert.match(text, /tempo: 120 bpm/);

  // a second shot picks up later in the action and sits after the first in the sequence
  ({ doc } = applyOps(doc, [{ op: 'shot.add', name: 'two', start: 2, duration: 2 }]));
  const two = shotBrief(doc, 'two');
  assert.deepEqual(two.shot.sequence, [5, 7]);
  // the whole timeline as one video: both shots, a cut between them, every time in seconds of the export
  const tl = timelineBrief(doc);
  assert.deepEqual([tl.timeline.shots, tl.timeline.duration, tl.timeline.cuts, tl.shots.map((x) => x.at)], [2, 7, [5], [0, 5]]);
  const tt = timelineText(tl);
  assert.match(tt, /^timeline: 2 shots, 7\.00s @ 24fps, 720x1280 \(9:16\), hard cut at 5\.00s\n/);
  assert.match(tt, /\nshot 1\/2 shot-1 "Shot 1": 0\.00–5\.00s \(5s\)\n/);
  assert.match(tt, /1\.50–1\.75s {2}orbit 90°/);                          // the first shot keeps its own times
  assert.match(tt, /\nCUT at 5\.00s to shot 2\/2 two: 5\.00–7\.00s \(2s\)\n/);
  assert.ok(!/\n[0-4]\.\d\d–/.test(tt.slice(tt.indexOf('CUT at'))), 'the second shot\'s times start at the cut');
  assert.match(tt.slice(tt.indexOf('CUT at')), /plays 5\.00–7\.00s of the video = 5\.00–7\.00s of the file/);
  assert.deepEqual([two.audio.fileFrom, two.audio.fileTo], [5, 7]);
  assert.deepEqual(two.objects.map((o) => [o.from, o.to, o.moved]), [[0, 1, 1]]);
  assert.equal(shotBrief(doc, 'shot-1').shot.active, false);

  // the speed curve moves the times: with ease-in, the half-way key is reached after the half-way point
  ({ doc } = applyOps(createDoc(), [{ op: 'key.clear' }, { op: 'key.add', t: 0, position: [0, 1, 5], target: [0, 1, 0] }, { op: 'key.add', t: 2, position: [2, 1, 5], target: [2, 1, 0] }, { op: 'key.add', t: 4, position: [2, 1, 5], target: [2, 1, 0] }, { op: 'timeline', duration: 4, speed: 'easeIn' }]));
  const sp = shotBrief(doc).segments;
  assert.ok(sp[0].to > 2.2 && sp[0].to < 4, `truck ends at ${sp[0].to}`);
  assert.match(sp[0].text, /^truck right 2 m$/);
  assert.equal(describeMove({ position: [0, 1, 5], target: [0, 1, 0], fov: 40 }, { position: [0, 1, 5], target: [0, 1, 0], fov: 40 }, 1).text, 'hold');
  assert.deepEqual(ratioOf(1366, 768), { exact: '683:384', nearest: '16:9' });
});

test('render recipes: slots are found by node type, a fill never touches the recipe, and mismatches are flagged', () => {
  const file = path.join(BUILTIN, 'seedance-2.5-reference.json');
  const recipe = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = JSON.stringify(recipe);
  const s = findSlots(recipe);
  assert.equal(s.model.class, 'ByteDance2ReferenceNodeV2');
  assert.deepEqual([s.video.node, s.video.input, s.video.ref, s.video.direct], ['rv_load', 'file', 'model.reference_videos.video_1', false]);
  assert.deepEqual(s.images.map((i) => [i.n, i.node, i.ref]), [[1, '5', 'model.reference_images.image_1'], [2, '4', 'model.reference_images.image_2']]);
  assert.deepEqual([s.audio.node, s.trim.node, s.save.node, s.prompt.input], ['9', 'rv_cut', 'save', 'model.prompt']);
  assert.deepEqual(Object.keys(s.settings), ['duration', 'ratio', 'resolution', 'seed', 'generateAudio']);

  const r = fillRecipe(recipe, { video: 'shot.mp4', images: ['a.png', 'b.png', 'c.png'], audio: 'none', prompt: 'Follow @video_1. @image_1 her, @image_2 the room, @image_4 x. @audio_1 plays.', duration: 6, ratio: '16:9', seed: 'new', prefix: 'blockout/s/shot-1', set: { 'seedance.watermark': true } });
  assert.equal(JSON.stringify(recipe), before, 'the recipe is not changed');
  const w = r.workflow, m = w.seedance.inputs;
  assert.equal(w.rv_load.inputs.file, 'shot.mp4');
  assert.deepEqual([w['5'].inputs.image, w['4'].inputs.image, w.image_3.inputs.image], ['a.png', 'b.png', 'c.png']);
  assert.deepEqual(m['model.reference_images.image_3'], ['image_3', 0]);
  assert.ok(!w['9'] && !('model.reference_audios.audio_1' in m), 'audio: none removes the loader and its input');
  assert.deepEqual([m['model.duration'], w.rv_cut.inputs.duration, m['model.ratio'], m.watermark, w.save.inputs.filename_prefix], [6, 6, '16:9', true, 'blockout/s/shot-1']);
  assert.notEqual(m.seed, recipe.seedance.inputs.seed);
  assert.deepEqual(r.warnings, ['the prompt mentions @image_4 but there are 3 images', 'image 3 is loaded but the prompt never mentions @image_3', 'the prompt mentions @audio_1 but there is no audio']);

  // fewer images than slots: the spare one goes; untouched placeholders are called out
  const one = fillRecipe(recipe, { images: ['only.png'] });
  assert.ok(!one.workflow['4'] && !('model.reference_images.image_2' in one.workflow.seedance.inputs));
  assert.ok(one.warnings.some((x) => /placeholder "REPLACE-blockout.mp4"/.test(x)) && one.warnings.some((x) => /\[PLACEHOLDER\]/.test(x)));

  // title tags win over the guess; the editor format is refused with a way out
  const tagged = structuredClone(recipe);
  tagged.extra = { class_type: 'LoadVideo', inputs: { file: 'other.mp4' }, _meta: { title: 'the real one @video' } };
  assert.equal(findSlots(tagged).video.node, 'extra');
  assert.throws(() => findSlots({ nodes: [], links: [] }), /Export \(API\)/);
  assert.throws(() => fillRecipe({ a: { class_type: 'SaveVideo', inputs: { filename_prefix: 'x' } } }, { video: 'v.mp4' }), /no video slot/);
  assert.deepEqual(listRecipes(BUILTIN).map((x) => [x.name, x.images, !!x.notes]), [['seedance-2.5-reference', 2, true]]);
  // the recipe ships the full prompt it was made from, as the example every new prompt is adapted from
  const example = fs.readFileSync(listRecipes(BUILTIN)[0].example, 'utf8');
  assert.ok(example.length > 4500 && /^References: /.test(example) && /\n9\.63–10\.5s: /.test(example) && !/\[[A-Z][A-Z _-]+\]/.test(example));
});

test('say --attach: a reply carries a video, served with byte ranges so it can be played and seeked', async () => {
  const os = await import('node:os');
  const { spawn, execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-attach-'));
  const port = 5392;
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'serve', '--scene', path.join(dir, 'scene.json'), '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env: { ...process.env, CANVAS_PORT: String(port) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const video = path.join(dir, 'my render.mp4');
    fs.writeFileSync(video, Buffer.from('0123456789'));
    assert.match(cli('say', '--attach', video, 'Render done'), /sent with 1 attachment/);
    assert.match(cli('say', '--attach', video), /sent with 1 attachment/); // text is optional with a file
    const log = fs.readFileSync(path.join(dir, '.canvas', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const f = log[0].files[0];
    assert.deepEqual([log[0].text, f.type, f.name, log[1].text], ['Render done', 'video', 'my render.mp4', '']);
    assert.ok(fs.existsSync(f.path) && f.url.startsWith('/uploads/'));
    const whole = await fetch(base + f.url);
    assert.deepEqual([whole.status, whole.headers.get('content-type'), whole.headers.get('accept-ranges'), await whole.text()], [200, 'video/mp4', 'bytes', '0123456789']);
    const part = await fetch(base + f.url, { headers: { range: 'bytes=2-5' } });
    assert.deepEqual([part.status, part.headers.get('content-range'), await part.text()], [206, 'bytes 2-5/10', '2345']);
    const tail = await fetch(base + f.url, { headers: { range: 'bytes=-3' } });
    assert.equal(await tail.text(), '789');
    assert.equal((await fetch(base + f.url, { headers: { range: 'bytes=50-' } })).status, 416);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    assert.throws(() => cli('say', '--attach', path.join(dir, 'notes.txt'), 'hi'), /cannot attach/);
    assert.throws(() => cli('say'), /usage/);
    assert.match(cli('brief'), /^shot 1\/1 shot-1/);
    assert.equal(JSON.parse(cli('brief', '--all', '--json')).length, 1);
    assert.match(cli('brief', '--timeline'), /^timeline: 1 shot, .*one continuous shot\nevery time below is in seconds of the exported video/);
    assert.equal(JSON.parse(cli('brief', '--timeline', '--json')).timeline.shots, 1);
  } finally { srv.kill(); }
});

test('canvas ask: a question card goes to the chat, the answers come back as one prompt, a key never does', async () => {
  const os = await import('node:os');
  const { spawn, execFileSync } = await import('node:child_process');
  const { normalizeAsk, asked } = await import('../core/ask.js');
  assert.throws(() => normalizeAsk({ questions: [] }), /needs/);
  assert.throws(() => normalizeAsk([{ id: 'a', q: 'A?', options: ['one'] }]), /two options/);
  assert.throws(() => normalizeAsk([{ id: 'k', q: 'Key?', type: 'secret', name: 'my key' }]), /COMFY_API_KEY/);
  assert.throws(() => normalizeAsk([{ id: 'a', q: 'A?', when: { later: 'x' } }]), /earlier question/);
  const n = normalizeAsk([{ id: 'look', q: 'Look?', options: ['Images', { value: 'words', label: 'Describe it' }] }, { id: 'refs', q: 'Which?', type: 'images', when: { look: 'Images' } }]);
  assert.deepEqual([n.questions[0].type, n.questions[0].options[1].value, n.questions[1].max], ['choice', 'words', 4]);
  assert.deepEqual([asked(n.questions[1], { look: { value: 'Images' } }), asked(n.questions[1], { look: { value: 'words' } }), asked(n.questions[1], {})], [true, false, false]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-ask-'));
  const port = 5393;
  const env = { ...process.env, CANVAS_PORT: String(port), CANVAS_SECRETS: path.join(dir, 'home', 'secrets.json') };
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'serve', '--scene', path.join(dir, 'scene.json'), '--port', String(port)], { stdio: 'ignore', env });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const post = async (route, body) => (await fetch(base + route, { method: 'POST', body: JSON.stringify(body) })).json();
  const KEY = 'sk-test-0123456789-do-not-leak';
  try {
    const card = path.join(dir, 'card.json');
    fs.writeFileSync(card, JSON.stringify({ title: 'Render with Comfy', questions: [
      { id: 'model', q: 'Which model?', options: [{ value: 'pro', label: 'Seedance 2.5', note: 'best' }, { value: 'flash', label: 'Flash' }], other: true },
      { id: 'why', q: 'Why Flash?', when: { model: 'flash' } },
      { id: 'notes', q: 'Anything else?', optional: true },
      { id: 'key', q: 'Comfy API key', type: 'secret', name: 'COMFY_API_KEY' },
    ] }));
    assert.match(cli('ask', card), /asked 4 questions \(q\w+\)/);
    assert.throws(() => cli('ask', '{"questions":[{"q":"A?","options":["only"]}]}'), /two options/);
    const log = () => fs.readFileSync(path.join(dir, '.canvas', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ask = log()[0];
    assert.deepEqual([ask.kind, ask.ask.title, ask.ask.questions.length, ask.ask.questions[0].other], ['ask', 'Render with Comfy', 4, 'Something else']);

    // the tab saves the key itself; the answers only say that it is saved
    assert.equal((await post('/api/secret', { name: 'bad name', value: 'x' })).ok, false);
    assert.equal((await post('/api/secret', { name: 'COMFY_API_KEY', value: KEY })).ok, true);
    const saved = await (await fetch(`${base}/api/secrets`)).json();
    assert.deepEqual(saved.secrets.map((x) => x.name), ['COMFY_API_KEY']);
    assert.ok(!JSON.stringify(saved).includes(KEY));
    if (process.platform !== 'win32') assert.equal(fs.statSync(env.CANVAS_SECRETS).mode & 0o777, 0o600);

    const r = await post('/api/ask/answer', { id: ask.ask.id, answers: { model: { value: 'pro' }, why: { text: 'not asked' }, notes: { skipped: true }, key: { saved: true, value: KEY } } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.prompt.answers, { model: { value: 'pro' }, notes: { skipped: true }, key: { saved: true, name: 'COMFY_API_KEY' } });
    assert.equal((await post('/api/ask/answer', { id: ask.ask.id, answers: {} })).error, 'already answered');
    assert.equal((await post('/api/ask/answer', { id: 'nope', answers: {} })).ok, false);
    const got = cli('wait', '--timeout', '2', '--no-listen');
    assert.match(got, /Answers to "Render with Comfy":\n- model \(Which model\?\): Seedance 2\.5 \[pro\]\n- notes \(Anything else\?\): skipped\n- key \(Comfy API key\): COMFY_API_KEY is saved on this machine/);
    assert.match(got, /canvas secret run COMFY_API_KEY -- <command>/);
    assert.match(got, /these answer your question card/);
    // nothing the agent reads holds the key
    for (const f of ['log.jsonl', 'inbox.jsonl']) assert.ok(!fs.readFileSync(path.join(dir, '.canvas', f), 'utf8').includes(KEY), `${f} holds the key`);
    assert.ok(!got.includes(KEY));

    // the agent uses it without seeing it
    assert.match(cli('secret', 'list'), /^COMFY_API_KEY  saved \d{4}-/);
    const ran = cli('secret', 'run', 'COMFY_API_KEY', '--', process.execPath, '-e', 'console.log("len", process.env.COMFY_API_KEY.length, "key", process.env.COMFY_API_KEY)');
    assert.equal(ran.trim(), `len ${KEY.length} key [COMFY_API_KEY hidden]`);
    assert.throws(() => cli('secret', 'run', 'OTHER_KEY', '--', 'true'), /no key named OTHER_KEY/);
    assert.throws(() => cli('secret', 'run', 'COMFY_API_KEY', '--', process.execPath, '-e', 'process.exit(3)'), (e) => e.status === 3);

    // a progress card for a long job: one card, updated in place, that ends done or failed
    const job = cli('progress', 'Rendering on Comfy Cloud', '--steps', 'Upload|Queue|Render|Download', '--eta', '240').trim();
    assert.match(job, /^g\w+$/);
    assert.equal(cli('progress', '--id', job, '--step', '3', '--pct', '40', '--note', 'Seedance 2.5').trim(), `${job} running (Render, 3 of 4)`);
    const mid = log().at(-1);
    assert.deepEqual([mid.kind, mid.progress.state, mid.progress.step, mid.progress.pct, mid.progress.note, mid.progress.eta, mid.progress.steps.length], ['progress', 'running', 3, 40, 'Seedance 2.5', 240, 4]);
    cli('progress', '--id', job, '--step', '4');
    assert.equal(log().at(-1).progress.pct, undefined); // a percentage belongs to the stage it was given for
    assert.throws(() => cli('progress', '--id', job, '--step', '9'), /step must be 1 to 4/);
    assert.throws(() => cli('progress', '--id', 'gnope', '--pct', '5'), /no progress card/);
    assert.throws(() => cli('progress'), /usage/);
    assert.equal(cli('progress', '--id', job, '--done', 'Rendered in 3m 40s').trim(), `${job} done (Download, 4 of 4)`);
    const fin = log().at(-1).progress;
    assert.deepEqual([fin.state, fin.note, fin.startedAt === mid.progress.startedAt, fin.endedAt >= fin.startedAt], ['done', 'Rendered in 3m 40s', true, true]);
    // the open chat gets the card once, in its latest state, where it first appeared
    const hist = await new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/events`, (res) => { let buf = ''; res.on('data', (d) => { buf += d; const m = buf.match(/event: history\ndata: (.*)\n/); if (m) { req.destroy(); resolve(JSON.parse(m[1])); } }); });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    });
    const cards = hist.messages.filter((m) => m.kind === 'progress');
    assert.deepEqual([cards.length, cards[0].progress.state, cards[0].at < mid.at], [1, 'done', true]);
    const failed = cli('progress', 'Second job').trim();
    cli('progress', '--id', failed, '--fail', 'Out of credits');
    assert.deepEqual([log().at(-1).progress.state, log().at(-1).progress.note], ['failed', 'Out of credits']);

    // "still working" is a promise to come back: it shows as a card with a clock and counts as a running job
    const jobs = async () => (await (await fetch(`${base}/api/jobs`)).json()).jobs;
    const before = (await jobs()).length;
    cli('say', '--working', 'Running on Comfy Cloud, job 171d');
    const auto = log().at(-1);
    assert.deepEqual([auto.kind, auto.progress.title, auto.progress.note, auto.progress.auto, (await jobs()).length], ['progress', 'Working', 'Running on Comfy Cloud, job 171d', true, before + 1]);
    cli('say', '--working', 'Still in the queue');
    assert.deepEqual([log().at(-1).progress.id, log().at(-1).progress.note, (await jobs()).length], [auto.progress.id, 'Still in the queue', before + 1]);
    cli('say', 'Here is the render.');
    assert.deepEqual([log().at(-2).progress.state, log().at(-1).text, (await jobs()).length], ['done', 'Here is the render.', before]);
    // one quick question, closed without an answer
    assert.match(cli('ask', 'Run it?', '--options', 'Run|Not yet'), /asked 1 question /);
    const quick = log().at(-1).ask;
    assert.deepEqual(quick.questions[0].options.map((o) => o.value), ['Run', 'Not yet']);
    const closed = await post('/api/ask/answer', { id: quick.id, cancelled: true });
    assert.ok(closed.prompt.cancelled && /without answering/.test(closed.prompt.text));
    // a text to review before it is used: approved, edited in place, or sent back with feedback
    const promptFile = path.join(dir, 'prompt.txt');
    fs.writeFileSync(promptFile, 'References: @video_1 is the blockout.\n0–1.96s: Half orbit to the left.\n');
    const review = () => { cli('ask', JSON.stringify({ title: 'Render', questions: [{ id: 'prompt', q: 'Check the prompt', file: promptFile }, { id: 'go', q: 'Ready?', options: ['Render', 'Not yet'], when: { prompt: ['approved', 'edited'] } }] })); return log().at(-1).ask; };
    let rv = review();
    assert.deepEqual([rv.questions[0].type, rv.questions[0].body], ['review', 'References: @video_1 is the blockout.\n0–1.96s: Half orbit to the left.']);
    let ans = await post('/api/ask/answer', { id: rv.id, answers: { prompt: { text: rv.questions[0].body + '\n' }, go: { value: 'Render' } } });
    assert.deepEqual(ans.prompt.answers, { prompt: { value: 'approved' }, go: { value: 'Render' } });
    assert.match(ans.prompt.text, /- prompt \(Check the prompt\): approved as shown\n- go \(Ready\?\): Render/);
    rv = review();
    ans = await post('/api/ask/answer', { id: rv.id, answers: { prompt: { text: 'A new prompt.\nLine two.' }, go: { value: 'Render' } } });
    assert.deepEqual(ans.prompt.answers.prompt, { value: 'edited', text: 'A new prompt.\nLine two.' });
    assert.match(ans.prompt.text, /approved with their edits\. Use exactly this text:\n  \| A new prompt\.\n  \| Line two\.\n- go/);
    rv = review();
    ans = await post('/api/ask/answer', { id: rv.id, answers: { prompt: { text: rv.questions[0].body, feedback: 'make it night' }, go: { value: 'Render' } } });
    assert.deepEqual(ans.prompt.answers, { prompt: { value: 'feedback', feedback: 'make it night' } }); // feedback is not approval: the Render step is not answered
    assert.match(ans.prompt.text, /NOT approved\. Feedback: "make it night"\n  Revise it and show it for review again\.$/);
    assert.throws(() => cli('ask', 'Check it', '--review', path.join(dir, 'missing.txt')), /no such file/);
    assert.match(cli('secret', 'rm', 'COMFY_API_KEY'), /removed/);
    assert.match(cli('secret', 'list'), /no keys saved/);
  } finally { srv.kill(); }
});

// A minimal GLB: a JSON chunk only (glbInfo reads nothing else), with one mesh and one 2.5 s clip.
function tinyGlb({ clipMax = 2.5, top = 1.7 } = {}) {
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    accessors: [{ type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, top, 1] }, { type: 'SCALAR', count: 2, min: [0], max: [clipMax] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    animations: [{ name: 'dance', samplers: [{ input: 1, output: 0 }], channels: [] }],
  }));
  const pad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20), body = Buffer.concat([json, pad]);
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, body]);
}

test('model op: needs a .glb file name in models/, keeps offset and speed', () => {
  assert.throws(() => applyOps(createDoc(), { op: 'add', type: 'model' }), /needs a file/);
  assert.throws(() => applyOps(createDoc(), { op: 'add', type: 'model', file: '../x.glb' }), /models\/ folder/);
  assert.throws(() => applyOps(createDoc(), { op: 'add', type: 'model', file: 'x.obj' }), /models\/ folder/);
  assert.throws(() => applyOps(createDoc(), { op: 'add', type: 'model', file: 'x.glb', offset: 'soon' }), /must be a number/);
  let { doc } = applyOps(createDoc(), { op: 'add', type: 'model', name: 'dancer', file: 'dance-1a2b3c4d.glb', length: 13, h: 1.7 });
  assert.deepEqual(doc.objects[0].params, { file: 'dance-1a2b3c4d.glb', offset: 0, speed: 1, length: 13, h: 1.7 });
  doc = applyOps(doc, { op: 'update', id: 'dancer', offset: 2, speed: 0.5 }).doc;
  assert.deepEqual([doc.objects[0].params.offset, doc.objects[0].params.speed], [2, 0.5]);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'dancer', file: null }), /needs a file/);
  assert.throws(() => applyOps(createDoc(), [{ op: 'add', type: 'box', id: 'b' }, { op: 'update', id: 'b', type: 'model' }]), /needs a file/);
});

test('glbInfo reads clip lengths and height from a GLB without loading it', async () => {
  const { glbInfo } = await import('../server/index.mjs');
  assert.deepEqual(glbInfo(tinyGlb()), { clips: [{ name: 'dance', length: 2.5 }], height: 1.7, meshes: 1, skins: 0 });
  assert.equal(glbInfo(Buffer.from('not a glb at all, honestly')), null);
});

test('canvas import uploads a GLB to models/, adds a model and --fit sets the shot length', async () => {
  const os = await import('node:os');
  const { spawn, execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-model-'));
  const port = 5394;
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'serve', '--scene', path.join(dir, 'scene.json'), '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env: { ...process.env, CANVAS_PORT: String(port) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const file = path.join(dir, 'My Dance.glb');
    fs.writeFileSync(file, tinyGlb());
    const said = cli('import', file, '--offset', '1', '--fit');
    assert.match(said, /^my-dance: My Dance\.glb → models\/my-dance-[0-9a-f]{8}\.glb/);
    assert.match(said, /clip "dance" 2\.5s plays from action time 1s/);
    assert.match(said, /shot length set to 2\.5s/);
    const { doc } = await (await fetch(`${base}/api/doc`)).json();
    const o = doc.objects[0];
    assert.deepEqual([o.type, o.params.offset, o.params.length, o.params.h, doc.timeline.duration], ['model', 1, 2.5, 1.7, 2.5]);
    assert.ok(fs.existsSync(path.join(dir, 'models', o.params.file)));
    const served = await fetch(`${base}/models/${o.params.file}`);
    assert.equal(served.headers.get('content-type'), 'model/gltf-binary');
    // a GLB dropped in the chat: uploaded, sent with the prompt by path, not added to the scene
    const up = await (await fetch(`${base}/api/model?name=Chair.glb`, { method: 'POST', body: tinyGlb({ top: 0.9 }) })).json();
    const sent = await (await fetch(`${base}/api/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '', models: [{ file: up.file, name: 'Chair.glb' }, { file: '../scene.json' }, 'missing-00000000.glb'] }) })).json();
    assert.deepEqual(sent.prompt.models.map((m) => [m.file, m.name, m.path]), [[up.file, 'Chair.glb', path.join(dir, 'models', up.file)]]);
    const waited = cli('wait', '--timeout', '2');
    assert.match(waited, /\(no text, see the attached models\)/);
    assert.match(waited, new RegExp(`GLB models attached, NOT in the scene yet .*Chair\\.glb → ${path.join(dir, 'models', up.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal((await (await fetch(`${base}/api/doc`)).json()).doc.objects.length, 1);
    fs.writeFileSync(path.join(dir, 'bad.glb'), 'nope');
    assert.throws(() => cli('import', path.join(dir, 'bad.glb')), /not a GLB/);
  } finally { srv.kill(); }
});

test('save-rm deletes a save: it leaves the list, its file and thumbnail move to saved/.deleted/', async () => {
  const os = await import('node:os');
  const { spawn, execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-saverm-'));
  const port = 5393;
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'serve', '--scene', path.join(dir, 'scene.json'), '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env: { ...process.env, CANVAS_PORT: String(port) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    cli('save', 'keep');
    cli('save', 'gone');
    fs.writeFileSync(path.join(dir, 'saved', 'gone.png'), 'png');
    assert.match(cli('save-rm', 'gone'), /deleted save "gone" .*the open scene is unchanged/);
    assert.deepEqual((await (await fetch(`${base}/api/saves`)).json()).saves.map((x) => x.name), ['keep']);
    const bin = fs.readdirSync(path.join(dir, 'saved', '.deleted')).sort();
    assert.equal(bin.length, 2);
    assert.ok(bin[0].startsWith('gone-') && bin[0].endsWith('.json') && bin[1].endsWith('.png'));
    assert.ok(!fs.existsSync(path.join(dir, 'saved', 'gone.json')) && !fs.existsSync(path.join(dir, 'saved', 'gone.png')));
    assert.throws(() => cli('save-rm', 'gone'), /no save "gone"/);
  } finally { srv.kill(); }
});

test('high detail: a Review card per prompt, and the final reply waits for written-up passes after the last change', async () => {
  const { spawn, execFile } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-detail-'));
  const port = 5394;
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'serve', '--scene', path.join(dir, 'scene.json'), '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  // async, so the fake tab below can answer the CLI's render calls meanwhile
  const cli = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env: { ...process.env, CANVAS_PORT: String(port) }, encoding: 'utf8' },
    (err, stdout, stderr) => (err ? reject(Object.assign(new Error(stderr || err.message), { stdout })) : resolve(stdout))));
  const post = async (route, body) => (await fetch(base + route, { method: 'POST', body: JSON.stringify(body) })).json();
  const log = () => fs.readFileSync(path.join(dir, '.canvas', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const card = () => log().filter((m) => m.kind === 'progress').at(-1).progress;
  // a stand-in for the browser tab: answers inspect with a sheet
  let n = 0;
  const tab = http.get(`${base}/api/events?client=fake`, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!block.startsWith('event: rpc')) continue;
        const { id, params } = JSON.parse(block.split('data: ')[1]);
        n++;
        post('/api/rpc/result', { id, result: { path: `/x/inspect-${n}.png`, url: `/exports/inspect-${n}.png`, objects: 2, ids: params.ids, views: ['front (+z)', 'back (-z)', 'side (+x)', 'side (-x)', '3/4 high', 'top'], size: [1, 1, 1], lowest: 0, floating: [], sunk: [] } });
      }
    });
  });
  tab.on('error', () => {});
  try {
    await new Promise((r) => setTimeout(r, 200));
    const sent = await post('/api/prompt', { text: 'Build a van', detail: 'high' });
    assert.equal(sent.prompt.detail, 'high');
    const got = await cli('wait', '--timeout', '2', '--no-listen');
    assert.match(got, /detail: HIGH/);
    assert.match(got, /canvas inspect <prefix>/);
    assert.deepEqual([card().title, card().state, card().step, card().review.prompt], ['High detail', 'running', 1, sent.prompt.id]);
    const jobs = (await (await fetch(`${base}/api/jobs`)).json()).jobs;
    assert.deepEqual([jobs.length, jobs[0].review], [1, sent.prompt.id]);

    await cli('add', 'box', '--name', 'van-body');
    assert.deepEqual([card().step, card().note], [2, 'Building']);
    await assert.rejects(cli('say', 'Built the van'), /0 review passes so far, at least 2/);
    await assert.rejects(cli('review', 'looks fine'), /inspect first/);
    assert.match(await cli('inspect', 'van-'), /this is pass 1 \(at least 2\)/);
    assert.deepEqual([card().step, card().review.passes.length, card().review.passes[0].url], [3, 1, '/exports/inspect-1.png']);
    assert.match(await cli('review', 'no wheels | roof too flat'), /pass 1: 2 to fix/);
    await cli('add', 'cylinder', '--name', 'van-wheel');
    assert.equal(card().note, 'Fixing what pass 1 found');
    await cli('inspect', 'van-');
    await assert.rejects(cli('say', 'Built the van'), /write up what you saw on pass 2/);
    await cli('review', 'no problems');
    await cli('set', 'van-wheel', '--pos', '1,0,0');
    await assert.rejects(cli('say', 'Built the van'), /scene changed after your last look/);
    await cli('inspect', 'van-');
    assert.match(await cli('review', 'no problems'), /You can finish/);
    await cli('say', 'Built the van');
    assert.deepEqual([card().state, card().note, card().review.passes.length], ['done', '3 review passes · 2 fixes', 3]);
    assert.equal((await (await fetch(`${base}/api/jobs`)).json()).jobs.length, 0);
    assert.equal(log().at(-1).text, 'Built the van');

    // a high detail prompt that changes nothing (a question) needs no review; --skip ends one honestly
    await post('/api/prompt', { text: 'How big is it?', detail: 'high' });
    await cli('wait', '--timeout', '2', '--no-listen');
    await cli('say', 'About 4.5 m long');
    assert.deepEqual([card().state, card().note], ['done', 'No changes to review']);
    await post('/api/prompt', { text: 'Add a roof rack', detail: 'high' });
    await cli('wait', '--timeout', '2', '--no-listen');
    await cli('add', 'box', '--name', 'van-rack');
    await assert.rejects(cli('review', '--skip'), /say why/);
    await cli('review', '--skip', 'no canvas tab to render with');
    assert.deepEqual([card().state, card().note], ['done', 'Review skipped: no canvas tab to render with']);
    await cli('say', 'Added the rack');
    // a plain prompt gets no card
    const cards = log().filter((m) => m.kind === 'progress').length;
    await post('/api/prompt', { text: 'Move it left' });
    await cli('wait', '--timeout', '2', '--no-listen');
    await cli('set', 'van-body', '--pos', '-1,0,0');
    await cli('say', 'Moved');
    assert.equal(log().filter((m) => m.kind === 'progress').length, cards);
  } finally { tab.destroy(); srv.kill(); }
});
