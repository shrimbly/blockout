// Fast checks: core document ops, easing math, and that the skill copies are in sync. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, applyOps, migrate, PRIMITIVES, shotList, shotTimeline } from '../core/doc.js';
import { bezier, sampleCamera, sampleObject, resolveEase, EASES, remapTime, fovToLens, lensToFov, isCut } from '../core/curves.js';

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

test('every primitive has a geometry builder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/geometry.js'), 'utf8');
  for (const t of Object.keys(PRIMITIVES)) assert.match(src, new RegExp(`\\b${t}[:(]`), t);
});

test('skill copies for Claude and Codex are identical', () => {
  const a = path.join(ROOT, '.claude/skills/camera-canvas'), b = path.join(ROOT, '.agents/skills/camera-canvas');
  const list = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
  assert.deepEqual(list(a), list(b));
  for (const f of list(a)) assert.equal(fs.readFileSync(path.join(a, f), 'utf8'), fs.readFileSync(path.join(b, f), 'utf8'), f);
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
  const ref = fs.readFileSync(path.join(ROOT, 'skills/camera-canvas/references/builder.md'), 'utf8');
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
  assert.deepEqual(doc.objects.map((o) => o.params), [{ h: null, body: 'male', detail: null }, { h: null, body: 'female', detail: null }, { h: 1.1, body: 'child', detail: null }]);
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

test('the Claude Code plugin manifests parse and their hooks run the same CLI as the checkout hooks', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const plugin = read('.claude-plugin/plugin.json'), market = read('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'blockout-agent');
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
  fs.writeFileSync(path.join(none, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'blockout-agent@blockout-agent': [{}] } }));
  assert.equal(launchInfo({ CLAUDE_CONFIG_DIR: none }).plugin, true);
  assert.equal(launchInfo({}, '/Users/x/.claude/plugins/cache/blockout-agent/0.3.0').plugin, true);
});

test('audio op: load, offset, volume, fit, replace, clear', () => {
  assert.throws(() => applyOps(createDoc(), { op: 'audio', offset: 1 }), /no audio on the timeline/);
  assert.throws(() => applyOps(createDoc(), { op: 'audio', file: '../x.mp3' }), /file name/);
  assert.throws(() => applyOps(createDoc(), { op: 'audio', file: 'song.txt' }), /file name/);
  let { doc } = applyOps(createDoc(), { op: 'audio', file: 'song-1.mp3', name: 'Song.mp3' });
  assert.deepEqual(doc.timeline.audio, { file: 'song-1.mp3', name: 'Song.mp3', offset: 0, volume: 1, muted: false });
  assert.throws(() => applyOps(doc, { op: 'audio', fit: true }), /length is not known/);
  ({ doc } = applyOps(doc, { op: 'audio', length: 12.3456, offset: -2, volume: 0.5, muted: true }));
  assert.equal(doc.timeline.audio.length, 12.346);
  assert.equal(doc.timeline.audio.offset, -2);
  assert.equal(doc.timeline.audio.muted, true);
  ({ doc } = applyOps(doc, { op: 'audio', fit: true }));
  assert.equal(doc.timeline.duration, 10.346);
  assert.throws(() => applyOps(doc, { op: 'audio', volume: 9 }), /volume/);
  // a new file resets the offset and the known length, keeps volume
  ({ doc } = applyOps(doc, { op: 'audio', file: 'other.wav' }));
  assert.equal(doc.timeline.audio.offset, 0);
  assert.equal(doc.timeline.audio.length, undefined);
  assert.equal(doc.timeline.audio.volume, 0.5);
  assert.equal(migrate(doc).timeline.audio.file, 'other.wav');
  ({ doc } = applyOps(doc, { op: 'audio', clear: true }));
  assert.equal(doc.timeline.audio, undefined);
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
    { op: 'timeline', duration: 5, interp: 'linear' }, { op: 'audio', file: 'a.wav', offset: 0.5 }]);
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
  assert.equal(b.audio.offset, -1.5, 'the audio carries on');
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

test('model: a .glb by file name, named after its file, h scales it; the file name is checked', () => {
  const { doc, results } = applyOps(createDoc(), [
    { op: 'add', type: 'model', file: 'old-car-3f9a1c2e.glb', h: 1.5, position: [2, 0, 0] },
    { op: 'add', type: 'model', file: 'old-car-3f9a1c2e.glb', name: 'Hero car' },
  ]);
  assert.deepEqual(results.map((r) => r.id), ['old-car', 'hero-car']);
  assert.deepEqual(doc.objects[0].params, { file: 'old-car-3f9a1c2e.glb', h: 1.5 });
  assert.throws(() => applyOps(doc, { op: 'add', type: 'model' }), /needs its file/);
  assert.throws(() => applyOps(doc, { op: 'add', type: 'model', file: '../secret.glb' }), /\.glb file name/);
  assert.throws(() => applyOps(doc, { op: 'add', type: 'model', file: 'tree.obj' }), /\.glb file name/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'old-car', file: null }), /needs its file/);
  const { doc: d2 } = applyOps(doc, { op: 'update', id: 'old-car', size: 3 });
  assert.equal(d2.objects[0].params.h, 3);
  assert.equal(migrate(JSON.parse(JSON.stringify(d2))).objects[0].params.file, 'old-car-3f9a1c2e.glb');
});

test('glbInfo reads a .glb\'s size through its node transforms and rejects other files', async () => {
  const { glbInfo } = await import('../server/glb.mjs');
  const { boxGlb } = await import('./glb-fixture.mjs');
  const i = glbInfo(boxGlb({ w: 2, h: 3, d: 4, translation: [5, 1, 0], scale: [100, 100, 100] }));
  assert.deepEqual(i.size, [200, 300, 400]);
  assert.deepEqual(i.min, [-95, 1, -200]);
  assert.equal(i.triangles, 12);
  assert.deepEqual(glbInfo(boxGlb({ w: 1, h: 2, d: 1 })).size, [1, 2, 1]);
  assert.throws(() => glbInfo(Buffer.from('{"asset":{"version":"2.0"}} padding padding')), /not a \.glb/);
});
