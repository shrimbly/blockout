// End-to-end test: starts a server on a temp scene, drives it with the CLI and a headless browser.
// Needs Playwright with Chromium (npx playwright install chromium). Run: node test/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip: playwright not installed'); process.exit(0); }

const PORT = 5399;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-e2e-'));
const env = { ...process.env, CANVAS_PORT: String(PORT), CLAUDE_CODE_SESSION_ID: 'e2e-session', CANVAS_SECRETS: path.join(dir, 'secrets.json') };
const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env, encoding: 'utf8' }).trim();
const cliAsync = (...args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out))));
});
// A GLB three.js can load: a 1 m cube (positions + indices), bottom at y = 0.
function boxGlb() {
  const P = [];
  for (const x of [-0.5, 0.5]) for (const y of [0, 1]) for (const z of [-0.5, 0.5]) P.push(x, y, z);
  const I = [0,1,3, 0,3,2, 4,6,7, 4,7,5, 0,4,5, 0,5,1, 2,3,7, 2,7,6, 0,2,6, 0,6,4, 1,5,7, 1,7,3];
  const pos = Buffer.from(new Float32Array(P).buffer), idx = Buffer.from(new Uint16Array(I).buffer);
  const bin = Buffer.concat([pos, idx, Buffer.alloc((4 - ((pos.length + idx.length) % 4)) % 4)]);
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }, { bufferView: 1, componentType: 5123, count: I.length, type: 'SCALAR' }],
  }));
  const jpad = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  const body = Buffer.concat([chunk(0x4e4f534a, jpad), chunk(0x004e4942, bin)]);
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const server = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'serve', '--scene', path.join(dir, 'scene.json'), '--port', String(PORT)], { env, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // --- agent builds a scene before any tab is open ---
  cli('clear', '--keys');
  ok(cli('add', 'box', '--name', 'tower', '--size', '2,5,2', '--pos', '0,0,0') === 'tower', 'add box by name');
  ok(cli('add', 'sphere', '--r', '0.6', '--pos', '3,0,1') === 'sphere-1', 'add sphere gets an id');
  cli('key', '--t', '0', '--pos', '8,3,8', '--target', '0,1,0', '--lens', '35');
  cli('key', '--t', '4', '--pos', '-8,2,6', '--target', '0,1,0', '--ease', 'slowOut');
  cli('timeline', '--duration', '4', '--fps', '12');
  ok(/camera keys \(2\)/.test(cli('ls')), 'ls lists 2 camera keys');
  let failed = false; try { cli('add', 'blob'); } catch { failed = true; }
  ok(failed, 'unknown type is rejected');
  failed = false; try { cli('seek', '1'); } catch (e) { failed = /no canvas tab/.test(e.stderr || e.message); }
  ok(failed, 'browser-only command explains that no tab is open');

  // --- open the canvas ---
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.waitForFunction(() => window.canvas?.store.doc && window.canvas.viewport.meshes.size === 2);
  ok(true, 'page loads the scene');

  // click the tower to select it
  const towerPt = () => page.evaluate(() => {
    const v = window.canvas.viewport; const m = v.meshes.get('tower').mesh;
    const p = m.position.clone(); p.y = 2.5; p.project(v.activeCam);
    const r = v.canvas.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  });
  let pt = await towerPt();
  await page.mouse.click(pt.x, pt.y);
  ok(await page.evaluate(() => window.canvas.store.state.selection) === null, 'plain click does not select');
  await page.waitForTimeout(500); // the click aimed the camera at the tower, so it moved on screen
  pt = await towerPt();
  await page.keyboard.down('Control'); await page.mouse.click(pt.x, pt.y); await page.keyboard.up('Control');
  ok(await page.evaluate(() => window.canvas.store.state.selection) === 'tower', 'ctrl-click selects the object');

  // drag the gizmo's centre handle
  const g = await page.evaluate(() => {
    const v = window.canvas.viewport; const p = v.meshes.get('tower').mesh.position.clone().project(v.activeCam);
    const r = v.canvas.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  });
  await page.mouse.move(g.x, g.y); await page.waitForTimeout(100);
  await page.mouse.down(); await page.mouse.move(g.x + 60, g.y + 10, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const pos = JSON.parse(cli('doc')).objects.find((o) => o.id === 'tower').position;
  ok(pos.some((v) => Math.abs(v) > 0.05), `gizmo drag moves the object and saves it (${pos})`);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(300);
  ok(JSON.parse(cli('doc')).objects.find((o) => o.id === 'tower').position.every((v) => v === 0), 'undo restores the position');

  // agent drives the timeline and the camera
  ok(JSON.parse(cli('seek', '2')).time === 2, 'seek');
  cli('view', 'shot');
  ok(await page.evaluate(() => window.canvas.store.state.view) === 'shot', 'view shot');
  await page.keyboard.press('k');
  await page.waitForTimeout(300);
  ok(JSON.parse(cli('doc')).timeline.keys.length === 3, 'K keys the current view at the playhead');

  // prompt from the canvas reaches a waiting agent, reply shows in the canvas
  const waiting = cliAsync('wait', '--timeout', '20');
  await page.waitForFunction(() => window.canvas.store.state.agent === true, null, { timeout: 5000 });
  ok(true, 'canvas shows the agent as listening');
  await page.fill('.chat-input', 'make the tower twice as tall');
  await page.keyboard.press('Enter');
  const got = await waiting;
  ok(/make the tower twice as tall/.test(got) && /selected: tower/.test(got), 'canvas wait receives the prompt with selection context');
  const id = got.match(/\[canvas prompt (\w+)\]/)[1];
  cli('set', 'tower', '--h', '10');
  cli('say', '--reply', id, 'Tower is now 10 m tall');
  await page.waitForSelector('.chat-msg--agent');
  ok(await page.$eval(`.chat-msg[data-status="done"]`, () => true).catch(() => false), 'prompt marked done after the reply');
  ok(await page.evaluate(() => window.canvas.viewport.meshes.get('tower').mesh.geometry.boundingBox.max.y) > 9.9, 'agent edit re-renders in the canvas');

  // the Claude Code Stop hook hands a queued prompt back to the session
  await page.fill('.chat-input', 'add a red cone');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const runHook = (session) => execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'hook', 'stop'], { env, input: JSON.stringify({ session_id: session, cwd: '/' }), encoding: 'utf8' });
  ok(runHook('some-other-session') === '', 'Stop hook leaves sessions that are not listening alone');
  const hook = JSON.parse(runHook('e2e-session'));
  ok(hook.decision === 'block' && /add a red cone/.test(hook.reason), 'Stop hook blocks with the canvas prompt');

  // a prompt the agent took but never answered is closed when it asks for the next one
  ok(await page.$$eval('.chat-msg[data-status="taken"]', (els) => els.length) === 1, 'the hook-taken prompt shows as taken');
  await cliAsync('wait', '--timeout', '1');
  await page.waitForTimeout(300);
  ok(await page.$$eval('.chat-msg[data-status="taken"]', (els) => els.length) === 0, 'calling wait again closes prompts left without a reply');

  // images attached to a chat message reach the agent as file paths
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('.chat-composer input[type=file]', { name: 'ref.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.chat-thumb:not(.is-pending)');
  ok(!(await page.$eval('.chat-send', (b) => b.disabled)), 'an attached image alone enables send');
  await page.fill('.chat-input', 'match this reference');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.chat-msg--user .chat-img img');
  ok(await page.$eval('.chat-msg--user:last-child .chat-img img', (i) => i.complete && i.naturalWidth === 2), 'the sent image shows in the thread');
  const gotImg = await cliAsync('wait', '--timeout', '5');
  const imgPath = (gotImg.match(/images attached[^:]*: (\S+)/) || [])[1];
  ok(imgPath && fs.existsSync(imgPath), 'canvas wait lists the image as a file the agent can open');
  cli('say', '--reply', gotImg.match(/\[canvas prompt (\w+)\]/)[1], 'Looked at it');

  // single click aims the camera at the clicked point
  cli('view', 'free');
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => window.canvas.viewport.freeOrbit.target.toArray());
  const vp = await page.evaluate(() => { const r = window.canvas.viewport.canvas.getBoundingClientRect(); return { x: r.left + r.width * 0.25, y: r.top + r.height * 0.75 }; });
  await page.mouse.click(vp.x, vp.y);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.canvas.viewport.freeOrbit.target.toArray());
  ok(Math.hypot(after[0] - before[0], after[2] - before[2]) > 0.5, `click aims the camera at that point (${after.map((v) => v.toFixed(2))})`);
  ok(await page.evaluate(() => window.canvas.store.state.selection) === 'tower', 'plain click keeps the selection');

  // save / load
  ok(/saved "v1"/.test(cli('save', 'v1')), 'canvas save');
  let dup = false; try { cli('save', 'v1'); } catch (e) { dup = /already exists/.test(e.stderr || e.message); }
  ok(dup, 'saving over an existing name needs --overwrite');
  cli('add', 'cone', '--name', 'extra');
  cli('load', 'v1');
  ok(!JSON.parse(cli('doc')).objects.some((o) => o.id === 'extra'), 'canvas load restores the saved scene');
  cli('undo');
  ok(JSON.parse(cli('doc')).objects.some((o) => o.id === 'extra'), 'undo reverts a load');
  await page.keyboard.press('Control+s');
  await page.fill('.scenes-field', 'from ui');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await page.click('.scenes-btn');
  await page.waitForSelector('.scenes-list img.scenes-thumb', { timeout: 5000 });
  ok((await page.textContent('.scenes-label.is-current')) === 'from-ui', 'the saved version is ticked as current');
  ok(/from-ui/.test(cli('saves')) && fs.existsSync(path.join(dir, 'saved', 'from-ui.png')), 'save from the canvas writes the scene and a thumbnail');
  await page.keyboard.press('Escape');
  ok((await page.textContent('.scenes-name')) === 'from-ui', 'the Scenes button names the version you saved');
  await page.click('.scenes-btn');
  await page.click('.scenes-action >> text=New scene');
  await page.waitForTimeout(300);
  const fresh = JSON.parse(cli('doc'));
  ok(fresh.objects.length === 0 && /^scene-\d+$/.test(fresh.meta.name), `New scene in the Scenes menu starts an empty scene (${fresh.meta.name})`);
  await page.waitForTimeout(300);
  cli('add', 'box', '--name', 'autosaved');
  await page.waitForTimeout(1200);
  const savedFile = path.join(dir, 'saved', `${fresh.meta.name}.json`);
  ok(fs.existsSync(savedFile) && JSON.parse(fs.readFileSync(savedFile, 'utf8')).objects.some((o) => o.id === 'autosaved'), 'changes autosave into the version you are on');
  cli('undo');
  cli('undo');
  ok(JSON.parse(cli('doc')).objects.length > 0, 'undo brings the old scene back after New scene');

  // objects move over time: the agent's move command plays back in the canvas
  cli('add', 'person', '--name', 'walker', '--pos', '0,0,4');
  ok(/walker moves 1s → 3s/.test(cli('move', 'walker', '--to', '0,0,-2', '--at', '1', '--over', '2', '--ease', 'linear')), 'canvas move adds a timed move');
  ok(/anim: 1s@0,0,4 → 3s@0,0,-2/.test(cli('ls')), 'canvas ls shows the move');
  cli('seek', '2');
  await page.waitForTimeout(200);
  const wz = await page.evaluate(() => window.canvas.viewport.meshes.get('walker').mesh.position.z);
  ok(Math.abs(wz - 1) < 0.05, `the object is halfway at 2s (z=${wz.toFixed(2)})`);
  const lowTris = await page.evaluate(() => window.canvas.viewport.meshes.get('walker').mesh.geometry.index.count / 3);
  ok(lowTris < 200, `a new scene draws people in low detail (${lowTris} tris)`);
  cli('env', '--people', 'high');
  await page.evaluate(() => window.canvas.store.set({ selection: 'walker' }));
  await page.waitForTimeout(250);
  const body = await page.evaluate(() => { const m = window.canvas.viewport.meshes.get('walker'); m.mesh.geometry.computeBoundingBox(); const bb = m.mesh.geometry.boundingBox; return { tris: m.mesh.geometry.index.count / 3, h: bb.max.y - bb.min.y, minY: bb.min.y, tint: m.mesh.material.emissive.getHex() }; });
  ok(body.tris < 4000 && Math.abs(body.h - 1.8) < 0.01 && Math.abs(body.minY) < 1e-4, `person is a low-poly 1.8 m mannequin standing on the ground (${body.tris} tris, h=${body.h.toFixed(3)})`);
  ok(body.tint !== 0, 'a selected person is tinted (people draw no edge lines)');
  cli('set', 'walker', '--body', 'female');
  await page.waitForTimeout(250);
  const fh = await page.evaluate(() => { const g = window.canvas.viewport.meshes.get('walker').mesh.geometry; g.computeBoundingBox(); return g.boundingBox.max.y; });
  ok(Math.abs(fh - 1.65) < 0.01, `--body female swaps the body and its usual height (h=${fh.toFixed(3)})`);
  const lowGeo = () => page.evaluate(() => { const g = window.canvas.viewport.meshes.get('walker').mesh.geometry; g.computeBoundingBox(); return { tris: g.index.count / 3, h: g.boundingBox.max.y, colors: !!g.attributes.color }; });
  cli('env', '--people', 'low');
  await page.waitForTimeout(250);
  let low = await lowGeo();
  ok(low.tris < 200 && low.colors && Math.abs(low.h - 1.65) < 0.01, `env --people low draws a box person with a face (${low.tris} tris)`);
  cli('env', '--people', 'high');
  cli('set', 'walker', '--detail', 'low');
  await page.waitForTimeout(250);
  low = await lowGeo();
  ok(low.tris < 200, '--detail low on one person overrides the scene');
  cli('set', 'walker', '--detail', 'null');
  await page.waitForTimeout(250);
  ok((await lowGeo()).tris > 1000, 'clearing --detail goes back to the scene\'s high detail');
  ok(await page.isVisible('.tl-objkey') && /Key walker/.test(await page.textContent('.tl-objkey')), 'selecting an object shows its Key button');
  cli('seek', '4');
  await page.click('.tl-objkey');
  await page.waitForTimeout(300);
  ok(JSON.parse(cli('doc')).objects.find((o) => o.id === 'walker').anim.length === 3, 'Key walker adds a key at the playhead');
  cli('okey-rm', 'walker');
  cli('rm', 'walker');
  await page.evaluate(() => window.canvas.store.set({ selection: null }));

  // the lens field drives the free view camera too
  cli('view', 'free');
  await page.evaluate(() => window.canvas.store.set({ key: null }));
  await page.waitForTimeout(100);
  const lensIn = await page.$('.tl-bar .cc-affix input');
  await lensIn.click(); await lensIn.fill('85'); await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const freeFov = await page.evaluate(() => window.canvas.viewport.freeCam.fov);
  ok(Math.abs(freeFov - 15.9) < 0.3, `lens 85 mm sets the free view to ~15.9° (got ${freeFov.toFixed(2)})`);
  const kid = JSON.parse(cli('doc')).timeline.keys[0].id;
  await page.evaluate((id) => window.canvas.store.set({ key: id }), kid);
  await page.waitForTimeout(200);
  const keyFov = JSON.parse(cli('doc')).timeline.keys[0].fov;
  ok(Math.abs((await page.evaluate(() => window.canvas.viewport.freeCam.fov)) - keyFov) < 0.01, 'selecting a key puts the free view on its lens');

  // Ctrl/Cmd + scroll changes the lens instead of dollying: free view + selected key, then shot view
  const mid = await page.evaluate(() => { const r = window.canvas.viewport.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(mid.x, mid.y);
  const posBefore = await page.evaluate(() => window.canvas.viewport.freeCam.position.toArray());
  const fovBefore = await page.evaluate(() => window.canvas.viewport.freeCam.fov);
  await page.keyboard.down('Control');
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
  const fovZoom = await page.evaluate(() => window.canvas.viewport.freeCam.fov);
  const posZoom = await page.evaluate(() => window.canvas.viewport.freeCam.position.toArray());
  ok(fovZoom < fovBefore - 0.5 && posZoom.every((v, i) => Math.abs(v - posBefore[i]) < 1e-6), `ctrl+scroll up narrows the free view lens without dollying (${fovBefore.toFixed(1)}° -> ${fovZoom.toFixed(1)}°)`);
  ok(Math.abs(JSON.parse(cli('doc')).timeline.keys[0].fov - fovZoom) < 0.01, 'ctrl+scroll in free view also sets the selected key lens');
  cli('seek', '0'); cli('view', 'shot');
  await page.waitForTimeout(200);
  const shotFov0 = await page.evaluate(() => window.canvas.viewport.shotCam.fov);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => ({ f: window.canvas.viewport.shotCam.fov, dirty: window.canvas.store.state.camDirty }));
  ok(st.f > shotFov0 + 0.5 && st.dirty, 'ctrl+scroll in shot view widens the shot camera and marks it to key');
  cli('seek', '0'); cli('view', 'free');
  await page.waitForTimeout(200);

  // keyboard fly: hold the right mouse button, W moves forward, E rises, and neither changes the gizmo
  {
    const vp = () => page.evaluate(() => { const v = window.canvas.viewport; return { p: v.freeCam.position.toArray(), t: v.freeOrbit.target.toArray(), g: window.canvas.store.state.gizmo }; });
    await page.evaluate(() => window.canvas.store.set({ key: null, gizmo: 'translate' }));
    await page.mouse.move(mid.x, mid.y);
    const a = await vp();
    const fwd = a.t.map((v, i) => v - a.p[i]); const fl = Math.hypot(...fwd);
    await page.mouse.down({ button: 'right' });
    await page.keyboard.down('w'); await page.waitForTimeout(400); await page.keyboard.up('w');
    await page.keyboard.down('e'); await page.waitForTimeout(300); await page.keyboard.up('e');
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(100);
    const b = await vp();
    const d = b.p.map((v, i) => v - a.p[i]);
    const along = d.reduce((s, v, i) => s + v * fwd[i] / fl, 0);
    ok(along > 0.5 && d[1] > 0.3, `right button + W flies forward and E rises (forward ${along.toFixed(2)} m, up ${d[1].toFixed(2)} m)`);
    ok(b.g === 'translate', 'fly keys do not switch the gizmo mode');
    // no mouse button (trackpad): W still flies forward; 1 2 3 are the gizmo keys
    const fwd2 = b.t.map((v, i) => v - b.p[i]); const fl2 = Math.hypot(...fwd2);
    await page.keyboard.down('w'); await page.waitForTimeout(400); await page.keyboard.up('w');
    await page.waitForTimeout(100);
    const b2 = await vp();
    const along2 = b2.p.reduce((s, v, i) => s + (v - b.p[i]) * fwd2[i] / fl2, 0);
    ok(along2 > 0.5 && b2.g === 'translate', `W alone flies forward too (${along2.toFixed(2)} m)`);
    await page.keyboard.press('2'); await page.waitForTimeout(50);
    ok((await vp()).g === 'rotate', '2 is the rotate shortcut');
    await page.keyboard.press('3'); await page.waitForTimeout(50);
    ok((await vp()).g === 'scale', '3 is the scale shortcut');
    await page.keyboard.press('1'); await page.waitForTimeout(50);
    ok((await vp()).g === 'translate', '1 is the move shortcut');
    {
      const first = await page.evaluate(() => window.canvas.store.doc.objects[0]?.id);
      if (first) {
        await page.evaluate((id) => window.canvas.store.set({ selection: id }), first);
        const n0 = await page.evaluate(() => window.canvas.store.doc.objects.length);
        const p0 = (await vp()).p;
        await page.keyboard.press('Shift+D'); await page.waitForTimeout(400);
        const n1 = await page.evaluate(() => window.canvas.store.doc.objects.length);
        ok(n1 === n0 + 1 && (await vp()).p.every((v, i) => Math.abs(v - p0[i]) < 1e-6), 'Shift D duplicates and does not fly');
        const dup = await page.evaluate(() => window.canvas.store.state.selection);
        if (dup && dup !== first) cli('rm', dup);
        await page.evaluate(() => window.canvas.store.set({ selection: null }));
      }
    }
    await page.evaluate(() => { const o = window.canvas.viewport.freeOrbit; o.enableDamping = false; o.update(); o.enableDamping = true; });
    const b3 = await vp();
    await page.mouse.down({ button: 'right' }); await page.mouse.move(mid.x + 60, mid.y + 30, { steps: 4 }); await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(300);
    const c = await vp();
    ok(c.p.some((v, i) => Math.abs(v - b3.p[i]) > 0.05), 'right-drag without a fly key still pans');
    // stop the pan's damping glide so later checks see a still camera
    await page.evaluate(() => { const o = window.canvas.viewport.freeOrbit; o.enableDamping = false; o.update(); o.enableDamping = true; });

    // roll: right button + X tilts the free view, K keys the roll, the shot camera plays it back
    await page.mouse.down({ button: 'right' });
    await page.keyboard.down('x'); await page.waitForTimeout(400); await page.keyboard.up('x');
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(100);
    const r = await page.evaluate(() => { const v = window.canvas.viewport; const up = new v.freeCam.up.constructor(0, 1, 0).applyQuaternion(v.freeCam.quaternion); return { roll: v.freeRoll, upX: up.x, upZ: up.z, field: document.querySelector('.tl-bar').textContent.includes('°') }; });
    ok(r.roll > 5 && Math.hypot(r.upX, r.upZ) > 0.05, `right button + X rolls the free view (${r.roll.toFixed(1)}°)`);
    ok(r.field, 'the bar shows a roll field');
    const rollT = 2.25;
    await page.evaluate((t) => window.canvas.timeline.seek(t), rollT);
    await page.keyboard.press('k');
    await page.waitForTimeout(300);
    const rk = JSON.parse(cli('doc')).timeline.keys.find((k) => Math.abs(k.t - rollT) < 1e-3);
    ok(rk && Math.abs(rk.roll - r.roll) < 0.05, `K keys the roll (${rk?.roll})`);
    cli('view', 'shot'); await page.waitForTimeout(200);
    ok(Math.abs((await page.evaluate(() => window.canvas.viewport.shotRoll)) - rk.roll) < 0.05, 'the shot camera plays the keyed roll back');
    cli('key-rm', rk.id); cli('view', 'free');
    await page.evaluate(() => { window.canvas.viewport.freeRoll = 0; window.canvas.store.set({ key: null }); });
    await page.waitForTimeout(200);
  }

  // orchestration helpers: scoped batches, per-area listing, snapshots from the agent's own camera
  const fsx = await import('node:fs');
  const scoped = path.join(dir, 'scoped.json');
  fsx.writeFileSync(scoped, JSON.stringify([{ op: 'add', type: 'box', name: 'zone-a-wall', w: 2 }, { op: 'add', type: 'box', name: 'zone-a-roof', position: [0, 1, 0] }]));
  cli('ops', scoped, '--scope', 'zone-a-');
  ok(/zone-a-wall/.test(cli('ls', '--prefix', 'zone-a-')) && !/tower/.test(cli('ls', '--prefix', 'zone-a-')), 'ls --prefix lists one area');
  fsx.writeFileSync(scoped, JSON.stringify([{ op: 'update', id: 'tower', h: 1 }]));
  let refused = '';
  try { cli('ops', scoped, '--scope', 'zone-a-'); } catch (e) { refused = String(e.stderr || e.message); }
  ok(/not one of yours/.test(refused), 'ops --scope refuses changes to objects outside the prefix');
  fsx.writeFileSync(scoped, JSON.stringify([{ op: 'key.add', t: 1, position: [1, 1, 1], target: [0, 0, 0] }]));
  refused = '';
  try { cli('ops', scoped, '--scope', 'zone-a-'); } catch (e) { refused = String(e.stderr || e.message); }
  ok(/outside scope/.test(refused), 'ops --scope refuses camera changes');
  const freeBefore = await page.evaluate(() => window.canvas.viewport.freeCam.position.toArray());
  const own = cli('snapshot', '--from', '6,4,6', '--target', '0,1,0', '--lens', '28');
  const freeAfter = await page.evaluate(() => window.canvas.viewport.freeCam.position.toArray());
  ok(fsx.existsSync(own.trim()) && freeBefore.every((v, i) => v === freeAfter[i]), 'snapshot --from/--target renders without moving the user view');
  cli('rm', 'zone-a-wall', 'zone-a-roof');

  // shot -> free with a key selected keeps the shot camera's position and lens
  const k0 = JSON.parse(cli('doc')).timeline.keys[0];
  await page.evaluate((id) => window.canvas.store.set({ key: id }), k0.id);
  cli('seek', String(k0.t)); cli('view', 'shot');
  await page.waitForTimeout(200);
  const shotPose = await page.evaluate(() => ({ p: window.canvas.viewport.shotCam.position.toArray(), f: window.canvas.viewport.shotCam.fov }));
  cli('view', 'free');
  await page.waitForTimeout(200);
  const freePose = await page.evaluate(() => ({ p: window.canvas.viewport.freeCam.position.toArray(), f: window.canvas.viewport.freeCam.fov }));
  ok(freePose.p.every((v, i) => Math.abs(v - shotPose.p[i]) < 1e-3) && Math.abs(freePose.f - shotPose.f) < 1e-3, 'back to free with a key selected keeps the shot position and lens');

  // + New shot row: a click adds the next shot on this shot's last frame; a drag from the playhead draws an
  // overlapping one, and the confirmation's button ends the first shot there (what Cut used to do)
  const tlBefore = JSON.parse(cli('doc')).timeline, fr = tlBefore.fps;
  let tc = null;
  for (let f = Math.round((tlBefore.duration * fr) / 2); f < tlBefore.duration * fr - 2; f++) {
    if (!tlBefore.keys.some((k) => Math.abs(k.t - f / fr) < 2.5 / fr)) { tc = +(f / fr).toFixed(3); break; }
  }
  ok(await page.locator('.tl-bar button', { hasText: /^Cut$/ }).count() === 0, 'the bar has no Cut button');
  // the timeline bar steps down (icon-only buttons, shorter readouts) instead of squeezing its controls together
  const barAt = async (w) => {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForFunction(() => { const b = document.querySelector('.tl-bar'); return b.scrollWidth <= b.clientWidth + 0.5; }, null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(100);
    return page.evaluate(() => { const b = document.querySelector('.tl-bar'); return { over: b.scrollWidth - b.clientWidth, fit: [1, 2, 3].filter((i) => b.classList.contains(`is-fit${i}`)).length }; });
  };
  await page.evaluate(() => { const s = window.canvas.store; s.set({ key: s.doc.timeline.keys[0]?.id || null }); });
  const barWide = await barAt(1600), barNarrow = await barAt(720);
  ok(barWide.fit === 0 && barWide.over <= 0, `timeline bar keeps its labels when there is room (${JSON.stringify(barWide)})`);
  ok(barNarrow.fit > 0 && barNarrow.over <= 0, `timeline bar steps down to fit a narrow window (${JSON.stringify(barNarrow)})`);
  const barTiny = await barAt(480);
  const inMenu = await page.evaluate(() => !!document.querySelector('.tl-more-pop .tl-shot') && getComputedStyle(document.querySelector('.tl-more')).display !== 'none');
  ok(inMenu, `narrowest: less used controls move into the ⋯ menu (${JSON.stringify(barTiny)})`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => !!document.querySelector('.tl-bar > .tl-shot'));
  ok(true, 'and come back to the bar when there is room');
  const nb = await page.locator('.tl-track').boundingBox();
  const nY = nb.y + await page.evaluate(() => window.canvas.timeline.newRowY());
  const nX = async (a) => nb.x + await page.evaluate((a) => window.canvas.timeline.xAction(a), a);
  await page.mouse.click(nb.x + 40, nY);
  await page.waitForFunction(() => window.canvas.store.doc.shots.length === 2);
  const dNext = JSON.parse(cli('doc')), lastK = [...tlBefore.keys].sort((a, b) => a.t - b.t).pop();
  ok(dNext.shot === 'shot-2' && dNext.timeline.start === tlBefore.duration && dNext.timeline.keys.length === 1
    && dNext.timeline.keys[0].position.every((v, i) => Math.abs(v - lastK.position[i]) < 1e-3),
    'clicking + New shot adds the next shot, starting on the last frame');
  cli('undo'); cli('shot', '1');
  await page.waitForFunction(() => window.canvas.store.doc.shots.length === 1);
  cli('seek', String(tc)); await page.waitForTimeout(150);
  await page.mouse.move(await nX(tc + 0.01), nY); await page.mouse.down();
  await page.mouse.move(await nX(tc + 0.8), nY, { steps: 4 }); await page.mouse.move(await nX(tc + 1.5), nY, { steps: 4 }); await page.mouse.up();
  await page.waitForFunction(() => window.canvas.store.doc.shots.length === 2);
  const dDrag = JSON.parse(cli('doc'));
  ok(dDrag.timeline.start === tc && Math.abs(dDrag.timeline.duration - 1.5) < 0.1, `dragging across the row draws a shot from the playhead (${dDrag.timeline.start}, ${dDrag.timeline.duration})`);
  await page.click('.cc-toast button');
  await page.waitForFunction((tc) => window.canvas.store.doc.shots[0].timeline?.duration === tc, tc);
  ok(true, 'the confirmation ends the first shot where the new one starts');
  cli('undo'); cli('undo'); cli('shot', '1');
  await page.waitForFunction(() => window.canvas.store.doc.shots.length === 1);
  ok(JSON.parse(cli('doc')).timeline.duration === tlBefore.duration, 'undo removes the trim and the new shot');
  // drag the shot's right end (just past the last key) to retime it: every key stretches with it
  {
    const D = tlBefore.duration, ey = nb.y + await page.evaluate(() => window.canvas.timeline.yAt());
    await page.mouse.move(await nX(D) + 4, ey); await page.mouse.down();
    await page.mouse.move(await nX(D * 1.25) + 4, ey, { steps: 4 }); await page.mouse.move(await nX(D * 1.5) + 4, ey, { steps: 4 }); await page.mouse.up();
    await page.waitForFunction((D) => Math.abs(window.canvas.store.doc.timeline.duration - D * 1.5) < 0.15, D, { timeout: 3000 }).catch(() => {});
    const r = JSON.parse(cli('doc')).timeline, f = r.duration / D;
    const ts0 = tlBefore.keys.map((k) => k.t).sort((a, b) => a - b), ts1 = r.keys.map((k) => k.t).sort((a, b) => a - b);
    ok(Math.abs(f - 1.5) < 0.1 && ts1.every((t, i) => Math.abs(t - ts0[i] * f) < 0.01), `dragging a shot's end retimes it, keys stretch (${D} → ${r.duration}s)`);
    cli('undo');
    ok(JSON.parse(cli('doc')).timeline.duration === D, 'undo restores the shot length');
  }
  // pick several shots (Shift/Cmd-click their bars, or a Shift-drag box), drag them together, Delete removes them
  {
    const D = tlBefore.duration;
    cli('shot-add', '--name', 'msA', '--start', String(D + 1), '--length', '1', '--stay');
    cli('shot-add', '--name', 'msB', '--start', String(D + 3), '--length', '1', '--stay');
    await page.waitForFunction(() => window.canvas.store.doc.shots.length === 3);
    await page.waitForTimeout(150);
    const byName = Object.fromEntries(JSON.parse(cli('doc')).shots.map((s) => [s.name, s.id])), A = byName.msA, B = byName.msB;
    const tb = await page.locator('.tl-track').boundingBox(); // the track grew a row for each new shot
    const rY = async (id) => tb.y + await page.evaluate((id) => window.canvas.timeline.rowY(id), id);
    const nX = async (a) => tb.x + await page.evaluate((a) => window.canvas.timeline.xAction(a), a);
    const yA = await rY(A), yB = await rY(B);
    await page.keyboard.down('Shift');
    await page.mouse.click(await nX(D + 1.5), yA); await page.mouse.click(await nX(D + 3.5), yB);
    await page.keyboard.up('Shift');
    let pk = await page.evaluate(() => window.canvas.timeline.pickedShots());
    ok(pk.length === 2 && pk.includes(A) && pk.includes(B), `Shift-click picks several shots (${pk})`);
    await page.mouse.move(await nX(D + 1.5), yA); await page.mouse.down();
    await page.mouse.move(await nX(D + 2), yA, { steps: 4 }); await page.mouse.move(await nX(D + 2.5), yA, { steps: 4 }); await page.mouse.up();
    const starts = () => Object.fromEntries(JSON.parse(cli('doc')).shots.map((s) => [s.id, s.timeline?.start ?? 0]));
    await page.waitForFunction(([A, a]) => Math.abs((window.canvas.store.doc.shots.find((s) => s.id === A).timeline?.start ?? 0) - a) < 0.1, [A, tlBefore.duration + 2], { timeout: 3000 }).catch(() => {});
    const s1 = starts();
    ok(Math.abs(s1[A] - (D + 2)) < 0.1 && Math.abs(s1[B] - (D + 4)) < 0.1, `dragging one picked bar moves them all (${s1[A]}, ${s1[B]})`);
    cli('undo');
    const s2 = starts();
    ok(Math.abs(s2[A] - (D + 1)) < 1e-3 && Math.abs(s2[B] - (D + 3)) < 1e-3, 'one undo puts them all back');
    await page.keyboard.press('Escape');
    ok((await page.evaluate(() => window.canvas.timeline.pickedShots())).length === 0, 'Esc lets go of the picked shots');
    await page.waitForTimeout(100);
    await page.keyboard.down('Shift');
    await page.mouse.move(await nX(D + 0.4), yA - 4); await page.mouse.down();
    await page.mouse.move(await nX(D + 2.5), (yA + yB) / 2, { steps: 4 }); await page.mouse.move(await nX(D + 4.5), yB + 4, { steps: 4 }); await page.mouse.up();
    await page.keyboard.up('Shift');
    pk = await page.evaluate(() => window.canvas.timeline.pickedShots());
    ok(pk.length === 2 && pk.includes(A) && pk.includes(B), `a Shift-drag box picks the shots it touches (${pk})`);
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => window.canvas.store.doc.shots.length === 1);
    ok(true, 'Delete removes every picked shot');
    cli('undo');
    await page.waitForFunction(() => window.canvas.store.doc.shots.length === 3);
    cli('undo'); cli('undo'); cli('shot', '1');
    await page.waitForFunction(() => window.canvas.store.doc.shots.length === 1);
    ok(true, 'undo brings them back');
  }
  // a hold key inside a shot still cuts within the clip; the pair is drawn as one split key either side
  // of the cut line and each half selects its own key
  cli('key', '--t', String(tc), '--pos', '5,2,5', '--target', '0,1,0', '--ease', 'hold');
  cli('key', '--t', String(+(tc + 1 / fr).toFixed(3)), '--pos', '5,2,5', '--target', '0,1,0');
  await page.waitForTimeout(300);
  const tlCut = JSON.parse(cli('doc')).timeline;
  const ka = tlCut.keys.find((k) => Math.abs(k.t - tc) < 1e-3), kb = tlCut.keys.find((k) => Math.abs(k.t - (tc + 1 / fr)) < 2e-3);
  const tb = await page.locator('.tl-track').boundingBox();
  const txOf = (t) => tb.x + xs[t];
  const xs = await page.evaluate(([a, b]) => ({ [a]: window.canvas.timeline.xAt(a), [b]: window.canvas.timeline.xAt(b) }), [ka.t, kb.t]);
  const cutX = (txOf(ka.t) + txOf(kb.t)) / 2, midY = tb.y + await page.evaluate(() => window.canvas.timeline.yAt());
  await page.mouse.click(cutX - 3, midY); await page.waitForTimeout(120);
  const leftSel = await page.evaluate(() => window.canvas.store.state.key);
  await page.mouse.click(cutX + 4, midY); await page.waitForTimeout(120);
  const rightSel = await page.evaluate(() => window.canvas.store.state.key);
  ok(leftSel === ka.id && rightSel === kb.id, 'left half of a split key selects the end of the shot, right half the start of the next');
  cli('undo'); cli('undo');
  ok(JSON.parse(cli('doc')).timeline.keys.length === tlBefore.keys.length, 'undo removes the hold cut');

  // the play button pauses while playing (its icon must not be rebuilt every frame)
  await page.click('.tl-bar button[title^="Play"]').catch(async () => page.keyboard.press(' '));
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.canvas.store.state.playing), 'play button starts playback');
  await page.mouse.move(0, 0);
  const pb = await page.$('button[title^="Pause"]');
  await pb.click({ delay: 120 });
  await page.waitForTimeout(150);
  ok(!(await page.evaluate(() => window.canvas.store.state.playing)), 'pause button stops playback');

  // the message box grows with its text, up to a cap, and shrinks back after sending
  const hOf = () => page.$eval('.chat-input', (e) => e.getBoundingClientRect().height);
  const h1 = await hOf();
  await page.fill('.chat-input', 'a long message that wraps onto a second line in the chat composer box for sure, and then a third line too');
  const h2 = await hOf();
  await page.fill('.chat-input', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
  const h3 = await hOf();
  ok(h2 > h1 + 10 && h3 <= 161 && h3 > h2, `the message box grows then caps (${h1}→${h2}→${h3}px)`);
  await page.fill('.chat-input', '');
  ok(Math.abs((await hOf()) - h1) < 1, 'and shrinks back when emptied');

  // new chat clears the thread
  ok(await page.$$eval('.chat-msg', (els) => els.length) > 0, 'thread has messages before a new chat');
  await page.click('.chat-new');
  await page.waitForFunction(() => !document.querySelector('.chat-msg') && document.querySelector('.chat-empty'));
  ok(true, 'new chat empties the thread and shows the intro');

  // the archived chat is in past chats and reads back
  await page.click('.chat-past-btn');
  await page.waitForSelector('.chat-past-item');
  ok(/make the tower twice as tall/.test(await page.textContent('.chat-past-item')), 'past chats list the archived chat by its first prompt');
  await page.click('.chat-past-item');
  await page.waitForSelector('.chat-past-log .chat-msg--agent');
  ok(await page.$$eval('.chat-past-log .chat-msg--user', (els) => els.length) >= 3, 'a past chat shows your messages and the replies');
  ok(/twice as tall/.test(cli('chats')), 'canvas chats lists it for the agent');
  await page.click('.chat-past-back');
  await page.waitForSelector('.chat-past-list');
  await page.click('.chat-past-btn');
  ok(await page.isVisible('.chat-empty') && !(await page.isVisible('.chat-past')), 'the history button goes back to the current chat');

  // chat toggle + shot settings
  const chatOpen = await page.isVisible('.chat');
  await page.click('.chat-toggle');
  ok((await page.isVisible('.chat')) !== chatOpen, 'the sidebar toggle opens and closes the chat');
  if (!chatOpen) await page.click('.chat-toggle');
  await page.click('.tl-shot');
  await page.fill('.shot-pop .cc-affix input.cc-num >> nth=1', '23.976');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  ok(JSON.parse(cli('doc')).timeline.fps === 23.976, 'frame rate can be typed with decimals');
  cli('timeline', '--fps', '12');
  await page.keyboard.press('Escape');

  // renders
  const snap = cli('snapshot', '--t', '1');
  ok(fs.existsSync(snap) && fs.statSync(snap).size > 10000, 'snapshot writes a PNG');
  // flat objects a few millimetres apart stay clean when seen from far away (no depth fighting).
  // The top one is added first, so with too little depth precision the one underneath wins the ties.
  cli('op', JSON.stringify([
    { op: 'add', type: 'plane', id: 'zf-top', w: 22, d: 22, position: [150, 0.01, 150], rotation: [0, 30, 0], color: '#333333' },
    { op: 'add', type: 'plane', id: 'zf-under', w: 14, d: 14, position: [150, 0.005, 150], color: '#ff0000' },
  ]));
  const far = cli('snapshot', '--from', '260,35,260', '--target', '150,0,150', '--lens', '50');
  const showing = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    // the plane underneath is pure red and fully covered: any reddish pixel means it shows through
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let red = 0, grey = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 90 && d[i] > 2 * d[i + 1] && d[i] > 2 * d[i + 2]) red++;
      else if (d[i] < 90 && Math.abs(d[i] - d[i + 1]) < 12) grey++;
    }
    return red / Math.max(1, red + grey);
  }, `data:image/png;base64,${fs.readFileSync(far).toString('base64')}`);
  ok(showing < 0.005, `flat objects 5 mm apart stay clean from far away (${(showing * 100).toFixed(1)}% of the top plane shows the one under it)`);
  cli('op', JSON.stringify([{ op: 'remove', id: 'zf-under' }, { op: 'remove', id: 'zf-top' }]));
  const board = cli('storyboard', '--frames', '4', '--cols', '2');
  ok(fs.existsSync(board), 'storyboard writes a PNG');
  const exp = cli('export', '--width', '320', '--height', '180');
  const file = exp.split('\n')[0];
  ok(fs.existsSync(file) && /48 frames/.test(exp), `export writes an mp4 (${exp.split('\n')[1]})`);
  try {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames,width', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    ok(/^h264,320,48$/.test(probe), `ffprobe: ${probe}`);
  } catch { console.log('     (ffprobe not available, skipped)'); }

  // a reply can carry a video: it plays in the chat. The brief describes the shot the export shows.
  cli('say', '--attach', file, 'Here is the export');
  const chatWasOpen = await page.isVisible('.chat');
  if (!chatWasOpen) await page.click('.chat-toggle');
  await page.waitForSelector('.chat-msg--agent .chat-video video');
  const vid = await page.waitForFunction(() => { const v = document.querySelector('.chat-video video'); return v && v.readyState >= 1 && v.duration > 0 ? { d: v.duration, w: v.videoWidth } : null; }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
  ok(vid && vid.d > 1 && vid.w === 320, `a video attached to a reply loads in the chat (${vid ? `${vid.d.toFixed(2)}s, ${vid.w}px wide` : 'did not load'})`);
  // "Beside shot": the video goes next to the shot frame, both the same height and centred together, the chat
  // hides, the video follows the playhead, and closing it brings the chat back
  {
    const view0 = await page.evaluate(() => window.canvas.store.state.view);
    await page.click('.chat-video .chat-beside');
    await page.waitForSelector('.beside:not([hidden])');
    await page.waitForTimeout(100);
    const g = await page.evaluate(() => {
      const f = document.querySelector('.shot-frame').getBoundingClientRect(), b = document.querySelector('.beside').getBoundingClientRect();
      return { f: { x: f.x, w: f.width, h: f.height, y: f.y }, b: { x: b.x, w: b.width, h: b.height, y: b.y }, W: innerWidth, chat: !document.querySelector('.chat').hidden && document.querySelector('.chat').offsetParent !== null, view: window.canvas.store.state.view };
    });
    const mid = (g.f.x + g.b.x + g.b.w) / 2;
    ok(g.view === 'shot' && !g.chat && Math.abs(g.f.h - g.b.h) < 1 && Math.abs(g.f.y - g.b.y) < 1 && g.b.x > g.f.x + g.f.w && Math.abs(mid - g.W / 2) < 2 && Math.abs(g.b.w / g.b.h - 16 / 9) < 0.02,
      `Beside shot puts the video right of the frame, same height, centred as a pair, chat hidden (frame ${g.f.w | 0}×${g.f.h | 0} at ${g.f.x | 0}, video ${g.b.w | 0}×${g.b.h | 0} at ${g.b.x | 0}, window ${g.W})`);
    await page.evaluate(() => window.canvas.store.set({ playing: false, time: 1 }));
    await page.waitForTimeout(200);
    const vt = await page.evaluate(() => document.querySelector('.beside video').currentTime);
    const shots = JSON.parse(cli('doc')).shots.length;
    if (shots === 1) ok(Math.abs(vt - 1) < 0.05, `the video follows the playhead (timeline 1 s, video ${vt.toFixed(2)} s)`);
    await page.click('.beside-close');
    const after = await page.evaluate(() => ({ hidden: document.querySelector('.beside').hidden, chat: !!window.canvas.store.state.chat }));
    ok(after.hidden && after.chat && (await page.isVisible('.chat')), 'closing the video brings the chat back');
    await page.evaluate((v) => window.canvas.store.set({ view: v }), view0);
  }
  if (!chatWasOpen) await page.click('.chat-toggle');
  ok(/^shot 1\/\d+ .*\n(opens on|no camera keys)/.test(cli('brief')), 'canvas brief describes the active shot');

  // the Render button starts a request in the chat (it sends nothing by itself)
  {
    const wasOpen = await page.isVisible('.chat');
    if (wasOpen) await page.click('.chat-toggle');
    const queued = () => JSON.parse(JSON.stringify(cli('inbox')));
    const before = queued();
    ok(!(await page.isVisible('.tl-render')), 'Render with Comfy is tucked behind the Export menu');
    await page.click('.tl-exportbtn');
    const items = await page.$$eval('.tl-export-pop .cc-btn', (bs) => bs.map((b) => b.textContent.trim()));
    const pos = await page.evaluate(() => ({ btn: document.querySelector('.tl-exportbtn').getBoundingClientRect().bottom, pop: document.querySelector('.tl-export-pop').getBoundingClientRect().top }));
    ok(items.join('|') === 'Export full video|Export shot|Render with Comfy' && pos.pop >= pos.btn, `the whole Export button opens a menu just below it (${items.join(', ')})`);
    await page.click('.tl-render');
    ok(!(await page.isVisible('.tl-export-pop')), 'choosing it closes the menu');
    await page.waitForSelector('.chat-hint:not([hidden])');
    const st = await page.evaluate(() => ({ text: document.querySelector('.chat-input').value, focus: document.activeElement === document.querySelector('.chat-input'), send: !document.querySelector('.chat-send').disabled }));
    ok(/^Render this timeline with ComfyUI/.test(st.text) && st.focus && st.send && (await page.isVisible('.chat')), 'Render with Comfy opens the chat with the request started and a note on what to add');
    await page.click('.tl-exportbtn'); await page.click('.tl-render');
    ok((await page.$eval('.chat-input', (e) => e.value)) === st.text && queued() === before, 'choosing it again does not repeat the text, and nothing is sent');
    await page.fill('.chat-input', '');
    ok(await page.$eval('.chat-hint', (e) => e.hidden), 'clearing the message removes the note');
    if (!wasOpen) await page.click('.chat-toggle');
  }

  // --- question cards: one question at a time, a key block that keeps the key from the agent ---
  {
    const wasOpen = await page.isVisible('.chat');
    if (wasOpen) await page.click('.chat-toggle');
    cli('ask', JSON.stringify({ title: 'Render test', questions: [
      { id: 'look', q: 'What sets the look?', options: [{ value: 'images', label: 'Reference images' }, { value: 'words', label: 'Describe it' }] },
      { id: 'describe', q: 'Describe the look', when: { look: 'words' } },
      { id: 'refs', q: 'Add images', type: 'images', when: { look: 'images' } },
      { id: 'key', q: 'API key', type: 'secret', name: 'E2E_TEST_KEY' },
      { id: 'go', q: 'Ready?', rows: [['Cost', 'about 170 credits']], options: ['Render', 'Not yet'] },
    ] }));
    await page.waitForSelector('.chat-ask');
    ok(await page.isVisible('.chat'), 'a question card opens the chat');
    const step = () => page.$eval('.chat-ask:not(.is-done)', (e) => ({ q: e.querySelector('.chat-ask-q').textContent, n: e.querySelector('.chat-ask-step')?.textContent, opts: e.querySelectorAll('.chat-ask-opts .chat-ask-opt').length }));
    let s1 = await step();
    ok(s1.q === 'What sets the look?' && s1.opts === 2 && /^1 of \d$/.test(s1.n) && (await page.$$('.chat-ask-q')).length === 1, `the card shows one question at a time (${s1.n})`);
    await page.click('.chat-ask-opts .chat-ask-opt >> nth=1');
    s1 = await step();
    ok(s1.q === 'Describe the look' && s1.n === '2 of 4', 'picking an option moves on, and only the follow-up that applies is asked');
    await page.click('.chat-ask-back');
    await page.click('.chat-ask-opts .chat-ask-opt >> nth=0');
    ok((await step()).q === 'Add images' && await page.$eval('.chat-ask-go', (b) => b.disabled), 'Back changes an answer; images need one before Continue');
    const png = path.join(dir, 'ref.png');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    await page.setInputFiles('.chat-ask input[type=file]', [png]);
    await page.waitForSelector('.chat-ask .chat-thumb:not(.is-pending)');
    await page.click('.chat-ask-go');
    const KEY = 'sk-e2e-secret-4242';
    ok((await step()).q === 'API key' && await page.$eval('.chat-ask-key-input', (i) => i.type === 'password'), 'a secret question is a key block with a hidden field');
    await page.fill('.chat-ask-key-input', KEY);
    await page.click('.chat-ask-go');
    await page.waitForFunction(() => document.querySelector('.chat-ask:not(.is-done) .chat-ask-rows'));
    ok((await page.textContent('.chat-ask-rows')).includes('about 170 credits'), 'a confirm step shows its summary rows');
    await page.keyboard.press('1');
    await page.waitForSelector('.chat-ask.is-done');
    const sum = await page.textContent('.chat-ask.is-done');
    ok(/Reference images/.test(sum) && /Saved on this machine/.test(sum) && /Render/.test(sum) && !sum.includes(KEY) && !(await page.$('.chat-msg--user .chat-bubble:has-text("Answers to")')), 'the answered card folds into a summary, with no key and no extra message');
    const got = cli('wait', '--timeout', '5', '--no-listen');
    ok(/Answers to "Render test"/.test(got) && /- refs \(Add images\): \S+ref\.png/.test(got) && /- go \(Ready\?\): Render/.test(got) && /E2E_TEST_KEY is saved on this machine/.test(got) && !got.includes(KEY), 'the answers reach the agent as one prompt, without the key');
    ok(cli('secret', 'run', 'E2E_TEST_KEY', '--', process.execPath, '-e', 'console.log(process.env.E2E_TEST_KEY.length, process.env.E2E_TEST_KEY)').trim() === `${KEY.length} [E2E_TEST_KEY hidden]`, 'canvas secret run hands the key to a command and masks it in the output');
    // a text to review: shown in full, editable in place, feedback sends it back instead of approving
    const promptFile = path.join(dir, 'prompt.txt');
    fs.writeFileSync(promptFile, 'References: @video_1 is the blockout.\n0–1.96s: Half orbit to the left.');
    const askReview = () => cli('ask', JSON.stringify({ title: 'Render test', questions: [{ id: 'prompt', q: 'Check the prompt', file: promptFile }, { id: 'go', q: 'Ready?', options: ['Render', 'Not yet'], when: { prompt: ['approved', 'edited'] } }] }));
    askReview();
    await page.waitForSelector('.chat-ask:not(.is-done) .chat-ask-body');
    const rv = await page.$eval('.chat-ask:not(.is-done)', (e) => ({ body: e.querySelector('.chat-ask-body').value, go: e.querySelector('.chat-ask-go').textContent }));
    ok(rv.body.includes('0–1.96s: Half orbit to the left.') && rv.go === 'Looks good', 'a review step shows the whole text with Looks good');
    await page.fill('.chat-ask:not(.is-done) .chat-ask-body', 'A night street.\n0–1.96s: Half orbit to the left.');
    ok((await page.textContent('.chat-ask:not(.is-done) .chat-ask-go')) === 'Use my edits', 'editing it in place turns the button into Use my edits');
    await page.click('.chat-ask:not(.is-done) .chat-ask-go');
    await page.waitForFunction(() => document.querySelector('.chat-ask:not(.is-done) .chat-ask-q')?.textContent === 'Ready?');
    await page.keyboard.press('1');
    await page.waitForFunction(() => !document.querySelector('.chat-ask:not(.is-done)'));
    const edited = cli('wait', '--timeout', '5', '--no-listen');
    ok(/approved with their edits\. Use exactly this text:\n  \| A night street\./.test(edited) && /- go \(Ready\?\): Render/.test(edited), 'the edited text and the go reach the agent');
    askReview();
    await page.waitForSelector('.chat-ask:not(.is-done) .chat-ask-body');
    await page.fill('.chat-ask:not(.is-done) input.chat-ask-input', 'make it rain');
    ok((await page.textContent('.chat-ask:not(.is-done) .chat-ask-go')) === 'Send feedback', 'writing feedback turns the button into Send feedback');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.chat-ask:not(.is-done)'));
    const fb = cli('wait', '--timeout', '5', '--no-listen');
    ok(/NOT approved\. Feedback: "make it rain"/.test(fb) && !/- go /.test(fb), 'feedback goes back to the agent and the Render step is not offered');
    // a progress card for the job: one card, updated in place, counting the time by itself
    const job = cli('progress', 'Rendering test', '--steps', 'Upload|Queue|Render', '--eta', '120');
    await page.waitForSelector('.chat-prog[data-state="running"]');
    cli('progress', '--id', job, '--step', '3', '--pct', '50');
    await page.waitForFunction(() => /Render · 3 of 3/.test(document.querySelector('.chat-prog-line')?.textContent || ''));
    const t0 = await page.textContent('.chat-prog-time');
    await page.waitForFunction((t) => document.querySelector('.chat-prog-time').textContent !== t, t0, { timeout: 5000 });
    const pg = await page.evaluate(() => ({ n: document.querySelectorAll('.chat-prog').length, w: document.querySelector('.chat-prog-fill').style.width, line: document.querySelector('.chat-prog-line').textContent }));
    ok(pg.n === 1 && pg.w === '50%' && /left|usually/.test(pg.line), `a progress card updates in place and keeps counting (${pg.line})`);
    const held = execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'hook', 'stop'], { env, input: JSON.stringify({ session_id: 'e2e-session', cwd: ROOT }), encoding: 'utf8' });
    ok(JSON.parse(held).decision === 'block' && held.includes(job) && /Rendering test/.test(held), 'Stop hook will not let the session go idle while a job card is running');
    cli('progress', '--id', job, '--done', 'Rendered in 2m');
    await page.waitForSelector('.chat-prog[data-state="done"]');
    cli('say', '--working', 'Running on Comfy Cloud');
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-prog[data-state="running"] .chat-prog-line')].some((l) => l.textContent.includes('Running on Comfy Cloud')));
    const held2 = execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'hook', 'stop'], { env, input: JSON.stringify({ session_id: 'e2e-session', cwd: ROOT }), encoding: 'utf8' });
    ok(JSON.parse(held2).decision === 'block' && /Running on Comfy Cloud/.test(held2), 'a "still working" reply shows as a running card and holds the session until the real reply');
    ok((await page.textContent('.chat-prog-line')) === 'Rendered in 2m' && !(await page.isVisible('.chat-prog-bar')), 'a finished job settles into one line');
    cli('say', 'Rendering now.');
    cli('secret', 'rm', 'E2E_TEST_KEY');
    if (!wasOpen) await page.click('.chat-toggle');
  }

  // --- audio track: load from the CLI, waveform lane, beats, slide, mixed into the export ---
  const wav = path.join(dir, 'Click Track.wav');
  { // 6 s of clicks every 0.5 s (120 bpm), 44.1 kHz mono 16-bit
    const sr = 44100, n = sr * 6, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) { const t = i / sr, u = t % 0.5; b.writeInt16LE(Math.round(20000 * Math.sin(2 * Math.PI * 90 * t) * Math.exp(-30 * u) + 600 * Math.sin(2 * Math.PI * 440 * t)), 44 + i * 2); }
    fs.writeFileSync(wav, b);
  }
  const loaded = cli('audio', wav);
  ok(/audio \(all shots\): Click Track\.wav at 0s.*\(file click-track-[0-9a-f]{8}\.wav/.test(loaded), `canvas audio loads a file (${loaded.split('\n')[0]})`);
  await page.waitForFunction(() => window.canvas.audio.peaks && !document.querySelector('.tl-audio').hidden && document.body.classList.contains('has-audio'));
  ok(true, 'the timeline shows the waveform lane');
  await page.waitForFunction(() => window.canvas.store.doc.audio.length === 6);
  ok(true, 'the tab records the audio length (not as an undo step)');
  const beats = JSON.parse(cli('audio', '--beats', '--json'));
  ok(Math.abs(beats.tempo - 120) < 3 && beats.beats.length >= 7, `beat finder: ${beats.tempo} bpm, beats ${beats.beats.slice(0, 4).join(' ')}…`);
  cli('audio', '--offset', '-0.25');
  ok(cli('ls').includes('audio (all shots): Click Track.wav at -0.25s, 6s long'), 'ls shows the audio track');
  await page.locator('.tl-audiobtn').click();
  ok(await page.locator('.audio-pop').isVisible() && /−0\.25–5\.75 s of the action/.test(await page.locator('.audio-pop .audio-foot').textContent()), 'Audio menu shows where the clip plays in the action');
  await page.screenshot({ path: path.join(dir, 'audio.png') });
  await page.locator('.audio-pop .cc-row:has(.audio-bpm) .cc-toggle').click();
  await page.waitForFunction(() => window.canvas.store.doc.audio.beats === true && /bpm/.test(document.querySelector('.audio-pop .audio-bpm').textContent));
  ok(/^12\d bpm|^11[89] bpm/.test(await page.locator('.audio-pop .audio-bpm').textContent()) && cli('ls').includes('beats shown'), `Beats toggle marks the beat grid (${await page.locator('.audio-pop .audio-bpm').textContent()})`);
  await page.screenshot({ path: path.join(dir, 'audio-beats.png') });
  await page.keyboard.press('Escape');
  // loading a file from the tab turns the beats on and opens the Audio menu
  cli('audio', '--show-beats', 'off');
  await page.waitForFunction(() => !window.canvas.store.doc.audio.beats && !document.querySelector('.audio-pop').checkVisibility());
  await page.locator('input[type=file][accept^="audio"]').setInputFiles(wav);
  await page.waitForFunction(() => window.canvas.store.doc.audio.beats === true && document.querySelector('.audio-pop').checkVisibility() && /bpm/.test(document.querySelector('.audio-pop .audio-bpm').textContent));
  ok(true, `uploading a track shows its beats and opens the Audio menu (${await page.locator('.audio-pop .audio-bpm').textContent()})`);
  await page.screenshot({ path: path.join(dir, 'audio-upload.png') });
  await page.keyboard.press('Escape');
  // slide the audio by dragging the waveform
  const lb = await page.locator('.tl-audio').boundingBox();
  await page.mouse.move(lb.x + lb.width * 0.5, lb.y + lb.height / 2); await page.mouse.down();
  await page.mouse.move(lb.x + lb.width * 0.6, lb.y + lb.height / 2, { steps: 4 }); await page.mouse.up();
  await page.waitForFunction(() => window.canvas.store.doc.audio.offset > -0.25);
  ok(true, `dragging the clip slides the audio (offset ${await page.evaluate(() => window.canvas.store.doc.audio.offset)}s)`);
  cli('undo');
  // trim by dragging the clip's ends
  cli('audio', '--offset', '0.5', '--out', '4');
  await page.waitForFunction(() => window.canvas.store.doc.audio.offset === 0.5 && window.canvas.store.doc.audio.out === 4);
  const laX = async (a) => lb.x + await page.evaluate((a) => window.canvas.timeline.xAction(a), a);
  let hx = await laX(0.5);
  await page.mouse.move(hx, lb.y + lb.height / 2); await page.mouse.down();
  await page.mouse.move(await laX(1.5), lb.y + lb.height / 2, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction(() => window.canvas.store.doc.audio.in > 0.5);
  const tin = await page.evaluate(() => window.canvas.store.doc.audio);
  ok(Math.abs(tin.in - 1) < 0.05 && tin.offset === 0.5, `dragging the clip's start trims it (in ${tin.in}s, offset stays ${tin.offset})`);
  hx = await laX(4.5);
  await page.mouse.move(hx, lb.y + lb.height / 2); await page.mouse.down();
  await page.mouse.move(await laX(3.5), lb.y + lb.height / 2, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction(() => window.canvas.store.doc.audio.out < 4);
  const tout = await page.evaluate(() => window.canvas.store.doc.audio.out);
  ok(Math.abs(tout - 3) < 0.05, `dragging the clip's end trims it (out ${tout}s)`);
  ok(/trimmed to 1–3s of the file, plays 1\.5s–3\.5s of the action/.test(cli('ls')), 'ls shows the trim');
  await page.screenshot({ path: path.join(dir, 'audio-trim.png') });
  // one track for every shot: a new shot plays on from where the first ends
  cli('shot-add');
  await page.waitForFunction(() => window.canvas.store.doc.shots.length === 2 && window.canvas.store.doc.shot !== 'shot-1');
  ok(await page.evaluate(() => !!window.canvas.store.doc.audio && !document.querySelector('.tl-audio').hidden), 'the audio track stays on the timeline in the next shot');
  await page.screenshot({ path: path.join(dir, 'audio-shots.png') });
  { // Play all runs the sound straight through the cut: one scheduled source, no restart at the next shot
    cli('audio', '--offset', '0', '--in', 'none', '--out', 'none');
    await page.waitForFunction(() => window.canvas.store.doc.audio.offset === 0 && !window.canvas.store.doc.audio.out);
    await page.evaluate(() => {
      const P = AudioBufferSourceNode.prototype, start = P.start;
      window.__starts = [];
      P.start = function (...a) { window.__starts.push(a); return start.apply(this, a); };
    });
    await page.evaluate(async () => {
      const { store } = window.canvas;
      await store.op({ op: 'shot.use', id: 'shot-1' }, 'switch shot', { amend: true });
      store.set({ playAll: true, loop: false, time: store.doc.timeline.duration - 0.3 });
      store.set({ playing: true });
    });
    await page.waitForFunction(() => window.canvas.store.doc.shot !== 'shot-1' && window.canvas.store.state.time > 0.2, null, { timeout: 5000 });
    const r = await page.evaluate(() => { const { store } = window.canvas; store.set({ playing: false, playAll: false }); return { starts: window.__starts.length, t: store.state.time }; });
    ok(r.starts === 1, `Play all keeps the audio going across the cut (${r.starts} source start${r.starts === 1 ? '' : 's'}, now ${r.t.toFixed(2)} s into the next shot)`);
  }
  { // Export with two shots: the whole timeline in one mp4, the audio running under the cut for its full length
    const tx = cli('export', '--width', '160', '--height', '90');
    ok(/2 shots/.test(tx) && /audio/.test(tx), `export renders both shots with the audio (${tx.split('\n')[1]})`);
    try {
      const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', tx.split('\n')[0]], { encoding: 'utf8' }).trim().split('\n').map((l) => l.split(','));
      const v = +d.find((x) => x[0] === 'video')[1], a = +d.find((x) => x[0] === 'audio')[1];
      ok(Math.abs(a - v) < 0.1, `the audio lasts as long as the whole cut (video ${v.toFixed(2)} s, audio ${a.toFixed(2)} s)`);
    } catch { console.log('     (ffprobe not available, skipped)'); }
  }
  cli('shot-rm', await page.evaluate(() => window.canvas.store.doc.shot));
  await page.waitForFunction(() => window.canvas.store.doc.shots.length === 1);
  cli('audio', '--offset', '-0.25', '--in', 'none', '--out', 'none');
  cli('audio', '--fit');
  ok(JSON.parse(cli('doc')).timeline.duration === 5.75, 'audio --fit makes the shot end with the audio');
  cli('timeline', '--duration', '4');
  const aexp = cli('export', '--width', '320', '--height', '180');
  const afile = aexp.split('\n')[0];
  ok(/audio/.test(aexp), `export mixes in the audio (${aexp.split('\n')[1]})`);
  try {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'csv=p=0', afile], { encoding: 'utf8' }).trim().split('\n');
    ok(probe.some((l) => /^aac,audio,(3\.9|4\.0)/.test(l)) && probe.some((l) => /^h264,video/.test(l)), `ffprobe: ${probe.join(' | ')}`);
  } catch { console.log('     (ffprobe not available, skipped)'); }
  cli('audio', '--clear');
  await page.waitForFunction(() => document.querySelector('.tl-audio').hidden && !document.body.classList.contains('has-audio'));
  ok(true, 'audio --clear removes the lane');

  // multi-select keys: shift-click a range, ctrl/cmd-click one at a time, drag one to move them all
  cli('clear', '--keys');
  for (const t of [0, 1, 2, 3]) cli('key', '--t', String(t), '--pos', `${t},2,8`, '--target', '0,1,0');
  await page.waitForFunction(() => window.canvas.store.doc.timeline.keys.length === 4);
  await page.evaluate(() => window.canvas.store.set({ key: null, selection: null }));
  const mb = await page.locator('.tl-track').boundingBox();
  const mxs = await page.evaluate(() => [0, 0.5, 1, 1.25, 1.5, 2, 2.5, 2.75, 3].map((t) => [t, window.canvas.timeline.xAt(t)]));
  const mx = (t) => mb.x + new Map(mxs).get(t), my = mb.y + await page.evaluate(() => window.canvas.timeline.yAt());
  const kt = () => JSON.parse(cli('doc')).timeline.keys.map((k) => k.t).sort((a, b) => a - b);
  await page.mouse.click(mx(0), my); await page.waitForTimeout(80);
  await page.keyboard.down('Shift'); await page.mouse.click(mx(2), my); await page.keyboard.up('Shift');
  await page.waitForTimeout(80);
  ok(/3 keys/.test(await page.locator('.tl-keytime').textContent()), 'shift-click selects every key in the range');
  await page.mouse.move(mx(1), my); await page.mouse.down(); await page.mouse.move(mx(1.25), my, { steps: 4 }); await page.mouse.move(mx(1.5), my, { steps: 4 }); await page.mouse.up();
  await page.waitForFunction(() => window.canvas.store.doc.timeline.keys.some((k) => Math.abs(k.t - 0.5) < 1e-3));
  ok(JSON.stringify(kt()) === JSON.stringify([0.5, 1.5, 2.5, 3]), `dragging one selected key moves the whole range (${kt()})`);
  cli('undo');
  ok(JSON.stringify(kt()) === JSON.stringify([0, 1, 2, 3]), 'one undo puts the range back');
  await page.waitForTimeout(150);
  await page.mouse.click(mx(1), my); await page.waitForTimeout(80);
  await page.keyboard.down('Control'); await page.mouse.click(mx(3), my); await page.keyboard.up('Control');
  await page.waitForTimeout(80);
  ok(/2 keys/.test(await page.locator('.tl-keytime').textContent()), 'ctrl-click adds one key to the selection');
  await page.mouse.move(mx(3), my); await page.mouse.down(); await page.mouse.move(mx(2.75), my, { steps: 4 }); await page.mouse.move(mx(2.5), my, { steps: 4 }); await page.mouse.up();
  await page.waitForFunction(() => window.canvas.store.doc.timeline.keys.some((k) => Math.abs(k.t - 0.5) < 1e-3));
  ok(JSON.stringify(kt()) === JSON.stringify([0, 0.5, 2, 2.5]), `only the ctrl-picked keys move (${kt()})`);
  await page.keyboard.press('Backspace'); await page.waitForTimeout(200);
  ok(JSON.stringify(kt()) === JSON.stringify([0, 2]), 'Backspace deletes every selected key');

  // shots: a second camera on the same set, switched from the bar, exported one by one and as a sequence
  cli('timeline', '--duration', '1', '--fps', '12');
  ok(/added shot close/.test(cli('shot-add', '--name', 'close')), 'shot-add makes a second shot and switches to it');
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'close');
  const tr = await page.locator('.tl-track').boundingBox();
  ok(tr.height > 80, `with two shots the key track stacks them (${Math.round(tr.height)} px tall)`);
  const xA = async (a) => tr.x + await page.evaluate((a) => window.canvas.timeline.xAction(a), a);
  // lanes: ruler 18 px, then shot-1 (24 px), then the active close (40 px); names in a 96 px header column
  await page.mouse.click(await xA(0.5), tr.y + 26);
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'shot-1');
  ok(true, 'clicking another shot\'s row switches to it');
  // the ruler is scrubbable across shots: close picks up the action at 1 s, so 1.5 s in is close at 0.5 s
  await page.mouse.click(await xA(1.5), tr.y + 8);
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'close' && Math.abs(window.canvas.store.state.time - 0.5) < 0.1);
  ok(true, 'clicking the ruler at a moment another shot covers switches to it there');
  // and so is the empty part of the active row (close is active, lane 2: 18 + 24); 0.25 s in is shot-1
  await page.mouse.click(await xA(0.5), tr.y + 18 + 24 + 30);
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'shot-1');
  ok(true, 'clicking the empty part of the active row switches to the shot that covers that moment');
  // now close is the inactive second row (top 18 + 40): drag it sideways so it picks up the action later
  ok(JSON.parse(cli('doc')).shots.find((x) => x.id === 'close').timeline.start === 1, 'the new shot picks up the action where the first one ends');
  cli('shot-set', 'close', '--start', '0');
  await page.waitForFunction(() => !window.canvas.store.doc.shots.find((x) => x.id === 'close').timeline.start);
  const ry = tr.y + 18 + 40 + 12;
  await page.mouse.move(await xA(0.4), ry); await page.mouse.down();
  await page.mouse.move(await xA(0.9), ry, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => (window.canvas.store.doc.shots.find((x) => x.id === 'close').timeline.start || 0) > 0.1);
  ok(true, `dragging a shot's row sets where it picks up the action`);
  await page.waitForTimeout(200);
  cli('shot', 'close');
  cli('shot-set', 'close', '--start', '0');
  cli('key-set', '0', '--pos', '2,1.5,3', '--target', '0,1,0');
  cli('timeline', '--shot', 'shot-1', '--duration', '0.5');
  await page.keyboard.press('BracketLeft');
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'shot-1');
  ok(JSON.parse(cli('doc')).timeline.duration === 0.5, '[ switches to the previous shot and --shot edited it in place');
  // Play all runs on through the cut into the next shot
  await page.evaluate(() => window.canvas.store.set({ playAll: true, loop: false }));
  cli('shot', '1');
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'shot-1');
  await page.evaluate(() => window.canvas.store.set({ time: 0.4, playing: true }));
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'close', null, { timeout: 5000 });
  ok(true, 'Play all carries playback into the next shot');
  await page.evaluate(() => window.canvas.store.set({ playing: false, playAll: false, loop: true }));
  const sq = cli('export', '--width', '160', '--height', '90');
  ok(/2 shots \(shot-1 6f, close 12f\), 18 frames/.test(sq) && !/-shot-1-|-close-/.test(sq.split('\n')[0]), `export renders the whole timeline, every shot cut together (${sq.split('\n')[1]})`);
  ok(/2 shots/.test(cli('export', '--sequence', '--width', '160', '--height', '90')), 'export --sequence still works');
  const one = cli('export', '--shot', 'shot-1', '--width', '160', '--height', '90');
  ok(/-shot-1-.*\.mp4/.test(one.split('\n')[0]) && /6 frames/.test(one), 'export --shot renders just that shot');
  // reorder by dragging the active shot's name (header column) up a lane, then pick the other shot and press Delete
  cli('shot', 'close');
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'close');
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  await page.mouse.move(tr.x + 40, tr.y + 18 + 24 + 20); await page.mouse.down();
  await page.mouse.move(tr.x + 40, tr.y + 30, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => window.canvas.store.doc.shots[0].id === 'close');
  ok(true, 'dragging a shot up a lane moves it earlier in the sequence');
  await page.mouse.click(tr.x + 40, tr.y + 18 + 40 + 12);
  await page.waitForFunction(() => window.canvas.store.doc.shot === 'shot-1');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => window.canvas.store.doc.shots.length === 1);
  ok(true, 'clicking a shot and pressing Backspace deletes it');
  cli('undo');
  await page.waitForFunction(() => window.canvas.store.doc.shots.length === 2);
  cli('shot-rm', 'shot-1');
  ok(JSON.parse(cli('doc')).shots.length === 1, 'shot-rm deletes a shot');

  // --- camera moves: the Moves popover applies a preset as two keys with a path ---
  await page.evaluate(() => window.canvas.store.set({ time: 0, selection: null, key: null }));
  await page.getByRole('button', { name: 'Moves' }).click();
  await page.locator('.moves-pop .moves-tile', { hasText: 'Orbit' }).click();
  await page.locator('.moves-pop button', { hasText: 'Apply' }).click();
  await page.waitForFunction(() => window.canvas.store.doc.timeline.keys.some((k) => k.path?.type === 'orbit'));
  ok(/→ orbit 90°/.test(cli('ls')), 'the Moves popover keys an orbit from the playhead');
  ok(await page.locator('.tl-path').inputValue() === 'orbit', 'the selected key shows its path');
  // editing: the selected key starts a move, so the menu shows its settings and Update redoes it
  await page.locator('.moves-pop .moves-new').waitFor();
  ok((await page.locator('.moves-pop .moves-title').textContent()).startsWith('Edit orbit'), 'the Moves menu opens on the selected move');
  const ang = page.locator('.moves-pop .cc-affix:visible input').first();
  await ang.click(); await ang.fill('180'); await ang.press('Enter');
  await page.locator('.moves-pop button', { hasText: 'Update' }).click();
  await page.waitForFunction(() => window.canvas.store.doc.timeline.keys.some((k) => k.path?.params?.angle === 180));
  ok(/→ orbit 180°/.test(cli('ls')), 'Update changes the move in place');
  await page.keyboard.press('Escape');
  await page.locator('.tl-path').selectOption('smooth');
  await page.waitForFunction(() => !window.canvas.store.doc.timeline.keys.some((k) => k.path));
  ok(true, 'the path select turns the move back into a smooth segment');
  ok(/dollyZoom from 0s to 2s/.test(cli('cam', 'dolly-zoom', '--t', '0', '--over', '2', '--by', '1')), 'canvas cam keys a dolly zoom');

  // --- ease curve editor: click the curve to add a point, drag it, double-click it to remove it ---
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const s = window.canvas.store; const k = [...s.doc.timeline.keys].sort((a, b) => a.t - b.t)[0]; s.set({ key: k.id }); });
  cli('key-set', '0', '--ease', 'easeInOut');
  await page.waitForFunction(() => [...window.canvas.store.doc.timeline.keys].sort((a, b) => a.t - b.t)[0].ease === 'easeInOut');
  await page.locator('.tl-key .tl-ease').click();
  const cbox = await page.locator('.curve-canvas').boundingBox();
  // find a spot on the curve (the cursor turns to "copy") and on a point ("grab"), scanning one column
  const scan = (px, want) => page.evaluate(([px, top, want]) => {
    const cv = document.querySelector('.curve-canvas');
    for (let y = top + 6; y < top + 130; y++) { cv.dispatchEvent(new PointerEvent('pointermove', { clientX: px, clientY: y, bubbles: true })); if (cv.style.cursor === want) return y; }
    return null;
  }, [px, cbox.y, want]);
  const ex = cbox.x + 18 + 0.5 * (cbox.width - 28);
  const ey = await scan(ex, 'copy');
  ok(ey != null, 'the curve shows it can take a point');
  await page.mouse.move(ex, ey); await page.mouse.down(); await page.mouse.move(ex - 15, ey - 25, { steps: 4 }); await page.mouse.up();
  const ease0 = () => page.evaluate(() => [...window.canvas.store.doc.timeline.keys].sort((a, b) => a.t - b.t)[0].ease);
  await page.waitForFunction(() => { const e = [...window.canvas.store.doc.timeline.keys].sort((a, b) => a.t - b.t)[0].ease; return Array.isArray(e) && e.length === 10; });
  const added = await ease0();
  ok(added[4] < 0.5 && added[5] > 0.5, 'clicking the curve adds a point and drags it');
  ok(/custom · 1 point/.test(await page.locator('.curve-name').textContent()), 'the editor names the points');
  const px = cbox.x + 18 + added[4] * (cbox.width - 28);
  const py = await scan(px, 'grab');
  await page.mouse.dblclick(px, py + 3);
  await page.waitForFunction(() => { const e = [...window.canvas.store.doc.timeline.keys].sort((a, b) => a.t - b.t)[0].ease; return !Array.isArray(e) || e.length === 4; });
  ok(true, 'double-clicking a point removes it');
  // copy this segment (curve + shudder), paste onto the next one; Apply to all asks first; a click away closes it
  cli('key-set', '0', '--ease', 'snap', '--shudder', '5,3', '--shape', 'wobble');
  await page.waitForFunction(() => !!window.canvas.store.doc.timeline.keys.find((k) => k.shudder));
  await page.locator('.curve-pop__head button[title^="Copy"]').click();
  const k1 = await page.evaluate(() => { const ks = [...window.canvas.store.doc.timeline.keys].sort((a, b) => a.t - b.t); return ks.length > 2 ? ks[1].id : null; });
  if (k1) {
    await page.evaluate((id) => window.canvas.store.set({ key: id }), k1);
    await page.waitForTimeout(100);
    ok(await page.locator('.curve-pop').isVisible(), 'picking another segment keeps the editor open');
    await page.locator('.curve-pop__head button[title^="Paste"]').click();
    await page.waitForFunction((id) => { const k = window.canvas.store.doc.timeline.keys.find((x) => x.id === id); return k.ease === 'snap' && k.shudder?.jerks === 5 && k.shudder.shape === 'wobble'; }, k1);
    ok(true, 'paste copies the curve and the shudder onto another segment');
  }
  // the timing strip: drag its right edge in to end the shudder earlier
  {
    const r = await page.locator('.curve-range').boundingBox();
    await page.mouse.move(r.x + r.width - 2, r.y + r.height / 2); await page.mouse.down();
    await page.mouse.move(r.x + r.width * 0.6, r.y + r.height / 2, { steps: 4 }); await page.mouse.up();
    await page.waitForFunction(() => { const s = window.canvas.store, k = s.doc.timeline.keys.find((x) => x.id === s.state.key); return k?.shudder && k.shudder.to < 0.7 && k.shudder.to > 0.5; });
    ok(true, 'dragging the timing strip\'s edge sets where the shudder ends');
  }
  const allVisible = await page.locator('.curve-all').isVisible();
  if (allVisible && !(await page.locator('.curve-all').isDisabled())) {
    const before = JSON.stringify(JSON.parse(cli('doc')).timeline.keys.map((k) => k.ease));
    await page.locator('.curve-all').click();
    ok(await page.locator('.curve-confirm').isVisible() && JSON.stringify(JSON.parse(cli('doc')).timeline.keys.map((k) => k.ease)) === before, 'Apply to all asks before changing anything');
    await page.locator('.curve-confirm button', { hasText: 'Cancel' }).click();
    ok(!(await page.locator('.curve-confirm').isVisible()), 'Cancel leaves the segments alone');
  }
  cli('key-set', '0', '--ease', 'easeInOut', '--shudder', 'off');
  if (k1) cli('key-set', k1, '--ease', 'easeInOut', '--shudder', 'off');
  ok(await page.locator('.curve-tip').evaluate((el) => /orange handles/.test(el.textContent)), 'the help text lives in the header tooltip');
  await page.mouse.click(5, 300);
  await page.waitForTimeout(100);
  ok(!(await page.locator('.curve-pop').isVisible()), 'a click away closes the curve editor');
  // --- toolbar: the key card, Key's caret, the object chip, Loop in the shot popover ---
  await page.evaluate(() => { const s = window.canvas.store; s.set({ key: null, selection: null }); });
  await page.waitForTimeout(150);
  const barIn = (sel) => page.evaluate((sel) => !!document.querySelector(`.tl-bar ${sel}`), sel);
  ok(!(await barIn('.tl-key')) && await barIn('.tl-keycaret') && (await page.$$('.tl-bar .cc-affix')).length === 2, 'the bar has lens, roll and Key\'s caret, not the key settings');
  const kA = JSON.parse(cli('doc')).timeline.keys[0].id;
  await page.evaluate((id) => window.canvas.store.set({ key: id }), kA);
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => !document.querySelector('.tl-keycard').hidden && !!document.querySelector('.tl-keycard .tl-ease')), 'a selected key opens its card above the timeline');
  await page.evaluate(() => window.canvas.store.set({ key: null }));
  await page.click('.tl-keycaret');
  ok(await page.evaluate(() => !document.querySelector('.moves-pop').hidden), 'Key\'s caret opens the Moves menu');
  await page.keyboard.press('Escape');
  cli('add', 'box', '--name', 'chip');
  await page.evaluate(() => window.canvas.store.set({ selection: 'chip' }));
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => !!document.querySelector('.sel-box .tl-objkey:not([hidden])')), 'the object chip carries its Key button');
  await page.hover('.tl-bar > .cc-btn:first-child');
  await page.waitForTimeout(100);
  ok(await page.evaluate(() => !document.querySelector('.tl-playmenu').hidden), 'hovering Play shows Loop and Play all');
  const loop0 = await page.evaluate(() => window.canvas.store.state.loop);
  await page.hover('.tl-playmenu .tl-playrow-label');
  await page.click('.tl-playmenu .tl-playrow-label');
  ok(await page.evaluate((l) => window.canvas.store.state.loop === !l, loop0), 'the menu stays open on the way there and toggles Loop');
  await page.click('.tl-playmenu .tl-playrow-label');
  await page.mouse.move(700, 300);
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => document.querySelector('.tl-playmenu').hidden), 'it closes when the pointer leaves');
  cli('rm', 'chip');

  // --- drop a .glb: on the canvas it is added where the camera is focused; in the chat it goes with the message ---
  const glb = Array.from(boxGlb());
  const dropGlb = (sel, name) => page.evaluate(({ sel, name, bytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'model/gltf-binary' }));
    const el = document.querySelector(sel), r = el.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, dataTransfer: dt };
    el.dispatchEvent(new DragEvent('dragover', at));
    el.dispatchEvent(new DragEvent('drop', at));
  }, { sel, name, bytes: glb });
  await page.evaluate(() => { window.canvas.store.set({ view: 'free' }); const v = window.canvas.viewport; v.freeOrbit.target.set(6, 1.2, -4); v.freeOrbit.update(); });
  const n0 = await page.evaluate(() => window.canvas.store.doc.objects.length);
  await dropGlb('#stage canvas', 'Crate Box.glb');
  await page.waitForFunction((n) => window.canvas.store.doc.objects.length === n + 1, n0, { timeout: 5000 }).catch(() => {});
  const crate = await page.evaluate(() => window.canvas.store.doc.objects.find((o) => o.type === 'model'));
  ok(crate && crate.name === 'crate-box' && crate.position.join() === '6,0,-4' && crate.params.h === 1, `a .glb dropped on the canvas is added at the camera's focus, on the ground (${crate && crate.position})`);
  ok(await page.evaluate(() => window.canvas.store.state.selection) === crate?.id, 'and selected');
  await page.evaluate(() => window.canvas.store.set({ selection: null }));
  await page.evaluate(() => { const v = window.canvas.viewport; v.freeOrbit.target.set(0, 1, 0); v.freeOrbit.update(); });
  if (await page.evaluate(() => document.querySelector('.chat').hidden)) await page.click('.chat-toggle');
  await dropGlb('.chat', 'Chair.glb');
  await page.waitForSelector('.chat-tray .chat-thumb--model:not(.is-pending)', { timeout: 5000 }).catch(() => {});
  ok(await page.$eval('.chat-tray .chat-thumb--model .chat-thumb-name', (e) => e.textContent).catch(() => '') === 'Chair', 'a .glb dropped in the chat shows as a chip in the composer');
  ok(await page.evaluate((n) => window.canvas.store.doc.objects.length === n + 1, n0), 'and is not added to the scene');
  await page.fill('.chat-input', 'use this chair');
  await page.click('.chat-send');
  const gotGlb = await cliAsync('wait', '--timeout', '5');
  ok(/use this chair/.test(gotGlb) && /GLB models attached, NOT in the scene yet .*Chair\.glb → .*models\/chair-[0-9a-f]{8}\.glb/.test(gotGlb), 'the agent gets the model\'s path with the message');
  ok(await page.$eval('.chat-msg .chat-model-chip', (e) => e.textContent).catch(() => '') === 'Chair.glb', 'the sent message shows the model');
  cli('say', 'ok');
  cli('rm', crate?.id || 'crate-box');
  ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
