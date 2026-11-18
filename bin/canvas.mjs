#!/usr/bin/env node
// canvas: the agent's command line for Blockout.
// Every command talks to the bridge server over HTTP (default http://127.0.0.1:5317).
// Run `canvas help` for the reference.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRIMITIVES, createDoc, shotTimeline } from '../core/doc.js';
import { EASES, lensToFov } from '../core/curves.js';
import { dataDir } from '../server/paths.mjs';

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`error: Blockout needs Node 20 or newer (this is ${process.version}). Install it from https://nodejs.org and try again.`);
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.CANVAS_URL || `http://127.0.0.1:${process.env.CANVAS_PORT || 5317}`).replace(/\/$/, '');

const HELP = `canvas — drive the Blockout scene

Server
  canvas up [--scene path] [--no-open]     start the server in the background (if needed) and open the tab
  canvas serve [--port 5317] [--scene path] run the server in the foreground
  canvas open                               open the canvas in the default browser
  canvas status                             server, tab and agent-listening state
  canvas down                               stop a server started with "up"

Read the scene
  canvas ls [--prefix p]                    one line per object and camera key (start here); --prefix: only ids starting p
  canvas doc                                the full scene JSON

Objects (meters, Y up, pivot at bottom centre, rotation in degrees)
  canvas add <type> [--name n] [--pos x,y,z] [--rot x,y,z] [--scale s|x,y,z]
                    [--size a,b,c] [--<param> v] [--color #rrggbb] [--note text]
  canvas set <id> [same flags as add] [--move dx,dy,dz] [--type t]
  canvas dup <id> [--offset x,y,z] [--name n]
  canvas rm <id> [id...]
  canvas add model <file.glb> [--h 4.5] [--pos x,y,z] [--name n]
                                            import a .glb (copied into the scene's models/, drawn in clay);
                                            prints its size as authored. --h: scale it to that height (m)
  canvas set <id> --file <file.glb>         swap a model's file
  canvas models                             model files in the scene's models/ with their sizes
  canvas new                                start a new, empty scene (undoable)
  canvas clear [--keys]                     remove all objects (and camera keys)
  canvas env [--background #hex] [--ground on|off] [--grid on|off] [--fog 0.02] [--sun x,y,z] [--people high|low]
  canvas meta [--name n] [--width 1280] [--height 720]
  types: ${Object.entries(PRIMITIVES).map(([k, v]) => `${k}(${Object.keys(v.params).join(',')})`).join(' ')}

Moving objects (keys on the shot timeline; straight-line moves with an ease, objects hold before/after)
  canvas move <id> [--to x,y,z | --by dx,dy,dz] [--rot x,y,z | --turn dx,dy,dz] [--scale s|x,y,z]
                   [--at 0] [--over 1] [--ease name]   move from where it is at --at, over --over seconds
                                                        (e.g. canvas move hero --to 0,0,-3 --at 1 --over 3)
  canvas okey <id> --t 2 [--pos x,y,z] [--rot x,y,z] [--scale ..] [--ease name]   key an object at a time
  canvas okey-rm <id> [--t 2]               remove one object key (or, without --t, all of its animation)

Shots (one set, several cameras: objects and their moves are shared, each shot has its own camera
timeline, length, fps and audio; camera, timeline and render commands work on the active shot)
  canvas shots                              list the shots in sequence order (* = active)
  canvas shot <id|name|n>                   switch to a shot (the user's timeline follows)
  canvas shot-add [--name n] [--from id] [--blank] [--stay] [--start s] [--length s] [--frame]
                                            new shot after the current one, copying its camera (or --from
                                            another shot; --blank: a fresh two-key move), then switch to it.
                                            It picks up the action where the current shot ends (--start 0:
                                            from the beginning, for coverage of the same moment). --frame:
                                            one key, the copied shot's framing at that moment (what the
                                            canvas's "+ New shot" row does); --length: its duration
  canvas shot-cut <seconds> [--name n] [--stay]          cut the active shot there: the rest becomes a new shot
  canvas shot-set [id] [--name n] [--to n] [--start s]   rename, move to position n in the sequence, or set
                                            where the shot picks up the action (s seconds into the object moves)
  canvas shot-rm <id>                       delete a shot (not the last one)
  --shot <id>   on key, key-set, key-rm, keys-clear, ease-all, timeline, audio, move, okey, okey-rm,
                snapshot, storyboard and export: work on that shot without switching to it

Camera timeline
  canvas key --t 2 --pos x,y,z --target x,y,z [--fov 40 | --lens 35] [--roll 0] [--ease name|x1,y1,x2,y2]
  canvas key --t 2 --from-view              key the camera the user is looking through right now
  canvas key-set <keyId|index> [same flags] change a key (e.g. --ease snap, --t 3)
  canvas ease-all <name|x1,y1,x2,y2>        give every camera segment that ease (cuts stay cuts; --from <keyId> copies a key's)
  canvas key-rm <keyId|index>
  canvas keys-clear
  canvas timeline [--duration 6 [--retime]] [--fps 24] [--interp smooth|linear]
                  [--speed name|x1,y1,x2,y2] [--ease name] [--start s]   (--ease sets every segment;
                  --start: where this shot picks up the shared action, like shot-set --start)
  canvas audio [file] [--offset s] [--volume 1] [--mute on|off] [--fit]
                  load a music / dialogue track onto the timeline (mixed into the export). --offset: where
                  the audio starts on the timeline (negative skips into it); --fit: shot length = audio
  canvas audio --beats [--json]             tempo and onset times inside the shot (needs the tab), to key/cut on
  canvas audio --clear                      remove the audio track
  canvas seek <seconds> | play | pause | view shot|free | select <id|none> | frame [id]
  eases: ${Object.keys(EASES).join(' ')}

Render (needs the canvas tab open)
  canvas snapshot [--t 2] [--view shot|free] [--out file.png]   PNG of one frame; prints its path
          [--from x,y,z --target x,y,z [--lens 35]]           ...or from a camera of your own (the user's view is untouched)
  canvas storyboard [--frames 8] [--cols 4]                     contact sheet across the shot
  canvas export [--fps 24] [--width 1280 --height 720] [--grid on|off] [--name shot]
                                                                 blockout video (mp4) of the active shot; prints its path
  canvas export --sequence [same flags]                          every shot in order, cut together in one mp4

Prompts from the canvas
  canvas wait [--timeout 600] [--json]      block until the user types a prompt in the canvas; prints it.
                                            Marks earlier prompts done and turns listen mode on.
  canvas inbox                              list recent prompts and their status
  canvas chats [id] [--json]                past chats (archived by "New chat"), newest first; with an id,
                                            that chat's transcript
  canvas say "text" [--reply <promptId>] [--working]   message shown in the canvas
  canvas listen on|off                      keep a Claude Code session waiting for canvas prompts (Stop hook)

Save and load (scenes/saved/<name>.json)
  canvas save [name] [--overwrite]           save a named copy of the scene (default name: scene-<date>-<time>)
  canvas load <name>                         replace the scene with a save (undo brings the old one back)
  canvas saves                               list saves, newest first

Raw / batch
  canvas op '<json op or [ops]>'            e.g. canvas op '{"op":"add","type":"box","w":2}'
  canvas ops <file.json> [--scope prefix]   apply an array of ops atomically; --scope refuses any op that
                                            touches an object outside that id prefix, or the camera/timeline
  canvas undo | redo
`;

// ---------- helpers ----------
// Flags that never take a value, so `say --working "text"` keeps "text" as the message.
const BOOLEAN_FLAGS = new Set(['working', 'json', 'retime', 'keys', 'from-view', 'open', 'no-open', 'help', 'overwrite', 'fit', 'clear', 'beats', 'sequence', 'blank', 'stay']);

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq > 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
      else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--') || BOOLEAN_FLAGS.has(key)) val = true;
        else { val = next; i++; }
      }
      if (key.startsWith('no-') && val === true) { key = key.slice(3); val = false; }
      flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

const num = (v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`); return n; };
const vec = (v, n = 3) => {
  if (v === true) throw new Error('missing value');
  const parts = String(v).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 1 && n === 3) return num(parts[0]);
  return parts.map(num);
};
const bool = (v) => v === true || ['on', 'true', '1', 'yes'].includes(String(v).toLowerCase());
const easeArg = (v) => (/^[a-z]/i.test(String(v)) ? String(v) : vec(v, 4));

async function api(method, route, body, { quietFail = false } = {}) {
  let res;
  try {
    res = await fetch(BASE + route, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (quietFail) return null;
    throw new Error(`canvas server is not running at ${BASE}. Start it with: node ${path.relative(process.cwd(), path.join(ROOT, 'bin', 'canvas.mjs')) || 'bin/canvas.mjs'} up`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    if (quietFail) return null;
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

// --shot <id> on a camera/timeline/render command: aim it at that shot without switching the user's view.
let SHOT = null;
const op = (ops, label) => api('POST', '/api/op', { ops: SHOT ? [].concat(ops).map((o) => ({ ...o, shot: SHOT })) : ops, label, source: 'agent' });
const shotLine = (s, i) => `${s.active ? '*' : ' '} ${i + 1} ${s.id}${s.name !== s.id ? ` "${s.name}"` : ''}: ${s.duration}s @ ${s.fps}fps, ${s.keys} camera key${s.keys === 1 ? '' : 's'}${s.start ? `, action from ${s.start}s` : ''}${s.audio ? `, audio ${s.audio}` : ''}`;
const rpc = (method, params = {}, timeout) => api('POST', '/api/rpc', { method, params, timeout }).then((d) => d.result);
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

// A local .glb given to "add model" / "set --file": upload it into the scene's models/ and use the stored name.
// A bare name that is not a local file is taken as one already in models/ (see "canvas models").
async function uploadModel(flags) {
  if (flags.file == null || flags.file === true) throw new Error('usage: canvas add model <file.glb> [--h height] [--pos x,y,z]');
  const local = path.resolve(String(flags.file));
  if (!fs.existsSync(local)) {
    const { models, dir } = await api('GET', '/api/models');
    const m = models.find((x) => x.file === String(flags.file));
    if (!m) throw new Error(`no such file: ${flags.file} (not a local file, nor a model in ${dir}; canvas models lists those)`);
    return m.size ? { compressed: [], ...m } : null;
  }
  const res = await fetch(`${BASE}/api/model?name=${encodeURIComponent(path.basename(local))}`, { method: 'POST', body: fs.readFileSync(local) })
    .catch(() => { throw new Error(`canvas server is not running at ${BASE}`); });
  const up = await res.json();
  if (!up.ok) throw new Error(up.error);
  flags.file = up.file;
  return up;
}
const modelLine = (m, h) => {
  if (!m.size) return `model ${m.file}: no geometry found`;
  const f = (v) => v.map((x) => +x.toFixed(2)).join(' × ');
  const k = h != null && h !== true ? num(h) / m.size[1] : 1;
  const warn = m.size[1] > 200 || m.size[1] < 0.02 ? ' (probably not in metres: set --h to the real height)' : '';
  return `model ${m.file}: ${f(m.size)} m as authored (w × h × d)${k !== 1 ? `, drawn ${f(m.size.map((v) => v * k))} m` : warn}, ${m.triangles} triangles${m.compressed.length ? `, ${m.compressed.join(' + ')}` : ''}`;
};

function objectFields(flags, type) {
  const o = {};
  if (flags.name != null) o.name = String(flags.name);
  if (flags.id != null) o.id = String(flags.id);
  if (flags.pos != null) o.position = vec(flags.pos);
  if (flags.position != null) o.position = vec(flags.position);
  if (flags.rot != null) o.rotation = vec(flags.rot);
  if (flags.rotation != null) o.rotation = vec(flags.rotation);
  if (flags.scale != null) o.scale = vec(flags.scale);
  if (flags.move != null) o.move = vec(flags.move);
  if (flags.color != null) o.color = String(flags.color);
  if (flags.note != null) o.note = String(flags.note);
  if (flags.size != null) { const s = vec(flags.size); o.size = Array.isArray(s) ? s : [s]; }
  if (flags.type != null && flags.type !== true) o.type = String(flags.type);
  const known = new Set(['name', 'id', 'pos', 'position', 'rot', 'rotation', 'scale', 'move', 'color', 'note', 'size', 'type']);
  for (const [k, v] of Object.entries(flags)) {
    if (known.has(k)) continue;
    const allParams = new Set(Object.values(PRIMITIVES).flatMap((p) => Object.keys(p.params)));
    if (!allParams.has(k)) throw new Error(`unknown flag --${k}`);
    const isText = Object.values(PRIMITIVES).some((p) => p.choices?.[k] || p.text?.includes(k));
    o[k] = v === 'null' ? null : isText ? String(v) : num(v);
  }
  if (type && o.position == null) o.position = [0, 0, 0];
  return o;
}

function keyFields(flags) {
  const k = {};
  if (flags.t != null) k.t = num(flags.t);
  if (flags.pos != null) k.position = vec(flags.pos);
  if (flags.position != null) k.position = vec(flags.position);
  if (flags.target != null) k.target = vec(flags.target);
  if (flags.fov != null) k.fov = num(flags.fov);
  if (flags.lens != null) k.fov = (360 / Math.PI) * Math.atan(12 / num(flags.lens));
  if (flags.roll != null) k.roll = num(flags.roll);
  if (flags.ease != null) k.ease = easeArg(flags.ease);
  for (const f of ['position', 'target']) if (typeof k[f] === 'number') throw new Error(`--${f === 'position' ? 'pos' : f} needs x,y,z`);
  return k;
}
const keyRef = (s) => (/^\d+$/.test(s) ? { index: Number(s) } : { id: s });

function formatPrompt(p) {
  const c = p.context || {};
  const lines = [`[canvas prompt ${p.id}] ${p.text || '(no text, see the attached images)'}`];
  if (p.images?.length) lines.push(`images attached (open each with your Read tool): ${p.images.map((i) => i.path).join(' | ')}`);
  if (c.selection?.length) lines.push(`selected: ${c.selection.join(' | ')}`);
  if (c.time != null) lines.push(`${c.shot ? `shot: ${c.shot}, ` : ''}playhead: ${Number(c.time).toFixed(2)}s of ${c.duration}s, view: ${c.view}${c.key ? `, key: ${c.key}` : ''}`);
  if (c.camera) lines.push(`camera: pos=${c.camera.position.map((v) => +v.toFixed(2)).join(',')} target=${c.camera.target.map((v) => +v.toFixed(2)).join(',')} fov=${+c.camera.fov.toFixed(1)}`);
  lines.push(`→ do it with canvas commands, then: canvas say --reply ${p.id} "<one line on what changed>"`);
  lines.push('→ then run "canvas wait" again so the next canvas prompt reaches you (until the user says stop).');
  return lines.join('\n');
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch {}
}

// Listen mode is owned by the agent session that turned it on, so a Stop hook installed for every Claude Code
// session (the plugin) never holds an unrelated session open or hands it canvas prompts.
const listenOwner = () => ({ session: process.env.CLAUDE_CODE_SESSION_ID || null, cwd: process.cwd() });
function ownsCanvas(st, input) {
  if (st.listen && st.listenSession) return input.session_id === st.listenSession;
  if (st.listen && st.listenCwd) return !!input.cwd && path.resolve(input.cwd) === path.resolve(st.listenCwd);
  // Nobody is listening yet: only sessions started inside a Blockout checkout pick up queued prompts.
  return !!input.cwd && (path.resolve(input.cwd) + path.sep).startsWith(ROOT + path.sep);
}
// Two copies of the hooks can run for one session (the plugin's and a checkout's .claude/settings.json):
// the first one to start takes a lock and the other steps aside.
function hookLock(name) {
  const file = path.join(os.tmpdir(), `camera-canvas-${name.replace(/[^\w.-]/g, '_')}.lock`);
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); break; }
    catch {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (alive) return null;
      fs.rmSync(file, { force: true });
    }
  }
  const release = () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file); } catch {} };
  process.on('exit', release);
  return release;
}

const runDir = () => path.join(dataDir(), '.canvas');

// A helper agent building one part of the scene passes --scope <prefix>: every object it adds is named with
// that prefix and it can only change its own objects, never the camera, timeline, env or the whole scene.
function checkScope(ops, prefix) {
  const ok = (id) => typeof id === 'string' && id.startsWith(prefix);
  const OBJ = new Set(['add', 'update', 'remove', 'duplicate', 'anim.key', 'anim.move', 'anim.remove']);
  ops.forEach((o, i) => {
    const where = `op ${i} (${o?.op})`;
    if (o?.op === 'batch') return checkScope(o.ops || [], prefix);
    if (!OBJ.has(o?.op)) throw new Error(`${where}: outside scope "${prefix}" (helpers may only add/change their own objects)`);
    if (o.op === 'add') { if (!ok(o.id ?? o.name)) throw new Error(`${where}: name it "${prefix}…" (got ${JSON.stringify(o.id ?? o.name)})`); return; }
    if (o.op === 'duplicate' && !ok(o.newId ?? o.name)) throw new Error(`${where}: name the copy "${prefix}…"`);
    for (const id of [].concat(o.ids ?? o.id)) if (!ok(id)) throw new Error(`${where}: "${id}" is not one of yours (scope "${prefix}")`);
  });
}

// ---------- commands ----------
const commands = {
  help: () => out(HELP),

  async serve({ flags }) {
    const { startServer } = await import('../server/index.mjs');
    await startServer({ port: Number(flags.port) || Number(process.env.CANVAS_PORT) || 5317, scene: flags.scene, host: flags.host || '127.0.0.1' });
    if (flags.open) openBrowser(BASE);
  },

  async up({ flags }) {
    let st = await api('GET', '/api/status', undefined, { quietFail: true });
    // A plugin update installs a new copy next to the old one, but the server the old copy started keeps
    // running and serving the old app. When both are plugin copies, stop the old server and start this one.
    const inCache = (p) => typeof p === 'string' && p.split(path.sep).join('/').includes('/.claude/plugins/cache/');
    if (st?.launch?.root && st.launch.root !== ROOT && inCache(st.launch.root) && inCache(ROOT) && st.pid) {
      try { process.kill(st.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 50 && st; i++) { await new Promise((r) => setTimeout(r, 100)); st = await api('GET', '/api/status', undefined, { quietFail: true }); }
      out('restarting the canvas server on the updated plugin');
    }
    if (!st) {
      fs.mkdirSync(runDir(), { recursive: true });
      const logFile = fs.openSync(path.join(runDir(), 'server.log'), 'a');
      const args = [path.join(ROOT, 'bin', 'canvas.mjs'), 'serve'];
      if (flags.scene) args.push('--scene', path.resolve(String(flags.scene)));
      if (flags.port) args.push('--port', String(flags.port));
      const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFile, logFile], env: process.env });
      child.unref();
      fs.writeFileSync(path.join(runDir(), 'server.pid'), String(child.pid));
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await api('GET', '/api/status', undefined, { quietFail: true })) break;
      }
    }
    const s = await api('GET', '/api/status');
    if (flags.open !== false && !s.tabs) openBrowser(BASE);
    out(`canvas running at ${BASE}\nscene:   ${s.scene}\nexports: ${s.exports}\ntabs open: ${s.tabs}${s.listen ? '' : '\nnext:    run "canvas listen on" so prompts typed in the canvas reach this session'}`);
  },

  async down() {
    const pidFile = path.join(runDir(), 'server.pid');
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); fs.unlinkSync(pidFile); out('stopped'); }
    catch { out('no background server found (stop a foreground "serve" with Ctrl+C)'); }
  },

  open: () => { openBrowser(BASE); out(`opened ${BASE}`); },

  async status() {
    const s = await api('GET', '/api/status');
    out(`server: ${BASE}\nscene: ${s.scene}\nexports: ${s.exports}\ntabs open: ${s.tabs}\nagent listening: ${s.agent ? 'yes' : 'no'}${s.listen ? ' (listen mode on)' : ''}\nqueued prompts: ${s.queued}\nrev: ${s.rev}`);
  },

  async ls({ flags = {} } = {}) {
    const s = await api('GET', '/api/summary');
    if (flags.prefix) s.objects = s.objects.filter((o) => o.startsWith(String(flags.prefix)));
    const lines = [
      `scene "${s.meta.name}" ${s.meta.width}x${s.meta.height}, rev ${s.rev}, ${s.tabs} tab(s) open${s.agent ? '' : ''}`,
      `env: background ${s.env.background}, ground ${s.env.ground ? 'on' : 'off'}, grid ${s.env.grid ? 'on' : 'off'}, fog ${s.env.fog}, people ${s.env.people || 'low'}`,
      `objects (${s.objects.length}):`, ...s.objects.map((o) => `  ${o}`),
      `shots (${s.shots.length}, sequence order, * = active):`, ...s.shots.map((x, i) => ` ${shotLine(x, i)}`),
      `timeline of shot ${s.shot}: ${s.timeline.duration}s @ ${s.timeline.fps}fps, ${s.timeline.interp} path, speed ${JSON.stringify(s.timeline.speed)}${s.timeline.start ? `, shows the action from ${s.timeline.start}s (object key times below are action time)` : ''}`,
      ...(s.timeline.audio ? [`audio: ${s.timeline.audio.name} at ${s.timeline.audio.offset}s${s.timeline.audio.length ? `, ${s.timeline.audio.length}s long` : ''}, volume ${s.timeline.audio.volume}${s.timeline.audio.muted ? ', muted' : ''}`] : []),
      `camera keys (${s.keys.length}):`, ...s.keys.map((k) => `  ${k}`),
    ];
    out(lines.join('\n'));
  },

  async doc() { out((await api('GET', '/api/doc')).doc); },

  async add({ pos, flags }) {
    const type = pos[0];
    if (!type) throw new Error(`usage: canvas add <type> ... (types: ${Object.keys(PRIMITIVES).join(', ')})`);
    if (type === 'model' && pos[1] && flags.file == null) flags.file = pos[1];
    const up = type === 'model' ? await uploadModel(flags) : null;
    const r = await op({ op: 'add', type, ...objectFields(flags, type) });
    out(r.results[0].id + (up ? `\n${modelLine(up, flags.h ?? flags.size)}` : ''));
  },
  async models() {
    const r = await api('GET', '/api/models');
    out(r.models.length ? r.models.map((m) => `${m.file}  ${m.size ? `${m.size.join(' × ')} m as authored` : m.error || 'no geometry'}, ${m.triangles ?? '?'} triangles, ${(m.bytes / 1e6).toFixed(1)} MB${m.used.length ? `, used by ${m.used.join(', ')}` : ''}`).join('\n') : `no models yet (${r.dir}). Add one: canvas add model path/to/file.glb`);
  },
  async set({ pos, flags }) {
    if (flags.file != null) await uploadModel(flags);
    if (!pos[0]) throw new Error('usage: canvas set <id> --pos x,y,z ...');
    const r = await op({ op: 'update', id: pos[0], ...objectFields(flags) });
    out(r.results[0].id);
  },
  async dup({ pos, flags }) {
    const r = await op({ op: 'duplicate', id: pos[0], offset: flags.offset != null ? vec(flags.offset) : undefined, name: flags.name, newId: flags.name });
    out(r.results[0].id);
  },
  async rm({ pos }) { await op({ op: 'remove', ids: pos }); out(`removed ${pos.join(', ')}`); },
  async new() { const r = await op({ op: 'load', doc: createDoc() }); out(`new empty scene (${r.results[0].keys} camera keys). canvas undo brings the old one back`); },
  async clear({ flags }) { const r = await op({ op: 'clear', keys: !!flags.keys }); out(`removed ${r.results[0].removed} objects`); },
  async env({ flags }) {
    const o = { op: 'env' };
    if (flags.background) o.background = flags.background;
    if (flags.ground != null) o.ground = bool(flags.ground);
    if (flags.grid != null) o.grid = bool(flags.grid);
    if (flags.fog != null) o.fog = num(flags.fog);
    if (flags.sun != null) o.sun = vec(flags.sun);
    if (flags.people != null) o.people = String(flags.people);
    out((await op(o)).results[0]);
  },
  async meta({ flags }) {
    const o = { op: 'meta' };
    if (flags.name) o.name = String(flags.name);
    if (flags.width) o.width = num(flags.width);
    if (flags.height) o.height = num(flags.height);
    out((await op(o)).results[0]);
  },

  async shots() {
    const s = await api('GET', '/api/summary');
    out(s.shots.map(shotLine).join('\n'));
  },
  async shot({ pos }) {
    if (!pos[0]) return commands.shots();
    const r = (await api('POST', '/api/op', { ops: { op: 'shot.use', id: pos.join(' ') }, label: 'switch shot', source: 'agent', amend: true })).results[0];
    out(`now on shot ${r.id}${r.name !== r.id ? ` "${r.name}"` : ''}`);
  },
  async 'shot-add'({ flags }) {
    const o = { op: 'shot.add' };
    if (flags.name != null) o.name = String(flags.name);
    if (flags.from != null) o.from = String(flags.from);
    if (flags.blank) o.blank = true;
    if (flags.stay) o.switch = false;
    if (flags.start != null) o.start = num(flags.start);
    if (flags.length != null) o.duration = num(flags.length);
    if (flags.frame) o.frame = true;
    const r = (await op(o, 'new shot')).results[0];
    out(`added shot ${r.id} "${r.name}" from ${r.start}s (${r.shots} shots, active: ${r.active})`);
  },
  async 'shot-cut'({ pos, flags }) {
    if (pos[0] == null) throw new Error('usage: canvas shot-cut <seconds> [--name n] [--stay]');
    const o = { op: 'shot.split', t: num(pos[0]) };
    if (flags.name != null) o.name = String(flags.name);
    if (flags.stay) o.switch = false;
    const r = (await op(o, 'cut')).results[0];
    out(`cut at ${r.at}s: shot ${r.id} "${r.name}" starts there (${r.shots} shots, active: ${r.active})`);
  },
  async 'shot-set'({ pos, flags }) {
    const id = pos.length ? pos.join(' ') : undefined;
    const ops = [];
    if (flags.name != null) ops.push({ op: 'shot.update', id, name: String(flags.name) });
    if (flags.to != null) ops.push({ op: 'shot.move', id, to: num(flags.to) });
    if (flags.start != null) ops.push({ op: 'timeline', start: num(flags.start), ...(id ? { shot: id } : {}) });
    if (!ops.length) throw new Error('usage: canvas shot-set [id] [--name n] [--to position] [--start seconds]');
    await op(ops, 'edit shot');
    return commands.shots();
  },
  async 'shot-rm'({ pos }) {
    if (!pos[0]) throw new Error('usage: canvas shot-rm <id>');
    const r = (await op({ op: 'shot.remove', id: pos.join(' ') }, 'delete shot')).results[0];
    out(`removed shot ${r.removed}; active: ${r.active}`);
  },

  async key({ flags }) {
    const k = keyFields(flags);
    if (flags['from-view']) {
      const cam = await rpc('camera');
      k.position ??= cam.position; k.target ??= cam.target; k.fov ??= cam.fov; k.roll ??= cam.roll;
      if (k.t == null) k.t = cam.time;
    }
    const r = await op({ op: 'key.add', ...k });
    out(`${r.results[0].replaced ? 'updated' : 'added'} key ${r.results[0].id}`);
  },
  async 'key-set'({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: canvas key-set <keyId|index> --ease snap');
    const k = keyFields(flags);
    if (flags['from-view']) { const cam = await rpc('camera'); Object.assign(k, { position: cam.position, target: cam.target, fov: cam.fov, ...(cam.roll != null && { roll: cam.roll }) }); }
    const r = await op({ op: 'key.update', ...keyRef(pos[0]), ...k });
    out(`updated key ${r.results[0].id}`);
  },
  async 'ease-all'({ pos, flags }) {
    if (!pos[0] && !flags.from) throw new Error('usage: canvas ease-all <easeName|x1,y1,x2,y2> | --from <keyId>');
    const o = { op: 'key.easeAll' };
    if (flags.from) o.from = keyRef(String(flags.from)).id ?? keyRef(String(flags.from)).index;
    else o.ease = easeArg(pos[0]);
    if (flags.cuts) o.cuts = true;
    const r = (await op(o, 'ease all segments')).results[0];
    out(`set the ease on ${r.updated} segment${r.updated === 1 ? '' : 's'}`);
  },
  async 'key-rm'({ pos }) { const r = await op({ op: 'key.remove', ...keyRef(pos[0]) }); out(`removed key ${r.results[0].removed}`); },
  async 'keys-clear'() { const r = await op({ op: 'key.clear' }); out(`removed ${r.results[0].removed} keys`); },
  async move({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: canvas move <id> --to x,y,z [--at 0] [--over 1] [--ease easeInOut]');
    const o = { op: 'anim.move', id: pos[0] };
    if (flags.to != null) o.to = vec(flags.to);
    if (flags.by != null) o.by = vec(flags.by);
    if (flags.rot != null || flags.rotation != null) o.rotation = vec(flags.rot ?? flags.rotation);
    if (flags.turn != null) o.turn = vec(flags.turn);
    if (flags.scale != null) o.scale = vec(flags.scale);
    if (flags.at != null) o.at = num(flags.at);
    if (flags.over != null) o.over = num(flags.over);
    if (flags.ease != null) o.ease = easeArg(flags.ease);
    const r = (await op(o, `move ${pos[0]}`)).results[0];
    out(`${r.id} moves ${r.from}s → ${r.to}s (${r.keys} keys)`);
  },
  async okey({ pos, flags }) {
    if (!pos[0] || flags.t == null) throw new Error('usage: canvas okey <id> --t 2 [--pos x,y,z] [--rot x,y,z] [--scale s] [--ease name]');
    const o = { op: 'anim.key', id: pos[0], t: num(flags.t) };
    if (flags.pos != null || flags.position != null) o.position = vec(flags.pos ?? flags.position);
    if (flags.rot != null || flags.rotation != null) o.rotation = vec(flags.rot ?? flags.rotation);
    if (flags.scale != null) o.scale = vec(flags.scale);
    if (flags.ease != null) o.ease = easeArg(flags.ease);
    const r = (await op(o, `key ${pos[0]}`)).results[0];
    out(`keyed ${r.id} at ${r.t}s (${r.keys} keys)`);
  },
  async 'okey-rm'({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: canvas okey-rm <id> [--t 2]');
    const r = (await op({ op: 'anim.remove', id: pos[0], t: flags.t != null ? num(flags.t) : undefined })).results[0];
    out(`${r.id}: ${r.keys} animation keys left`);
  },

  async timeline({ flags }) {
    const o = { op: 'timeline' };
    if (flags.duration != null) o.duration = num(flags.duration);
    if (flags.retime) o.retime = true;
    if (flags.fps != null) o.fps = num(flags.fps);
    if (flags.interp != null) o.interp = String(flags.interp);
    if (flags.speed != null) o.speed = easeArg(flags.speed);
    if (flags.ease != null) o.ease = easeArg(flags.ease);
    if (flags.start != null) o.start = num(flags.start);
    out((await op(o)).results[0].timeline);
  },

  async audio({ pos, flags }) {
    const o = { op: 'audio' };
    if (pos[0]) {
      const file = path.resolve(String(pos[0]));
      if (!fs.existsSync(file)) throw new Error(`no such file: ${pos[0]}`);
      const res = await fetch(`${BASE}/api/audio?name=${encodeURIComponent(path.basename(file))}`, { method: 'POST', body: fs.readFileSync(file) })
        .catch(() => { throw new Error(`canvas server is not running at ${BASE}`); });
      const up = await res.json();
      if (!up.ok) throw new Error(up.error);
      Object.assign(o, { file: up.file, name: up.name });
    }
    if (flags.clear) { await op({ op: 'audio', clear: true }, 'remove audio'); return out('removed the audio track'); }
    if (flags.offset != null) o.offset = num(flags.offset);
    if (flags.volume != null) o.volume = num(flags.volume);
    if (flags.mute != null) o.muted = bool(flags.mute);
    if (Object.keys(o).length > 1) await op(o, pos[0] ? 'load audio' : 'edit audio');
    let info = null;
    if ((flags.fit || flags.beats) && SHOT) {
      const d = (await api('GET', '/api/doc')).doc;
      if (shotTimeline(d, SHOT) !== d.timeline) throw new Error(`--fit and --beats need the tab to play the audio: switch to the shot first (canvas shot ${SHOT})`);
    }
    if (flags.fit || flags.beats) info = await rpc('audio', { beats: !!flags.beats }, 60000); // the tab decodes it (and records its length)
    if (flags.fit) await op({ op: 'audio', fit: true }, 'fit shot to audio');
    const a = shotTimeline((await api('GET', '/api/doc')).doc, SHOT ?? undefined);
    if (!a.audio) return out('no audio on the timeline (load one: canvas audio song.mp3)');
    if (flags.beats && flags.json) return out(info);
    const au = a.audio;
    const lines = [`audio: ${au.name} (${au.file}) ${au.length ? `${au.length}s` : 'length not read yet'}, starts at ${au.offset}s on the timeline, volume ${au.volume}${au.muted ? ', muted' : ''}; shot ${a.duration}s`];
    if (info?.beats) lines.push(`tempo ≈ ${info.tempo ? `${info.tempo} bpm (beat every ${info.beat}s)` : 'not found'}`, `beats in the shot: ${info.beats.join(' ') || 'none'}`, `strong onsets: ${info.onsets.join(' ') || 'none'}`);
    out(lines.join('\n'));
  },

  async seek({ pos }) { out(await rpc('seek', { t: num(pos[0] ?? 0) })); },
  async play() { out(await rpc('play')); },
  async pause() { out(await rpc('pause')); },
  async view({ pos }) { out(await rpc('view', { mode: pos[0] || 'shot' })); },
  async select({ pos }) { out(await rpc('select', { id: pos[0] && pos[0] !== 'none' ? pos[0] : null })); },
  async frame({ pos }) { out(await rpc('frame', { id: pos[0] || null })); },

  async snapshot({ flags }) {
    if ((flags.from != null) !== (flags.target != null)) throw new Error('use --from and --target together (camera position and the point it looks at)');
    const own = flags.from != null && flags.target != null
      ? { from: vec(flags.from), target: vec(flags.target), fov: flags.lens != null ? lensToFov(num(flags.lens)) : flags.fov != null ? num(flags.fov) : undefined }
      : {};
    const r = await rpc('snapshot', { t: flags.t != null ? num(flags.t) : undefined, view: flags.view, name: flags.out ? path.basename(String(flags.out)) : undefined, width: flags.width && num(flags.width), height: flags.height && num(flags.height), shot: SHOT ?? undefined, ...own }, 60000);
    out(copyOut(r.path, flags.out));
  },
  async storyboard({ flags }) {
    const r = await rpc('storyboard', { frames: flags.frames ? num(flags.frames) : 8, cols: flags.cols ? num(flags.cols) : 4, shot: SHOT ?? undefined }, 120000);
    out(copyOut(r.path, flags.out));
  },
  async export({ flags }) {
    const params = {
      fps: flags.fps && num(flags.fps), width: flags.width && num(flags.width), height: flags.height && num(flags.height),
      grid: flags.grid != null ? bool(flags.grid) : undefined, name: flags.name ? String(flags.name) : undefined,
      shot: SHOT ?? undefined, sequence: flags.sequence || undefined,
    };
    const r = await rpc('export', params, 60 * 60 * 1000);
    out(`${copyOut(r.path, flags.out)}\n${r.shots ? `${r.shots.length} shots (${r.shots.map((x) => `${x.id} ${x.frames}f`).join(', ')}), ` : ''}${r.frames} frames, ${r.width}x${r.height} @ ${r.fps}fps, ${r.codec}${r.audio ? ` + ${r.audio} audio` : ''}, ${(r.bytes / 1e6).toFixed(2)} MB`);
  },

  async wait({ flags }) {
    const timeout = flags.timeout != null ? num(flags.timeout) : 600;
    const start = Date.now();
    // Waiting for canvas prompts means this agent is listening: keep it that way across turns
    // (Claude Code's Stop hook uses this flag). `canvas listen off` or --no-listen opts out.
    if (flags.listen !== false) await api('POST', '/api/listen', { on: true, ...listenOwner() }, { quietFail: true });
    // Long-poll in slices so a dropped connection does not lose more than one slice.
    while (true) {
      const left = timeout - (Date.now() - start) / 1000;
      if (left <= 0) { out(flags.json ? { prompt: null } : 'no prompt (timed out). Run "canvas wait" again to keep listening.'); return; }
      let r;
      try { r = await api('GET', `/api/prompt/next?wait=${Math.ceil(Math.min(left, 300))}`); }
      catch (e) { if (/not running/.test(e.message)) throw e; await new Promise((res) => setTimeout(res, 1000)); continue; }
      if (r.prompt) { out(flags.json ? r.prompt : formatPrompt(r.prompt)); return; }
    }
  },
  async inbox() {
    const r = await api('GET', '/api/prompts');
    out(r.prompts.map((p) => `${p.id} [${p.status}] ${p.text}`).join('\n') || 'no prompts yet');
  },
  async chats({ pos, flags }) {
    const when = (at) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    if (!pos[0]) {
      const r = await api('GET', '/api/chats');
      if (flags.json) return out(r.chats);
      return out(r.chats.map((c) => `${c.id}  ${when(c.endedAt)}  (${c.count})  ${c.title}`).join('\n') || 'no past chats yet');
    }
    const { chat } = await api('GET', `/api/chats/get?id=${encodeURIComponent(pos[0])}`);
    if (flags.json) return out(chat);
    const items = [...chat.prompts.map((p) => ({ at: p.at, who: 'user', text: p.text, images: p.images })), ...chat.messages.map((m) => ({ at: m.at, who: m.from || 'agent', text: m.text }))]
      .sort((a, b) => a.at - b.at);
    out([`${chat.title}  (${when(chat.startedAt)} to ${when(chat.endedAt)})`, '',
      ...items.map((x) => `${x.who}: ${x.text || ''}${x.images?.length ? ` [images: ${x.images.map((i) => i.path).join(' | ')}]` : ''}`)].join('\n'));
  },
  async say({ pos, flags }) {
    const text = pos.join(' ');
    if (!text) throw new Error('usage: canvas say "message" [--reply <promptId>]');
    await api('POST', '/api/say', { text, reply: flags.reply, done: !flags.working, kind: flags.kind || (flags.working ? 'working' : 'info') });
    out('sent');
  },
  async listen({ pos }) {
    const on = (pos[0] || 'on') !== 'off';
    await api('POST', '/api/listen', { on, ...listenOwner() });
    out(on ? 'listen mode on: when this Claude Code session finishes a turn, the Stop hook waits for the next canvas prompt' : 'listen mode off');
  },

  async op({ pos }) {
    const ops = JSON.parse(pos.join(' '));
    out((await op(ops)).results);
  },
  async ops({ pos, flags }) {
    const ops = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
    if (flags.scope) checkScope(Array.isArray(ops) ? ops : [ops], String(flags.scope));
    out((await op(ops)).results);
  },
  async save({ pos, flags }) {
    const r = await api('POST', '/api/save', { name: pos.join(' ') || undefined, overwrite: !!flags.overwrite });
    out(`saved "${r.name}" → ${r.path}`);
  },
  async load({ pos }) {
    if (!pos[0]) throw new Error('usage: canvas load <name>   (canvas saves lists them)');
    const r = await api('POST', '/api/load', { name: pos.join(' ') });
    out(`loaded "${r.name}": ${r.objects} objects, ${r.keys} camera keys (canvas undo to go back)`);
  },
  async saves() {
    const r = await api('GET', '/api/saves');
    out(r.saves.length ? r.saves.map((s) => `${s.name.padEnd(28)} ${s.savedAt.replace('T', ' ').slice(0, 16)}  ${s.objects} objects, ${s.keys} keys`).join('\n') : `no saves yet (${r.dir})`);
  },
  async undo() { out(await api('POST', '/api/undo')); },
  async redo() { out(await api('POST', '/api/redo')); },

  // ---------- agent hooks (Claude Code) ----------
  async hook({ pos }) {
    const which = pos[0];
    const input = await readStdin().then((s) => { try { return JSON.parse(s); } catch { return {}; } });
    const st = await api('GET', '/api/status', undefined, { quietFail: true });
    if (!st) return; // server not running: hooks are no-ops
    if (!ownsCanvas(st, input)) return; // another session is listening, or this one has nothing to do with the canvas
    if (!hookLock(`${which}-${input.session_id || 'any'}`)) return; // the other copy of this hook is handling it

    if (which === 'prompt') {
      // UserPromptSubmit: hand over anything queued in the canvas as extra context.
      const got = [];
      for (let i = 0; i < 10; i++) {
        const r = await api('GET', '/api/prompt/next?keep=1', undefined, { quietFail: true });
        if (!r?.prompt) break;
        got.push(formatPrompt(r.prompt));
      }
      if (got.length) out(`Prompts the user typed in the canvas while you were busy:\n\n${got.join('\n\n')}`);
      return;
    }

    if (which === 'stop') {
      // Stop: if the user prompted in the canvas, keep going in this same thread.
      let r = await api('GET', '/api/prompt/next', undefined, { quietFail: true });
      if (!r?.prompt && st.listen) {
        // Long-poll in short slices: Node's fetch gives up on a response after 300 s, which used to end
        // the wait (and the session) after five idle minutes. Re-check listen mode between slices.
        const secs = Number(process.env.CANVAS_LISTEN_SECONDS || 3300);
        const slice = Number(process.env.CANVAS_POLL_SLICE || 240);
        const start = Date.now();
        while (!r?.prompt) {
          const left = secs - (Date.now() - start) / 1000;
          if (left <= 0) break;
          r = await api('GET', `/api/prompt/next?wait=${Math.ceil(Math.min(left, slice))}`, undefined, { quietFail: true });
          if (r?.prompt) break;
          const now = await api('GET', '/api/status', undefined, { quietFail: true });
          if (!now) { await new Promise((res) => setTimeout(res, 2000)); continue; } // server restarting: keep trying
          if (!now.listen || !ownsCanvas(now, input)) return; // listen off, or another session took over: let this one stop
        }
        if (!r?.prompt) {
          // Nothing for a whole wait: hand back a no-op turn so this hook runs again and listening continues.
          out({ decision: 'block', reason: 'Still listening to the canvas: no prompt arrived. Do nothing and end your turn now (no tool calls, no message); the Stop hook waits again.' });
          return;
        }
      }
      if (r?.prompt) {
        out({ decision: 'block', reason: `The user sent this from the canvas. Handle it now, then reply with canvas say.\n\n${formatPrompt(r.prompt)}` });
      }
    }
  },
};

const aliases = { remove: 'rm', delete: 'rm', update: 'set', duplicate: 'dup', list: 'ls', '-h': 'help', '--help': 'help' };

function copyOut(file, dest) {
  if (!dest || dest === true) return file;
  const target = path.resolve(String(dest));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  return target;
}

const [cmdName = 'help', ...rest] = process.argv.slice(2);
const cmd = commands[aliases[cmdName] || cmdName];
if (!cmd) { console.error(`unknown command "${cmdName}". Run: canvas help`); process.exit(2); }
try {
  const args = parseArgs(rest);
  if (args.flags.shot != null) { SHOT = String(args.flags.shot); delete args.flags.shot; }
  await cmd(args);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
