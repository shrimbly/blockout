#!/usr/bin/env node
// canvas: the agent's command line for Blockout.
// Every command talks to the bridge server over HTTP (default http://127.0.0.1:5317).
// Run `canvas help` for the reference.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRIMITIVES, MOVES, createDoc, shotTimeline, PERSON_POSES, PERSON_JOINTS, parseJoints } from '../core/doc.js';
import { EASES, lensToFov } from '../core/curves.js';
import { shotBrief, briefText, timelineBrief, timelineText } from '../core/brief.js';
import { dataDir } from '../server/paths.mjs';
import { normalizeAsk } from '../core/ask.js';
import { readSecrets, listSecrets, removeSecret, secretsPath } from '../server/secrets.mjs';

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
  canvas brief [--shot id | --all | --timeline] [--beats] [--json]
                                            the shot's camera work in words: each move between keys with its
                                            times, pace and ease, how each framing reads (size, height, side,
                                            lens), objects that move, and the part of the audio it plays.
                                            For describing a shot, e.g. in a prompt for a video model.
                                            --all: every shot; --beats: add tempo and beat times (needs the tab)
                                            --timeline: the whole timeline as one video, as canvas export renders
                                            it: every shot with its cuts, all times in seconds of that video

Objects (meters, Y up, pivot at bottom centre, rotation in degrees)
  canvas add <type> [--name n] [--pos x,y,z] [--rot x,y,z] [--scale s|x,y,z]
                    [--size a,b,c] [--<param> v] [--color #rrggbb] [--note text]
  canvas set <id> [same flags as add] [--move dx,dy,dz] [--type t]
  canvas dup <id> [--offset x,y,z] [--name n]
  canvas poses                              the poses and joints a person takes (--pose sit, --joints "kneeL=90")
  canvas rm <id> [id...]
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
  --shot <id>   on key, key-set, key-rm, keys-clear, ease-all, cam, timeline, audio, move, okey, okey-rm,
                snapshot, storyboard, export and brief: work on that shot without switching to it

Camera timeline
  canvas key --t 2 --pos x,y,z --target x,y,z [--fov 40 | --lens 35] [--roll 0] [--ease name|x1,y1,x2,y2]
  canvas key --t 2 --from-view              key the camera the user is looking through right now
  canvas key-set <keyId|index> [same flags] change a key (e.g. --ease snap, --t 3)
  canvas ease-all <name|x1,y1,x2,y2[,px,py,x3,y3,x4,y4…]>  give every camera segment that ease (cuts stay cuts; --from <keyId> copies a key's; --all-shots: every shot)
  canvas key-set <keyId|index> --path smooth|straight|orbit|turn|dollyZoom   how the camera travels to the next key
  canvas key-set <keyId|index> --shudder [jerks,amount%] [--jerks 6] [--amount 4] [--shape jerk|wobble|stutter]
                 [--over even|fade|build] [--shudder-from 0 --shudder-to 1]   the camera judders back and forth
                 along the segment after the key, on top of its ease (amount: how far each jerk pulls back, % of
                 the move; from / to: only in that section, as shares of the segment); --shudder off removes it
  canvas key-rm <keyId|index>
  canvas keys-clear

Camera moves (presets: write a key at --t with the move's path and ease, and a key where it ends;
keys in between are replaced. Both stay ordinary keys you can drag, re-key and ease afterwards)
  canvas cam                                list the moves and their params
  canvas cam <move> [--t s] [--over 3] [--ease name] [--from-view] [params]
    pan --angle 45 (+ right) · tilt --angle 20 (+ up) · orbit --angle 90 (+ right) [--around id|x,y,z] [--rise m]
    push --by m (+ in) · pull-out --by m · truck --by m (+ right) · pedestal --by m (+ up, aim moves too)
    crane --by m (+ up, keeps the aim) · zoom --lens 85 | --fov 20 · dolly-zoom --by m (+ in, lens widens)
    roll --angle 15 (dutch)
  --t defaults to the playhead (0 with no tab open); --from-view starts from the user's current view
  canvas cam [move] --edit <keyId> [params]  change the move that starts at that key (same start framing;
                                            settings you leave out keep their values, e.g. --angle 180 --over 4)
  canvas timeline [--duration 6 [--retime]] [--fps 24] [--interp smooth|linear]
                  [--speed name|x1,y1,x2,y2] [--ease name] [--start s]   (--ease sets every segment;
                  --start: where this shot picks up the shared action, like shot-set --start)
  canvas import <file.glb> [--name n] [--pos x,y,z] [--rot x,y,z] [--scale s] [--offset s] [--speed v] [--fit]
                  add a GLB as a model object (a scanned or captured character, a set); its first animation
                  plays on the action time from --offset at --speed; --fit makes the shot as long as the clip
  canvas audio [file] [--offset s] [--in s] [--out s] [--volume 1] [--mute on|off] [--show-beats on|off] [--fit]
                  load a music / dialogue track onto the timeline (mixed into the export). One track spans
                  every shot, on the shared action time. --offset: action time where the file starts
                  (negative skips into it); --in / --out: trim, seconds into the file (none = untrimmed);
                  --show-beats: mark the beat grid on the audio lane in the tab;
                  --fit: the active shot ends where the audio ends
  canvas audio --beats [--json]             tempo and onset times inside the shot (needs the tab), to key/cut on
  canvas audio --clear                      remove the audio track
  canvas seek <seconds> | play | pause | view shot|free | select <id|none> | frame [id]
  eases: ${Object.keys(EASES).join(' ')}

Render (needs the canvas tab open)
  canvas snapshot [--t 2] [--view shot|free] [--out file.png]   PNG of one frame; prints its path
          [--from x,y,z --target x,y,z [--lens 35]]           ...or from a camera of your own (the user's view is untouched)
  canvas storyboard [--frames 8] [--cols 4]                     contact sheet across the shot
  canvas inspect <ids or prefix-> [--close id[,id]] [--t s] [--no-figure]
                                                                 one asset on its own from 6 angles (front, back, sides,
                                                                 3/4 high, top) + close-ups, with a 1.8 m figure; prints the
                                                                 PNG path, its size and parts that may be floating
  canvas review "what is wrong | …" | "no problems"            write up the last inspect pass (high detail prompts)
  canvas review --skip "why"                                     end a high detail review without finishing it
  canvas export [--fps 24] [--width 1280 --height 720] [--grid on|off] [--name shot]
                                                                 blockout video (mp4) of the whole timeline: every shot in
                                                                 order, cut together, with the audio; prints its path
  canvas export --shot <id> [same flags]                         just that one shot

Prompts from the canvas
  canvas wait [--timeout 600] [--json]      block until the user types a prompt in the canvas; prints it.
                                            Marks earlier prompts done and turns listen mode on.
  canvas inbox                              list recent prompts and their status
  canvas chats [id] [--json]                past chats (archived by "New chat"), newest first; with an id,
                                            that chat's transcript
  canvas say "text" [--reply <promptId>] [--working]   message shown in the canvas
             [--attach file[,file…]]        ...carrying videos or images that play / show in the chat
                                            (mp4, webm, mov, png, jpg, webp, gif; text is optional then)
  canvas ask <card.json | - | '{…}'> [--reply <promptId>] [--title "…"]
                                            ask the user in the chat with a question card: the questions show one
                                            at a time (choices, text, images, a text to review, an API key) and the answers come
                                            back as one prompt (canvas wait / the Stop hook). See references/api.md
  canvas ask "Question?" --options "A|B|C" [--multi] [--other] | --images | --secret NAME | --review file.txt [--optional]
                                            the same for one quick question
  canvas progress "title" [--steps "A|B|C"] [--eta seconds] [--note "…"]
                                            show a progress card in the chat for a long job (a render); prints its id.
                                            It counts the time by itself between updates
  canvas progress --id <id> [--step n] [--pct 0-100] [--note "…"] [--eta s] | --done ["note"] | --fail "why"
                                            update that card in place, or end it
  canvas secret list | rm NAME              API keys the user saved through a key block (names only)
  canvas secret run NAME[,NAME2] -- <command …>   run a command with those keys as environment variables;
                                            the values are never printed (they are masked in its output)
  canvas listen on|off                      keep a Claude Code session waiting for canvas prompts (Stop hook)

Save and load (scenes/saved/<name>.json)
  canvas save [name] [--overwrite]           save a named copy of the scene (default name: scene-<date>-<time>)
  canvas load <name>                         replace the scene with a save (undo brings the old one back)
  canvas saves                               list saves, newest first
  canvas save-rm <name>                      delete a save (moved to scenes/saved/.deleted/)

Raw / batch
  canvas op '<json op or [ops]>'            e.g. canvas op '{"op":"add","type":"box","w":2}'
  canvas ops <file.json> [--scope prefix]   apply an array of ops atomically; --scope refuses any op that
                                            touches an object outside that id prefix, or the camera/timeline
  canvas undo | redo
`;

// ---------- helpers ----------
// Flags that never take a value, so `say --working "text"` keeps "text" as the message.
const BOOLEAN_FLAGS = new Set(['working', 'json', 'retime', 'keys', 'from-view', 'open', 'no-open', 'help', 'overwrite', 'fit', 'clear', 'beats', 'sequence', 'blank', 'stay', 'all', 'timeline', 'images', 'multi', 'optional', 'no-figure']);

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
const fmtS = (v) => `${v < 0 ? '-' : ''}${Math.abs(v)}s`;
/** The scene's audio track in one line: where it sits in the action, its trim, volume. */
const audioLine = (a) => {
  const len = a.length, i = a.in || 0, o = a.out ?? len;
  const trim = a.in || a.out != null ? `, trimmed to ${i}–${o ?? 'end'}s of the file` : '';
  const span = o != null ? `, plays ${fmtS(+(a.offset + i).toFixed(3))}–${fmtS(+(a.offset + o).toFixed(3))} of the action` : '';
  return `audio (all shots): ${a.name} at ${a.offset}s${len ? `, ${len}s long` : ''}${trim}${span}, volume ${a.volume}${a.muted ? ', muted' : ''}${a.beats ? ', beats shown' : ''}`;
};
const shotLine = (s, i) => `${s.active ? '*' : ' '} ${i + 1} ${s.id}${s.name !== s.id ? ` "${s.name}"` : ''}: ${s.duration}s @ ${s.fps}fps, ${s.keys} camera key${s.keys === 1 ? '' : 's'}${s.start ? `, action from ${s.start}s` : ''}`;
const rpc = (method, params = {}, timeout) => api('POST', '/api/rpc', { method, params, timeout }).then((d) => d.result);
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

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
    const isText = Object.values(PRIMITIVES).some((p) => p.choices?.[k] || p.strings?.[k]);
    o[k] = k === 'joints' ? parseJoints(v) : v === 'null' ? null : isText ? String(v) : num(v);
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
  if (flags.path != null) k.path = String(flags.path);
  if (['shudder', 'jerks', 'amount', 'shape', 'over', 'shudder-from', 'shudder-to'].some((f) => flags[f] != null)) {
    k.shudder = flags.shudder === false || /^(off|none|false|0)$/i.test(String(flags.shudder)) ? 'off' : shudderArg(flags);
  }
  for (const f of ['position', 'target']) if (typeof k[f] === 'number') throw new Error(`--${f === 'position' ? 'pos' : f} needs x,y,z`);
  return k;
}
/** --shudder [jerks,amount] plus --jerks --amount --shape --over: only what was given, so the rest keeps. */
function shudderArg(flags) {
  const sh = {};
  const [j, a] = typeof flags.shudder === 'string' ? flags.shudder.split(',') : [];
  if (j) sh.jerks = num(j);
  if (a) sh.amount = num(a.replace('%', ''));
  if (flags.jerks != null) sh.jerks = num(flags.jerks);
  if (flags.amount != null) sh.amount = num(String(flags.amount).replace('%', ''));
  if (flags.shape != null) sh.shape = String(flags.shape);
  if (flags.over != null) sh.over = String(flags.over);
  if (flags['shudder-from'] != null) sh.from = num(flags['shudder-from']);
  if (flags['shudder-to'] != null) sh.to = num(flags['shudder-to']);
  return sh;
}
const keyRef = (s) => (/^\d+$/.test(s) ? { index: Number(s) } : { id: s });

// Sent with every prompt the user marked "High detail", so the loop reaches the agent with the prompt itself.
const HIGH_DETAIL = `detail: HIGH. The user switched on High detail: take your time and build a highly detailed model, then review it until it is right.
  1. Plan before building: the real proportions and a parts list by sub-assembly (a hero asset is usually 40 to 150 primitives:
     chamfers and trims, panel lines, handles, hinges, lights, frames, legs, small props). One id prefix for the asset, e.g. van-.
  2. Build it one sub-assembly per canvas ops batch (helpers: skills/blockout/references/orchestration.md for big multi-part builds).
  3. Review loop: canvas inspect <prefix> [--close <small part>] → open the PNG → canvas review "what is wrong | …" (or "no problems")
     → fix it → inspect again. Look for floating or sunken parts, gaps, overlaps poking through, wrong scale against the 1.8 m figure,
     missing parts, and anything that reads wrong from one side only.
  4. The chat shows each pass on a Review card. Your final canvas say is refused until you have done at least 2 passes, written each up,
     and the last inspect came after your last change.`;

function formatPrompt(p) {
  const c = p.context || {};
  const lines = [`[canvas prompt ${p.id}] ${p.text || `(no text, see the attached ${p.images?.length ? 'images' : 'models'})`}`];
  if (p.images?.length) lines.push(`images attached (open each with your Read tool): ${p.images.map((i) => i.path).join(' | ')}`);
  if (p.models?.length) lines.push(`GLB models attached, NOT in the scene yet (add one only if the message asks, with: canvas import <path> [--pos x,y,z]): ${p.models.map((m) => `${m.name} → ${m.path}`).join(' | ')}`);
  if (p.detail === 'high') lines.push(HIGH_DETAIL);
  if (c.selection?.length) lines.push(`selected: ${c.selection.join(' | ')}`);
  if (c.time != null) lines.push(`${c.shot ? `shot: ${c.shot}, ` : ''}playhead: ${Number(c.time).toFixed(2)}s of ${c.duration}s, view: ${c.view}${c.key ? `, key: ${c.key}` : ''}`);
  if (c.camera) lines.push(`camera: pos=${c.camera.position.map((v) => +v.toFixed(2)).join(',')} target=${c.camera.target.map((v) => +v.toFixed(2)).join(',')} fov=${+c.camera.fov.toFixed(1)}`);
  lines.push(p.ask ? `→ these answer your question card ${p.ask}. Carry on with what you were doing, then: canvas say --reply ${p.id} "<one line>"`
    : `→ do it with canvas commands, then: canvas say --reply ${p.id} "<one line on what changed>"`);
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
  const file = path.join(os.tmpdir(), `blockout-${name.replace(/[^\w.-]/g, '_')}.lock`);
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
      ...(s.audio ? [audioLine(s.audio)] : []),
      `camera keys (${s.keys.length}):`, ...s.keys.map((k) => `  ${k}`),
    ];
    out(lines.join('\n'));
  },

  async doc() { out((await api('GET', '/api/doc')).doc); },
  poses() {
    out([
      'Poses for a person (canvas add person --pose sit, canvas set <id> --pose wave). Any pose but stand draws the jointed mannequin:',
      ...Object.entries(PERSON_POSES).map(([k, v]) => `  ${k.padEnd(14)} ${v.about}`),
      '',
      'Joints (--joints "kneeL=90 shoulderR=80,0,10" sets those joints on top of the pose; --joints null clears them).',
      'L/R are the figure\'s own left and right. Degrees:',
      '  body, spine, neck     bend forward, lean to its left, turn to its left   (body tips the whole figure at the hips)',
      '  shoulder, hip, wrist  raise forward, raise out to the side, twist about its length (+ turns its front out)',
      '  elbow, knee           bend (0 is straight)',
      '  ankle                 toes up (+) or pointed (−)',
      `  joints: ${PERSON_JOINTS.join(' ')}`,
    ].join('\n'));
  },

  // The camera work of a shot (or every shot) in words and numbers, computed from the scene doc.
  async brief({ flags }) {
    const [{ doc }, st] = await Promise.all([api('GET', '/api/doc'), api('GET', '/api/status')]);
    if (flags.timeline) {
      // the whole timeline as one video, as `canvas export` renders it: times are seconds of that video
      const t = timelineBrief(doc);
      const dir = path.join(path.dirname(st.scene), 'audio');
      for (const b of t.shots) {
        if (b.audio) b.audio.path = path.join(dir, b.audio.file);
        if (flags.beats && b.shot.active && b.audio && !b.audio.silent) { const info = await rpc('audio', { beats: true }, 60000); b.beats = { tempo: info.tempo, beat: info.beat, beats: info.beats, onsets: info.onsets }; }
      }
      return out(flags.json ? t : timelineText(t));
    }
    const ids = flags.all ? doc.shots.map((s) => s.id) : [SHOT ?? doc.shot];
    const briefs = [];
    for (const id of ids) {
      const b = shotBrief(doc, id);
      if (b.audio) b.audio.path = path.join(path.dirname(st.scene), 'audio', b.audio.file);
      // beats come from the tab, which plays the active shot
      if (flags.beats && b.shot.active && b.audio && !b.audio.silent) {
        const info = await rpc('audio', { beats: true }, 60000);
        b.beats = { tempo: info.tempo, beat: info.beat, beats: info.beats, onsets: info.onsets };
      } else if (flags.beats && !flags.all && !b.shot.active) throw new Error(`--beats needs the tab on that shot: switch to it first (canvas shot ${b.shot.id})`);
      briefs.push(b);
    }
    if (flags.json) return out(flags.all ? briefs : briefs[0]);
    out(briefs.map((b) => briefText(b, b.beats) + (b.audio?.path ? `\n  audio file: ${b.audio.path}` : '')).join('\n\n'));
  },

  async add({ pos, flags }) {
    const type = pos[0];
    if (!type) throw new Error(`usage: canvas add <type> ... (types: ${Object.keys(PRIMITIVES).join(', ')})`);
    const r = await op({ op: 'add', type, ...objectFields(flags, type) });
    out(r.results[0].id);
  },
  // Upload a GLB into the scene folder's models/ and add it as a model object (its first clip plays on the
  // action time). --fit makes the shot as long as the clip.
  async import({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: canvas import <file.glb> [--name n] [--pos x,y,z] [--rot x,y,z] [--scale s] [--offset s] [--speed v] [--fit]');
    const file = path.resolve(String(pos[0]));
    if (!fs.existsSync(file)) throw new Error(`no such file: ${pos[0]}`);
    const res = await fetch(`${BASE}/api/model?name=${encodeURIComponent(path.basename(file))}`, { method: 'POST', body: fs.readFileSync(file) })
      .catch(() => { throw new Error(`canvas server is not running at ${BASE}`); });
    const up = await res.json();
    if (!up.ok) throw new Error(up.error);
    const { fit, ...rest } = flags;
    const clip = up.clips[0];
    const name = rest.name ?? path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const o = { op: 'add', type: 'model', position: [0, 0, 0], ...objectFields({ ...rest, name }), file: up.file, length: clip?.length ?? null, h: up.height };
    const id = (await op(o, 'import model')).results[0].id;
    const lines = [`${id}: ${up.name} → models/${up.file} (${(up.bytes / 1e6).toFixed(1)} MB, ${up.skins ? 'skinned' : 'static'}, about ${up.height ?? '?'} m tall)`];
    lines.push(clip ? `clip "${clip.name}" ${clip.length}s plays from action time ${o.offset ?? 0}s${up.clips.length > 1 ? ` (${up.clips.length - 1} more clips not used)` : ''}` : 'no animation: it stays still');
    if (fit) {
      if (!clip) throw new Error('--fit needs an animated model');
      const duration = Math.round((clip.length / (o.speed || 1)) * 1000) / 1000;
      await op({ op: 'timeline', duration }, 'fit shot to model');
      lines.push(`shot length set to ${duration}s`);
    }
    out(lines.join('\n'));
  },
  async set({ pos, flags }) {
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
    if (flags['all-shots']) o.allShots = true;
    const r = (await op(o, 'ease all segments')).results[0];
    out(`set the ease on ${r.updated} segment${r.updated === 1 ? '' : 's'}${o.allShots ? ` in ${r.shots} shot${r.shots === 1 ? '' : 's'}` : ''}`);
  },
  async cam({ pos, flags }) {
    if (!pos[0] && flags.edit == null) {
      out(['camera moves (canvas cam <move> [--t s] [--over 3] [--ease name] [params]):',
        ...Object.values(MOVES).map((m) => `  ${m.name.padEnd(10)} ${m.about}; ${m.params}`),
        '  aliases: push-in, dolly → push · pull-out (push, reversed) · dolly-zoom, vertigo → dollyZoom · dutch → roll · arc → orbit · boom → crane'].join('\n'));
      return;
    }
    const o = { op: 'cam.move' };
    if (pos[0]) o.move = pos[0];
    if (flags.edit != null) { const r = keyRef(String(flags.edit)); o.edit = r.id ?? r.index; }
    for (const f of ['t', 'over', 'angle', 'by', 'rise', 'lens', 'fov']) if (flags[f] != null) o[f] = num(flags[f]);
    if (flags.ease != null) o.ease = easeArg(flags.ease);
    if (flags.around != null) { const a = String(flags.around); o.around = /^-?[\d.]+,-?[\d.]+,-?[\d.]+$/.test(a) ? vec(a) : a; }
    if (o.edit == null && (flags['from-view'] || (o.t == null && !SHOT))) { // the playhead belongs to the active shot
      let cam = null;
      try { cam = await rpc('camera'); } catch (e) { if (flags['from-view']) throw e; }
      if (cam && o.t == null) o.t = cam.time;
      if (cam && flags['from-view']) o.from = { position: cam.position, target: cam.target, fov: cam.fov };
    }
    if (o.edit == null) o.t ??= 0;
    const r = (await op(o, `camera move: ${pos[0] || 'edit'}`)).results[0];
    out(`${r.edited ? 'changed ' : ''}${r.move} from ${r.from}s to ${r.to}s: keys ${r.keys.join(' → ')} (${r.path} path)`);
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
    for (const k of ['in', 'out']) if (flags[k] != null) o[k] = /^(none|off|null)$/i.test(String(flags[k])) ? null : num(flags[k]);
    if (flags.volume != null) o.volume = num(flags.volume);
    if (flags.mute != null) o.muted = bool(flags.mute);
    if (flags['show-beats'] != null) o.beats = bool(flags['show-beats']);
    if (Object.keys(o).length > 1) await op(o, pos[0] ? 'load audio' : 'edit audio');
    let info = null;
    if ((flags.fit || flags.beats) && SHOT) {
      const d = (await api('GET', '/api/doc')).doc;
      if (shotTimeline(d, SHOT) !== d.timeline) throw new Error(`--fit and --beats need the tab to play the audio: switch to the shot first (canvas shot ${SHOT})`);
    }
    if (flags.fit || flags.beats) info = await rpc('audio', { beats: !!flags.beats }, 60000); // the tab decodes it (and records its length)
    if (flags.fit) await op({ op: 'audio', fit: true }, 'fit shot to audio');
    const d = (await api('GET', '/api/doc')).doc, a = shotTimeline(d, SHOT ?? undefined);
    if (!d.audio) return out('no audio on the timeline (load one: canvas audio song.mp3)');
    if (flags.beats && flags.json) return out(info);
    const lines = [`${audioLine(d.audio)} (file ${d.audio.file}${d.audio.length ? '' : ', length not read yet'}); shot ${a.duration}s from ${a.start || 0}s of the action`];
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
  async inspect({ pos, flags }) {
    const ids = pos.flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    if (!ids.length) throw new Error('usage: canvas inspect <ids or a prefix such as van-> [--close van-grille]');
    const close = flags.close && flags.close !== true ? String(flags.close).split(',').map((x) => x.trim()).filter(Boolean) : [];
    const r = await rpc('inspect', { ids, close, t: flags.t != null ? num(flags.t) : undefined, width: flags.width && num(flags.width), figure: flags.figure !== false, shot: SHOT ?? undefined }, 120000);
    const lines = [copyOut(r.path, flags.out),
      `${r.objects} objects, ${r.size.join(' × ')} m (x × y × z), lowest point y=${r.lowest}; views: ${r.views.join(', ')}`];
    if (r.floating?.length) lines.push(`may be floating (touch nothing below them): ${r.floating.map((f) => `${f.id} (${f.gap} m up)`).join(', ')}`);
    if (r.sunk?.length) lines.push(`below the ground: ${r.sunk.map((f) => `${f.id} (${f.depth} m down)`).join(', ')}`);
    if (r.review) lines.push(`high detail review: this is pass ${r.review.pass} (at least ${r.review.min}). Open the PNG, then: canvas review "what is wrong | …" (or "no problems"), fix it, and inspect again.`);
    else lines.push('open the PNG with your Read tool and check every view');
    out(lines.join('\n'));
  },
  async review({ pos, flags }) {
    const body = { reply: flags.reply && flags.reply !== true ? String(flags.reply) : undefined };
    if (flags.skip != null) body.skip = flags.skip;
    else body.found = pos.join(' ');
    const r = await api('POST', '/api/review', body);
    if (r.skipped) return out('review ended (skipped); now reply with canvas say');
    out(`pass ${r.pass}: ${r.clean ? 'no problems' : `${r.found} to fix`}. ${r.done ? 'You can finish: canvas say --reply <id> "…"' : `Next: ${r.next}`}`);
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
    const items = [...chat.prompts.map((p) => ({ at: p.at, who: 'user', text: p.text, images: p.images, models: p.models })), ...chat.messages.map((m) => ({ at: m.at, who: m.from || 'agent', text: m.text, files: m.files }))]
      .sort((a, b) => a.at - b.at);
    out([`${chat.title}  (${when(chat.startedAt)} to ${when(chat.endedAt)})`, '',
      ...items.map((x) => `${x.who}: ${x.text || ''}${x.images?.length ? ` [images: ${x.images.map((i) => i.path).join(' | ')}]` : ''}${x.models?.length ? ` [models: ${x.models.map((i) => i.path).join(' | ')}]` : ''}${x.files?.length ? ` [attached: ${x.files.map((i) => i.path).join(' | ')}]` : ''}`)].join('\n'));
  },
  async say({ pos, flags }) {
    const text = pos.join(' ');
    const attach = flags.attach && flags.attach !== true ? String(flags.attach).split(',').map((f) => f.trim()).filter(Boolean) : [];
    if (!text && !attach.length) throw new Error('usage: canvas say "message" [--reply <promptId>] [--attach file.mp4]');
    const files = [];
    for (const f of attach) {
      const file = path.resolve(f);
      if (!fs.existsSync(file)) throw new Error(`no such file: ${f}`);
      const res = await fetch(`${BASE}/api/chat/file?name=${encodeURIComponent(path.basename(file))}`, { method: 'POST', body: fs.readFileSync(file) })
        .catch(() => { throw new Error(`canvas server is not running at ${BASE}`); });
      const up = await res.json();
      if (!up.ok) throw new Error(up.error);
      files.push({ file: up.file, name: up.name });
    }
    await api('POST', '/api/say', { text, files, reply: flags.reply, done: !flags.working, kind: flags.kind || (flags.working ? 'working' : 'info') });
    out(files.length ? `sent with ${files.length} attachment${files.length === 1 ? '' : 's'}` : 'sent');
  },
  async ask({ pos, flags }) {
    let card;
    const src = pos.join(' ');
    if (src === '-') card = JSON.parse(await readStdin());
    else if (/^\s*[[{]/.test(src)) card = JSON.parse(src);
    else if (pos.length === 1 && /\.json$/i.test(src) && fs.existsSync(src)) card = JSON.parse(fs.readFileSync(src, 'utf8'));
    else if (src) {
      const q = { id: 'answer', q: src };
      if (flags.options && flags.options !== true) { q.options = String(flags.options).split('|').map((x) => x.trim()).filter(Boolean); if (flags.multi) q.multi = true; if (flags.other) q.other = flags.other; }
      else if (flags.images) q.type = 'images';
      else if (flags.secret && flags.secret !== true) { q.type = 'secret'; q.name = String(flags.secret); }
      else if (flags.review && flags.review !== true) { q.type = 'review'; q.file = String(flags.review); }
      if (flags.optional) q.optional = true;
      if (flags.note && flags.note !== true) q.note = String(flags.note);
      card = { questions: [q] };
    } else throw new Error('usage: canvas ask <card.json | - | \'{"questions":[…]}\'>   or   canvas ask "Question?" --options "A|B"');
    if (Array.isArray(card)) card = { questions: card };
    if (flags.title && flags.title !== true) card.title = String(flags.title);
    // a review question can name the file to show ("file": "prompt.txt") instead of carrying the text
    for (const q of card.questions || []) if (q && q.file && q.body == null) {
      if (!fs.existsSync(q.file)) throw new Error(`question "${q.id || q.q}": no such file: ${q.file}`);
      q.body = fs.readFileSync(q.file, 'utf8'); q.type ||= 'review';
    }
    normalizeAsk(card); // fail here with a clear message, before anything shows in the chat
    const r = await api('POST', '/api/ask', { ...card, reply: flags.reply });
    out(`asked ${r.questions} question${r.questions === 1 ? '' : 's'} (${r.id}). The answers arrive as the next canvas prompt: end your turn, or run "canvas wait".`);
  },
  async progress({ pos, flags }) {
    const body = {};
    const title = pos.join(' ');
    if (flags.id && flags.id !== true) body.id = String(flags.id);
    if (title && !body.id) body.title = title; else if (title) body.note = title; // on an update, loose words are the note
    if (flags.title && flags.title !== true) body.title = String(flags.title);
    if (flags.steps && flags.steps !== true) body.steps = String(flags.steps).split('|').map((x) => x.trim()).filter(Boolean);
    if (flags.step != null && flags.step !== true) body.step = num(flags.step);
    if (flags.pct != null && flags.pct !== true) body.pct = num(flags.pct);
    if (flags.eta != null && flags.eta !== true) body.eta = num(flags.eta);
    if (flags.note != null && flags.note !== true) body.note = String(flags.note);
    if (flags.done) { body.state = 'done'; if (flags.done !== true) body.note = String(flags.done); }
    if (flags.fail) { body.state = 'failed'; if (flags.fail !== true) body.note = String(flags.fail); }
    if (!body.id && !body.title) throw new Error('usage: canvas progress "Rendering on Comfy Cloud" [--steps "Upload|Queue|Render|Download"] [--eta 240]   then: canvas progress --id <id> --step 2 | --pct 40 | --done | --fail "why"');
    const r = await api('POST', '/api/progress', body);
    out(body.id ? `${r.id} ${r.progress.state}${r.progress.steps ? ` (${r.progress.steps[r.progress.step - 1]}, ${r.progress.step} of ${r.progress.steps.length})` : ''}` : r.id);
  },
  async secret() {
    const argv = process.argv.slice(3);
    const sub = argv[0];
    if (sub === 'list' || !sub) {
      const all = listSecrets();
      return out(all.length ? all.map((x) => `${x.name}  saved ${x.savedAt ? new Date(x.savedAt).toISOString().slice(0, 10) : '?'}`).join('\n') : 'no keys saved yet (ask for one with a key block: canvas ask "…" --secret NAME)');
    }
    if (sub === 'rm') {
      if (!argv[1]) throw new Error('usage: canvas secret rm NAME');
      return out(removeSecret(argv[1]) ? `removed ${argv[1]}` : `no key named ${argv[1]}`);
    }
    if (sub === 'path') return out(secretsPath());
    if (sub !== 'run') throw new Error('usage: canvas secret list | rm NAME | run NAME[,NAME2] -- <command …>');
    const dash = argv.indexOf('--');
    const names = (argv[1] || '').split(',').filter(Boolean);
    const command = dash >= 0 ? argv.slice(dash + 1) : [];
    if (!names.length || dash !== 2 || !command.length) throw new Error('usage: canvas secret run NAME[,NAME2] -- <command …>');
    const all = readSecrets();
    const env = { ...process.env };
    const hide = [];
    for (const n of names) {
      if (!all[n]?.value) throw new Error(`no key named ${n} is saved. Ask the user for it with a key block: canvas ask "…" --secret ${n}`);
      env[n] = all[n].value; hide.push([all[n].value, `[${n} hidden]`]);
    }
    // The command's output goes back to the agent, so the values are masked in it, line by line.
    const mask = (text) => hide.reduce((t, [v, label]) => t.split(v).join(label), text);
    const child = spawn(command[0], command.slice(1), { env, stdio: ['inherit', 'pipe', 'pipe'] });
    const pipe = (from, to) => { let buf = ''; from.setEncoding('utf8'); from.on('data', (d) => { buf += d; const i = buf.lastIndexOf('\n'); if (i >= 0) { to.write(mask(buf.slice(0, i + 1))); buf = buf.slice(i + 1); } }); from.on('end', () => { if (buf) to.write(mask(buf)); }); };
    pipe(child.stdout, process.stdout); pipe(child.stderr, process.stderr);
    const code = await new Promise((res, rej) => { child.on('error', (e) => rej(new Error(`could not run ${command[0]}: ${e.message}`))); child.on('close', (c) => res(c ?? 1)); });
    process.exitCode = code;
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
  async 'save-rm'({ pos }) {
    if (!pos[0]) throw new Error('usage: canvas save-rm <name>   (canvas saves lists them)');
    const r = await api('POST', '/api/save/delete', { name: pos.join(' ') });
    out(`deleted save "${r.name}" (moved to ${r.moved})${r.current ? '; the open scene is unchanged but no longer autosaves anywhere until you save it again' : ''}`);
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
      // A job this session started (a render) is still shown as running: it may not go idle on it. The
      // user is watching that card, and nothing else would tell them when it finishes.
      if (!r?.prompt && st.jobs) {
        const jobs = (await api('GET', '/api/jobs', undefined, { quietFail: true }))?.jobs || [];
        const review = jobs.find((j) => j.review);
        if (review) {
          out({ decision: 'block', reason: `High detail review still open for canvas prompt ${review.review} (${review.passes} pass${review.passes === 1 ? '' : 'es'} so far). The user is watching its Review card. Carry on: canvas inspect <prefix> → open the PNG → canvas review "what is wrong | …" (or "no problems") → fix → inspect again, until a pass after your last change finds nothing (at least 2 passes). Then canvas say --reply ${review.review} "<what you built>". If you truly cannot finish, canvas review --skip "why" and say so.` });
          return;
        }
        if (jobs.length) {
          const list = jobs.map((j) => `${j.id} "${j.auto ? j.note : j.title}" (started ${Math.round((Date.now() - j.startedAt) / 60000)} min ago)`).join('; ');
          out({ decision: 'block', reason: `The canvas chat still shows you as working: ${list}. The user is watching that card and nothing else will tell them when the work finishes, so do not stop yet. Check on it now (for a render: the job's status); if it is still running, wait about 20 seconds and check again. When it has finished, save and show the result (canvas say --attach <file> "…"); if it failed or was cancelled, say why (canvas say "…"). A card you started with canvas progress also needs ending (canvas progress --id <id> --done "…" or --fail "…"); a "Working" card ends with your reply. Only then end your turn.` });
          return;
        }
      }
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
