// Blockout bridge server. Zero dependencies.
//
// - serves the app (app/, core/, three.js and mediabunny from node_modules)
// - owns the scene document: applies ops, keeps undo history, persists to scene.json
// - pushes changes and RPC calls to browser tabs over Server-Sent Events
// - queues prompts typed in the canvas so the user's agent can pick them up (canvas wait)
// - stores snapshots and exported videos under exports/

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { normalizeAsk, answerAsk } from '../core/ask.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { applyOps, createDoc, migrate, describe, shotList, AUDIO_FILE, MODEL_FILE } from '../core/doc.js';
import crypto from 'node:crypto';
import { dataDir } from './paths.mjs';
import { saveSecret, listSecrets } from './secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How this server was started, so the empty chat can say the right next step: by Claude Code (its Bash
 * tool sets CLAUDECODE), by Codex (CODEX_* variables), or by hand from a terminal; whether the
 * blockout plugin is installed (so /blockout:start works); and whether this is a git checkout
 * (so "listen to the canvas" works for an agent started in it, through the repo's own hooks).
 */
export function launchInfo(env = process.env, root = ROOT) {
  const by = env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID ? 'claude' : Object.keys(env).some((k) => k.startsWith('CODEX_')) ? 'codex' : 'terminal';
  let plugin = !!env.CLAUDE_PLUGIN_ROOT || root.split(path.sep).join('/').includes('/.claude/plugins/');
  if (!plugin) {
    try { plugin = fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'installed_plugins.json'), 'utf8').includes('"blockout@'); } catch {}
  }
  // the folder as the user would type it: ~/... when it is under home and needs no quoting
  const home = os.homedir(), rel = root.startsWith(home + path.sep) ? root.slice(home.length + 1) : null;
  const dir = rel && /^[\w./-]+$/.test(rel) ? `~/${rel}` : /^[\w./-]+$/.test(root) ? root : JSON.stringify(root);
  return { by, plugin, checkout: fs.existsSync(path.join(root, '.git')), root, dir };
}

// How a camera key's segment travels, for ls: " → orbit 90° around car-1".
const pathNote = (k) => {
  const p = k.path;
  if (!p) return '';
  const deg = p.angle ? ` ${p.angle}°` : '';
  if (p.type === 'orbit') return ` → orbit${deg} around ${p.around || (p.center || k.target).join(',')}`;
  const by = p.move && p.move !== p.type && p.move !== 'pan' && p.move !== 'tilt' ? ` (${p.move}${p.params?.by != null ? ` ${p.params.by}m` : ''}${p.params?.lens != null ? ` ${p.params.lens}mm` : ''}${p.params?.angle != null ? ` ${p.params.angle}°` : ''})` : '';
  if (p.type === 'turn') return ` → turn${deg}${p.move === 'tilt' ? ' (tilt)' : ''}`;
  return ` → ${p.type}${by}`;
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary',
};

/**
 * What a GLB holds, read from its JSON chunk without loading it: clip names and lengths, and the height of its
 * meshes above the origin (their bind pose; node transforms are not applied). Null if it is not a GLB.
 */
export function glbInfo(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF' || buf.readUInt32LE(16) !== 0x4e4f534a) return null;
  const j = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
  const acc = j.accessors || [];
  const clips = (j.animations || []).map((a, i) => ({
    name: a.name || `clip ${i + 1}`,
    length: Math.round(Math.max(0, ...a.samplers.map((s) => acc[s.input]?.max?.[0] ?? 0)) * 1000) / 1000,
  }));
  let top = null;
  for (const m of j.meshes || []) for (const p of m.primitives || []) {
    const y = acc[p.attributes?.POSITION]?.max?.[1];
    if (Number.isFinite(y)) top = Math.max(top ?? y, y);
  }
  return { clips, height: top == null ? null : Math.round(top * 1000) / 1000, meshes: (j.meshes || []).length, skins: (j.skins || []).length };
}

export function startServer({ port = 5317, host = '127.0.0.1', scene, quiet = false } = {}) {
  const scenePath = path.resolve(scene || process.env.CANVAS_SCENE || path.join(dataDir(), 'scenes', 'scene.json'));
  const workDir = path.join(path.dirname(scenePath), '.canvas');
  const exportsDir = path.resolve(process.env.CANVAS_EXPORTS || path.join(path.dirname(scenePath), 'exports'));
  const savesDir = path.join(path.dirname(scenePath), 'saved');
  const uploadsDir = path.join(workDir, 'uploads');
  const audioDir = path.join(path.dirname(scenePath), 'audio'); // the timeline's audio tracks, shared by every save
  const modelsDir = path.join(path.dirname(scenePath), 'models'); // imported GLBs (model objects), shared by every save
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  const inboxPath = path.join(workDir, 'inbox.jsonl');
  const logPath = path.join(workDir, 'log.jsonl');
  const log = (...a) => { if (!quiet) console.log('[canvas]', ...a); };

  // ---------- document ----------
  let doc;
  try { doc = migrate(JSON.parse(fs.readFileSync(scenePath, 'utf8'))); }
  catch (e) {
    if (fs.existsSync(scenePath)) log(`could not read ${scenePath} (${e.message}); starting a new scene`);
    doc = createDoc();
  }
  let rev = 0;
  const undo = [], redo = [];
  let lastWritten = '';
  const persist = () => {
    const text = JSON.stringify(doc, null, 2) + '\n';
    lastWritten = text;
    fs.mkdirSync(path.dirname(scenePath), { recursive: true });
    fs.writeFileSync(scenePath + '.tmp', text);
    fs.renameSync(scenePath + '.tmp', scenePath);
    scheduleAutosave();
  };
  // Autosave into the named version you are on (scenes/saved/<meta.name>.json), so a saved version never goes stale.
  let autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      const n = doc.meta?.name;
      if (!n || n === 'untitled' || !/^[a-z0-9._-]+$/.test(n)) return;
      const file = path.join(savesDir, `${n}.json`);
      if (!fs.existsSync(file)) return; // only versions that were saved once
      try {
        fs.writeFileSync(file, JSON.stringify({ ...doc, meta: { ...doc.meta, savedAs: n, savedAt: new Date().toISOString() } }, null, 2) + '\n');
        broadcast('saves', { saves: listSaves() });
      } catch (e) { console.error(`[canvas] autosave to ${file} failed: ${e.message}`); }
    }, 800);
  }
  persist();

  // amend: a bookkeeping change (e.g. the browser recording an audio file's length) that is not an undo step
  function commit(next, source, label, { amend = false } = {}) {
    if (!amend) {
      undo.push(doc); if (undo.length > 200) undo.shift();
      redo.length = 0;
    }
    doc = next; rev++;
    persist();
    broadcast('doc', { doc, rev, source, label });
    if (!amend) reviewDocChanged();
  }

  // Agents may also edit scene.json by hand: pick that up.
  fs.watchFile(scenePath, { interval: 400 }, () => {
    let text;
    try { text = fs.readFileSync(scenePath, 'utf8'); } catch { return; }
    if (text === lastWritten) return;
    try {
      const next = migrate(JSON.parse(text));
      log('scene.json changed on disk, reloading');
      commit(next, 'file', 'edit scene.json');
    } catch (e) {
      broadcast('say', { from: 'system', text: `scene.json has an error and was not loaded: ${e.message}`, kind: 'error', at: Date.now() });
    }
  });

  // Reload open tabs when the agent edits the app (new controls etc.).
  let reloadTimer;
  for (const dir of ['app', 'core']) {
    try {
      fs.watch(path.join(ROOT, dir), { recursive: true }, () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => broadcast('reload', { at: Date.now() }), 250);
      });
    } catch {}
  }

  // ---------- named saves ----------
  const saveName = (s) => {
    const n = String(s || '').trim().toLowerCase().replace(/\.json$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    if (!n) throw Object.assign(new Error('a save needs a name'), { status: 400 });
    return n.slice(0, 80);
  };
  function listSaves() {
    let files = [];
    try { files = fs.readdirSync(savesDir).filter((f) => f.endsWith('.json')); } catch { return []; }
    return files.map((f) => {
      const file = path.join(savesDir, f), name = f.slice(0, -5);
      let objects = 0, keys = 0, savedAt = null;
      try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); objects = d.objects?.length || 0; keys = d.timeline?.keys?.length || 0; savedAt = d.meta?.savedAt || null; } catch {}
      const mtime = fs.statSync(file).mtimeMs;
      const thumb = fs.existsSync(path.join(savesDir, `${name}.png`)) ? `/saved/${encodeURIComponent(name)}.png?v=${Math.round(mtime)}` : null;
      return { name, path: file, savedAt: savedAt || new Date(mtime).toISOString(), objects, keys, thumb };
    }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  // ---------- event stream ----------
  const clients = new Map(); // id -> { res, connectedAt, lastSeen, visible }
  function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function broadcast(event, data) { for (const c of clients.values()) send(c.res, event, data); }
  setInterval(() => { for (const c of clients.values()) c.res.write(': ping\n\n'); }, 15000).unref();

  function pickClient() {
    const list = [...clients.entries()];
    if (!list.length) return null;
    list.sort((a, b) => (b[1].visible - a[1].visible) || (b[1].lastSeen - a[1].lastSeen));
    return list[0];
  }

  // ---------- RPC to the browser ----------
  const pending = new Map(); // rpc id -> { resolve, reject, timer }
  let rpcSeq = 0;
  function rpc(method, params = {}, timeoutMs = 30000) {
    const target = pickClient();
    if (!target) return Promise.reject(Object.assign(new Error(`no canvas tab is open. Open http://${host}:${port} (or run: canvas open)`), { status: 409 }));
    const id = `r${++rpcSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send(target[1].res, 'rpc', { id, method, params });
    });
  }

  // ---------- prompt inbox ----------
  let prompts = [];
  try { prompts = fs.readFileSync(inboxPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const savePrompts = () => fs.writeFileSync(inboxPath, prompts.map((p) => JSON.stringify(p)).join('\n') + (prompts.length ? '\n' : ''));
  const waiters = []; // long-polling agents
  let lastAgentPoll = 0;
  const listenPath = path.join(workDir, 'listen.json');
  // Listen mode belongs to one agent session (the one that turned it on), so a Stop hook installed for every
  // Claude Code session (the plugin) only ever holds that session open, never an unrelated one.
  let listen = false, listenSession = null, listenCwd = null;
  try { ({ on: listen, session: listenSession = null, cwd: listenCwd = null } = JSON.parse(fs.readFileSync(listenPath, 'utf8'))); listen = !!listen; } catch {}
  const agentListening = () => waiters.length > 0 || Date.now() - lastAgentPoll < 3000;
  // "Working" while the agent holds a prompt. In listen mode the agent comes back to poll as soon as it
  // finishes (the Stop hook or `canvas wait`), so a taken prompt means it is still busy, even while it is
  // only thinking and touching nothing; give up after 30 minutes in case the session was closed. Without
  // listen mode, fall back to 2 minutes since the last thing the agent did.
  let lastAgentActivity = 0;
  const touchAgent = () => { lastAgentActivity = Date.now(); };
  const agentWorking = () => {
    const taken = prompts.filter((p) => p.status === 'taken');
    if (!taken.length) return false;
    if (Date.now() - lastAgentActivity < 120000) return true;
    return listen && taken.some((p) => Date.now() - (p.takenAt || 0) < 30 * 60000);
  };
  // Listen mode stays on in listen.json after its session quits. Count it as live only while that agent
  // shows signs of life: polling now, holding a prompt, or active in the last two minutes (for example the
  // turn that turned listening on, before its first Stop hook polls).
  const listenLive = () => listen && (agentListening() || agentWorking() || Date.now() - Math.max(lastAgentActivity, lastAgentPoll) < 120000);
  const launch = launchInfo();
  const statusPayload = () => ({ agent: agentListening(), working: !agentListening() && agentWorking(), listen, listenLive: listenLive(), launch, listenSession, listenCwd, pid: process.pid, waiting: waiters.length, queued: prompts.filter((p) => p.status === 'pending').length, jobs: runningJobs().length, rev });
  let lastStatus = '';
  const pushStatus = () => { const s = JSON.stringify(statusPayload()); if (s !== lastStatus) { lastStatus = s; broadcast('status', statusPayload()); } };
  setInterval(pushStatus, 2000).unref();

  // The agent asking for the next prompt means it has finished the ones it already took.
  function closeTaken() {
    for (const p of prompts) {
      if (p.status !== 'taken') continue;
      p.status = 'done'; p.doneAt = Date.now(); p.autoClosed = true;
      broadcast('prompt', p);
    }
    savePrompts();
  }

  function takePrompt() {
    const p = prompts.find((x) => x.status === 'pending');
    if (!p) return null;
    p.status = 'taken'; p.takenAt = Date.now();
    savePrompts();
    broadcast('prompt', p);
    startReview(p);
    return p;
  }
  function deliverToWaiters() {
    while (waiters.length && prompts.some((p) => p.status === 'pending')) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.resolve(takePrompt());
    }
    pushStatus();
  }
  const progress = new Map(); // progress card id -> its latest state
  for (const m of readTail(logPath, Infinity)) if (m.kind === 'progress' && m.progress) progress.set(m.progress.id, m.progress);
  // Jobs the agent started and has not ended. The Stop hook uses this so a session cannot go idle on a
  // running job and leave its result unreported. One with no update for two hours is taken as abandoned.
  const postProgress = (p) => {
    progress.set(p.id, p);
    const entry = { from: 'agent', kind: 'progress', text: p.title, progress: p, at: p.updatedAt };
    appendLog(entry);
    broadcast('say', entry);
  };
  // "Still working" (canvas say --working) is a promise to come back. It becomes a card with a clock, and
  // counts as a running job until the agent's next real reply or question, so the Stop hook holds it to that.
  const autoCards = () => [...progress.values()].filter((p) => p.auto && p.state === 'running');
  const stillWorking = (text) => {
    const now = Date.now(), note = String(text).trim().slice(0, 200);
    const mine = autoCards()[0];
    if (!mine && runningJobs().length) return false; // the agent keeps its own card: leave the message as it is
    postProgress(mine ? { ...mine, note, updatedAt: now } : { id: `g${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`, title: 'Working', note, state: 'running', auto: true, startedAt: now, updatedAt: now });
    return true;
  };
  const endAutoCards = () => { const now = Date.now(); for (const p of autoCards()) postProgress({ ...p, state: 'done', endedAt: now, updatedAt: now }); };
  const runningJobs = () => [...progress.values()].filter((p) => p.state === 'running' && Date.now() - (p.updatedAt || p.startedAt) < 2 * 3600000)
    .map((p) => ({ id: p.id, title: p.title, ...(p.auto ? { auto: true, note: p.note } : {}), ...(p.review ? { review: p.review.prompt, passes: p.review.passes.length } : {}), startedAt: p.startedAt, updatedAt: p.updatedAt || p.startedAt }));

  // ---------- high detail: build, then review from every side until a look finds nothing ----------
  // A prompt sent with the composer's "High detail" pill gets a Review card when the agent takes it. Each
  // `canvas inspect` adds a pass (its sheet shows on the card), `canvas review "…"` records what the agent saw
  // on it, and the agent's final reply is refused until there are MIN_PASSES passes, each one written up,
  // and the last one came after the last change to the scene. The card counts as a running job, so the
  // Stop hook will not let the session go idle half way. `canvas review --skip "why"` is the honest way out.
  const MIN_PASSES = 2;
  const REVIEW_STEPS = ['Plan', 'Build', 'Review', 'Done'];
  // rev restarts at 0 with the server: an open review then needs a fresh look before it can finish
  for (const p of progress.values()) if (p.review && p.state === 'running') { p.review.startRev = -1; for (const x of p.review.passes) x.rev = -1; }
  const reviewCards = () => [...progress.values()].filter((p) => p.review && p.state === 'running');
  const reviewFor = (promptId) => reviewCards().find((p) => p.review.prompt === promptId);
  const reviewUpdate = (p, patch) => postProgress({ ...p, ...patch, review: { ...p.review, ...(patch.review || {}) }, updatedAt: Date.now() });
  function startReview(pr) {
    if (pr.detail !== 'high' || reviewFor(pr.id)) return;
    endAutoCards();
    const now = Date.now();
    postProgress({ id: `g${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`, title: 'High detail', state: 'running', steps: REVIEW_STEPS, step: 1, note: 'Planning the parts', review: { prompt: pr.id, startRev: rev, passes: [] }, startedAt: now, updatedAt: now });
  }
  function reviewDocChanged() {
    for (const p of reviewCards()) {
      const passes = p.review.passes, last = passes.at(-1);
      const note = !last ? 'Building' : `Fixing what pass ${passes.length} found`;
      const step = last ? 3 : 2;
      if (note !== p.note || step !== p.step) reviewUpdate(p, { step, note });
    }
  }
  function recordInspect(result) {
    const cards = reviewCards();
    for (const p of cards) {
      const passes = [...p.review.passes, { n: p.review.passes.length + 1, at: Date.now(), rev, url: result.url, path: result.path, views: result.views?.length || 0, floating: result.floating?.length || 0, found: null }];
      reviewUpdate(p, { step: 3, note: `Pass ${passes.length} · looking from ${result.views?.length || 6} angles`, review: { passes } });
    }
  }
  // Why the agent may not finish this review yet, or null when it may.
  function reviewBlock(p) {
    const r = p.review, passes = r.passes, last = passes.at(-1);
    if (rev === r.startRev) return null; // nothing was built or changed (a question, an answer): no review to do
    const how = 'canvas inspect <ids or prefix> (open the PNG it prints), then canvas review "what is wrong | …" (or "no problems"), fix it, and inspect again';
    if (passes.length < MIN_PASSES) return `high detail: ${passes.length} review pass${passes.length === 1 ? '' : 'es'} so far, at least ${MIN_PASSES} are needed. Run ${how}.`;
    const unwritten = passes.filter((x) => !x.found).map((x) => x.n);
    if (unwritten.length) return `high detail: write up what you saw on pass ${unwritten.join(', ')}: canvas review "what is wrong | …" (or "no problems"). Then fix it and inspect again.`;
    if (last.rev !== rev) return `high detail: the scene changed after your last look (pass ${last.n}). Inspect again and write it up (${how}) so the last pass checks your fixes.`;
    return null;
  }
  function endReview(p, note, state = 'done') {
    const now = Date.now();
    reviewUpdate(p, { state, step: REVIEW_STEPS.length, note, endedAt: now });
  }
  const reviewSummary = (p) => {
    const passes = p.review.passes, fixes = passes.reduce((n, x) => n + (x.found?.length || 0), 0);
    return passes.length ? `${passes.length} review pass${passes.length === 1 ? '' : 'es'} · ${fixes} fix${fixes === 1 ? '' : 'es'}` : 'No changes to review';
  };
  function appendLog(entry) { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); }

  // ---------- chat history ----------
  // "New chat" archives the finished conversation (your prompts and the agent's replies) to
  // .canvas/chats/<id>.json, so past chats can be read again in the chat panel or with `canvas chats`.
  const chatsDir = path.join(workDir, 'chats');
  const CURRENT = 100; // messages of each kind the open chat shows
  const chatTitle = (ps, ms) => {
    const first = ps.find((p) => p.text?.trim()) || ms.find((m) => m.text?.trim());
    const t = (first?.text || (ps.length ? 'Images' : 'Chat')).trim().replace(/\s+/g, ' ');
    return t.length > 80 ? `${t.slice(0, 79)}…` : t;
  };
  function archiveChat(ps, ms, id = String(Date.now())) {
    if (!ps.length && !ms.length) return null;
    const ats = [...ps, ...ms].map((x) => x.at).filter(Number.isFinite);
    const chat = { id, title: chatTitle(ps, ms), startedAt: Math.min(...ats, Date.now()), endedAt: Math.max(...ats, 0) || Date.now(), prompts: ps, messages: ms };
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, `${id}.json`), JSON.stringify(chat) + '\n');
    return chat;
  }
  // Earlier versions kept only the agent's side of an old chat, as .canvas/log-<time>.jsonl: move those in.
  try {
    for (const f of fs.readdirSync(workDir)) {
      const m = /^log-(\d+)\.jsonl$/.exec(f);
      if (!m) continue;
      archiveChat([], readTail(path.join(workDir, f), Infinity), m[1]);
      fs.unlinkSync(path.join(workDir, f));
    }
  } catch {}
  const readChat = (id) => {
    if (!/^[\w-]+$/.test(String(id || ''))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(chatsDir, `${id}.json`), 'utf8')); } catch { return null; }
  };
  function listChats() {
    let files = [];
    try { files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json')); } catch {}
    return files.map((f) => readChat(f.slice(0, -5))).filter(Boolean)
      .map(({ id, title, startedAt, endedAt, prompts: ps = [], messages: ms = [] }) => ({ id, title, startedAt, endedAt, count: ps.length + ms.length }))
      .sort((a, b) => b.endedAt - a.endedAt);
  }
  // A progress card is logged once per update. The open chat gets each card once: its latest state, at the
  // place in the conversation where it first appeared.
  const foldProgress = (ms) => {
    const last = new Map(), first = new Map();
    for (const m of ms) if (m.kind === 'progress' && m.progress) { last.set(m.progress.id, m); if (!first.has(m.progress.id)) first.set(m.progress.id, m.at); }
    return ms.flatMap((m) => (m.kind !== 'progress' || !m.progress ? [m] : first.get(m.progress.id) === m.at && last.has(m.progress.id) ? (() => { const l = last.get(m.progress.id); last.delete(m.progress.id); return [{ ...l, at: m.at }]; })() : []));
  };
  const currentChat = () => ({ prompts: prompts.slice(-CURRENT), messages: foldProgress(readTail(logPath, Infinity)).slice(-CURRENT) });

  // ---------- http ----------
  const readBody = (req, limit = 512 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJson = async (req) => { const b = await readBody(req, 50 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {}; };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  // Files are served whole, or in part for a Range request: video players need ranges to seek (Safari to play at all).
  async function serveFile(res, file, req) {
    try {
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const m = /^bytes=(\d*)-(\d*)$/.exec(req?.headers.range || '');
      if (m && (m[1] || m[2])) {
        const { size } = await fsp.stat(file);
        let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { 'content-type': type, 'cache-control': 'no-cache', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'accept-ranges': 'bytes' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
  const within = (base, rel) => { const f = path.resolve(base, '.' + path.sep + rel); return f.startsWith(base + path.sep) || f === base ? f : null; };

  // What a chat reply can carry, and how the chat shows it.
  const CHAT_FILE = { '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image' };
  const chatFile = (file, name) => ({ file, name: name || file.replace(/^[a-z0-9]+-[a-f0-9]{6}-/, ''), type: CHAT_FILE[path.extname(file).toLowerCase()], url: `/uploads/${file}`, path: path.join(uploadsDir, file) });

  const STATIC = [
    ['/vendor/three/', path.join(ROOT, 'node_modules', 'three')],
    ['/core/', path.join(ROOT, 'core')],
    ['/exports/', exportsDir],
    ['/saved/', savesDir],
    ['/uploads/', uploadsDir],
    ['/audio/', audioDir],
    ['/models/', modelsDir],
    ['/', path.join(ROOT, 'app')],
  ];

  const routes = {
    'GET /api/doc': (req, res) => json(res, 200, { rev, doc }),
    'GET /api/summary': (req, res) => {
      const tl = doc.timeline;
      json(res, 200, {
        rev, scene: scenePath, exports: exportsDir, ...statusPayload(), tabs: clients.size,
        meta: doc.meta, env: doc.env,
        objects: doc.objects.map(describe),
        timeline: { duration: tl.duration, fps: tl.fps, interp: tl.interp, speed: tl.speed, start: tl.start || 0 },
        audio: doc.audio || null,
        shot: doc.shot,
        shots: shotList(doc).map((s) => ({ id: s.id, name: s.name, active: s.active, duration: s.timeline.duration, fps: s.timeline.fps, start: s.timeline.start || 0, keys: s.timeline.keys.length })),
        keys: tl.keys.map((k) => `${k.id} t=${k.t} pos=${k.position.join(',')} target=${k.target.join(',')} fov=${k.fov}${k.roll ? ` roll=${k.roll}` : ''} ease=${JSON.stringify(k.ease)}${pathNote(k)}${k.shudder ? ` shudder=${k.shudder.jerks} ${k.shudder.shape}s, ${k.shudder.amount}% back, ${k.shudder.over}${k.shudder.from != null || k.shudder.to != null ? `, from ${k.shudder.from ?? 0} to ${k.shudder.to ?? 1} of the segment` : ''}` : ''}`),
      });
    },
    'GET /api/jobs': (req, res) => json(res, 200, { ok: true, jobs: runningJobs() }),
    'GET /api/status': (req, res) => json(res, 200, { ...statusPayload(), tabs: clients.size, scene: scenePath, exports: exportsDir }),

    'POST /api/op': async (req, res) => {
      const body = await readJson(req);
      const ops = body.ops ?? body;
      if (body.source !== 'ui') touchAgent();
      try {
        const { doc: next, results } = applyOps(doc, ops);
        commit(next, body.source || 'agent', body.label || [].concat(ops).map((o) => o.op).join(', '), { amend: !!body.amend });
        json(res, 200, { ok: true, rev, results });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    },
    'POST /api/undo': (req, res) => {
      if (!undo.length) return json(res, 200, { ok: false, error: 'nothing to undo' });
      redo.push(doc); doc = undo.pop(); rev++; persist(); reviewDocChanged();
      broadcast('doc', { doc, rev, source: 'undo' });
      json(res, 200, { ok: true, rev });
    },
    'POST /api/redo': (req, res) => {
      if (!redo.length) return json(res, 200, { ok: false, error: 'nothing to redo' });
      undo.push(doc); doc = redo.pop(); rev++; persist(); reviewDocChanged();
      broadcast('doc', { doc, rev, source: 'redo' });
      json(res, 200, { ok: true, rev });
    },

    // ----- named saves: scenes/saved/<name>.json (+ optional <name>.png thumbnail) -----
    'GET /api/saves': (req, res) => json(res, 200, { ok: true, dir: savesDir, saves: listSaves() }),
    'POST /api/save': async (req, res) => {
      const { name, overwrite } = await readJson(req);
      const n = saveName(name || `scene-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`);
      const file = path.join(savesDir, `${n}.json`);
      if (fs.existsSync(file) && !overwrite) return json(res, 409, { ok: false, error: `a save called "${n}" already exists (overwrite it, or pick another name)`, exists: true, name: n });
      fs.mkdirSync(savesDir, { recursive: true });
      // the scene takes the save's name (shown in the Scenes menu, used for export file names); not an undo step
      if (doc.meta.name !== n) { doc = { ...doc, meta: { ...doc.meta, name: n } }; rev++; persist(); broadcast('doc', { doc, rev, source: 'save' }); }
      fs.writeFileSync(file, JSON.stringify({ ...doc, meta: { ...doc.meta, savedAs: n, savedAt: new Date().toISOString() } }, null, 2) + '\n');
      broadcast('saves', { saves: listSaves() });
      json(res, 200, { ok: true, name: n, path: file });
    },
    'POST /api/save/thumb': async (req, res, url) => {
      const n = saveName(url.searchParams.get('name'));
      if (!fs.existsSync(path.join(savesDir, `${n}.json`))) return json(res, 404, { ok: false, error: `no save "${n}"` });
      fs.writeFileSync(path.join(savesDir, `${n}.png`), await readBody(req, 5 * 1024 * 1024));
      broadcast('saves', { saves: listSaves() });
      json(res, 200, { ok: true });
    },
    // delete a save: its .json and thumbnail move to scenes/saved/.deleted/ (recoverable by hand, never listed).
    // The open scene is left as it is; if it was that save, it simply stops autosaving until saved again.
    'POST /api/save/delete': async (req, res) => {
      const { name } = await readJson(req);
      const n = saveName(name);
      const file = path.join(savesDir, `${n}.json`);
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: `no save "${n}" (saves: ${listSaves().map((s) => s.name).join(', ') || 'none'})` });
      const bin = path.join(savesDir, '.deleted');
      fs.mkdirSync(bin, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
      const moved = path.join(bin, `${n}-${stamp}.json`);
      fs.renameSync(file, moved);
      const png = path.join(savesDir, `${n}.png`);
      if (fs.existsSync(png)) fs.renameSync(png, moved.replace(/\.json$/, '.png'));
      broadcast('saves', { saves: listSaves() });
      json(res, 200, { ok: true, name: n, moved, current: doc.meta?.name === n });
    },
    'POST /api/load': async (req, res) => {
      const { name } = await readJson(req);
      const n = saveName(name);
      const file = path.join(savesDir, `${n}.json`);
      let next;
      try { next = migrate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch (e) { return json(res, e.code === 'ENOENT' ? 404 : 400, { ok: false, error: e.code === 'ENOENT' ? `no save "${n}" (saves: ${listSaves().map((s) => s.name).join(', ') || 'none'})` : `could not read ${n}: ${e.message}` }); }
      delete next.meta.savedAs; delete next.meta.savedAt;
      next.meta.name = n;
      commit(next, 'load', `load ${n}`); // undoable like any other change
      json(res, 200, { ok: true, name: n, rev, objects: next.objects.length, keys: next.timeline.keys.length });
    },

    'GET /api/events': (req, res, url) => {
      const id = url.searchParams.get('client') || `c${Date.now()}`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.set(id, { res, connectedAt: Date.now(), lastSeen: Date.now(), visible: true });
      send(res, 'doc', { doc, rev, source: 'connect' });
      send(res, 'status', statusPayload());
      send(res, 'history', currentChat());
      req.on('close', () => clients.delete(id));
    },
    'POST /api/presence': async (req, res) => {
      const { client, visible } = await readJson(req);
      const c = clients.get(client);
      if (c) { c.lastSeen = Date.now(); c.visible = !!visible; }
      json(res, 200, { ok: true });
    },

    'POST /api/rpc': async (req, res) => {
      const { method, params, timeout } = await readJson(req);
      touchAgent();
      try {
        const result = await rpc(method, params, timeout || 30000);
        if (method === 'inspect' && result?.path) {
          recordInspect(result);
          const p = reviewCards()[0];
          if (p) result.review = { pass: p.review.passes.length, min: MIN_PASSES };
        }
        json(res, 200, { ok: true, result });
      }
      catch (e) { json(res, e.status || 500, { ok: false, error: e.message }); }
    },
    'POST /api/rpc/result': async (req, res) => {
      const { id, result, error } = await readJson(req);
      const p = pending.get(id);
      if (p) { pending.delete(id); clearTimeout(p.timer); error ? p.reject(new Error(error)) : p.resolve(result); }
      json(res, 200, { ok: true });
    },

    // Browser uploads a rendered file (png / mp4 / webm).
    'POST /api/upload': async (req, res, url) => {
      const name = path.basename(url.searchParams.get('name') || `file-${Date.now()}`);
      const file = path.join(exportsDir, name);
      await fsp.writeFile(file, await readBody(req));
      let out = file;
      const tc = url.searchParams.get('transcode');
      if (tc === 'h264') out = transcodeH264(file) || file;
      else if (tc === 'aac') out = transcodeAac(file) || file;
      json(res, 200, { ok: true, path: out, url: `/exports/${path.basename(out)}` });
    },

    // An audio file for the timeline: saved under the scene folder's audio/ by a name made from the file's
    // name and content, so loading the same file twice reuses it. The caller then sets it with the audio op.
    'POST /api/audio': async (req, res, url) => {
      const orig = path.basename(url.searchParams.get('name') || 'audio.mp3');
      const ext = (path.extname(orig).toLowerCase() || '.mp3').slice(0, 6);
      const body = await readBody(req, 300 * 1024 * 1024);
      if (!body.length) return json(res, 400, { ok: false, error: 'empty audio file' });
      const stem = orig.slice(0, orig.length - path.extname(orig).length).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'audio';
      const file = `${stem}-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 8)}${ext}`;
      if (!AUDIO_FILE.test(file)) return json(res, 400, { ok: false, error: `unsupported audio type "${ext}" (use mp3, wav, m4a, aac, ogg, opus, flac or webm)` });
      fs.mkdirSync(audioDir, { recursive: true });
      fs.writeFileSync(path.join(audioDir, file), body);
      json(res, 200, { ok: true, file, name: orig, path: path.join(audioDir, file), url: `/audio/${file}`, bytes: body.length });
    },

    // A GLB for a model object: saved under the scene folder's models/ by a name made from the file's name and
    // content (the same file twice reuses it). The caller then adds it with { op: 'add', type: 'model', file }.
    'POST /api/model': async (req, res, url) => {
      const orig = path.basename(url.searchParams.get('name') || 'model.glb');
      const body = await readBody(req, 500 * 1024 * 1024);
      if (!body.length) return json(res, 400, { ok: false, error: 'empty model file' });
      let info;
      try { info = glbInfo(body); } catch (e) { return json(res, 400, { ok: false, error: `could not read the GLB: ${e.message}` }); }
      if (!info) return json(res, 400, { ok: false, error: 'not a GLB file (binary glTF 2.0, .glb)' });
      const stem = orig.slice(0, orig.length - path.extname(orig).length).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model';
      const file = `${stem}-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 8)}.glb`;
      if (!MODEL_FILE.test(file)) return json(res, 400, { ok: false, error: `bad model name "${file}"` });
      fs.mkdirSync(modelsDir, { recursive: true });
      fs.writeFileSync(path.join(modelsDir, file), body);
      json(res, 200, { ok: true, file, name: orig, path: path.join(modelsDir, file), url: `/models/${file}`, bytes: body.length, ...info });
    },

    // ----- prompts: canvas -> agent -----
    // Images for chat prompts: saved under .canvas/uploads so the agent can open them by path.
    'POST /api/chat/image': async (req, res) => {
      const { data, name } = await readJson(req);
      const m = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(String(data || ''));
      if (!m) return json(res, 400, { ok: false, error: 'expected a png, jpeg, webp or gif data URL' });
      fs.mkdirSync(uploadsDir, { recursive: true });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const stem = String(name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'image';
      const file = `${Date.now().toString(36)}-${stem}.${ext}`;
      fs.writeFileSync(path.join(uploadsDir, file), Buffer.from(m[2], 'base64'));
      json(res, 200, { ok: true, file, url: `/uploads/${file}`, path: path.join(uploadsDir, file) });
    },
    // A file the agent attaches to a chat reply (canvas say --attach): a video or an image, kept with the
    // chat's uploads so it plays in the thread and in past chats.
    'POST /api/chat/file': async (req, res, url) => {
      const orig = path.basename(url.searchParams.get('name') || 'file');
      const ext = path.extname(orig).toLowerCase();
      if (!CHAT_FILE[ext]) return json(res, 400, { ok: false, error: `cannot attach "${ext || orig}" (videos: mp4, webm, mov; images: png, jpg, webp, gif)` });
      const body = await readBody(req, 1024 * 1024 * 1024);
      if (!body.length) return json(res, 400, { ok: false, error: 'empty file' });
      fs.mkdirSync(uploadsDir, { recursive: true });
      const stem = orig.slice(0, orig.length - ext.length).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'file';
      const file = `${Date.now().toString(36)}-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 6)}-${stem}${ext}`;
      fs.writeFileSync(path.join(uploadsDir, file), body);
      json(res, 200, { ok: true, ...chatFile(file, orig) });
    },
    'POST /api/prompt': async (req, res) => {
      const { text, context, images, models, detail } = await readJson(req);
      const imgs = (Array.isArray(images) ? images : [])
        .map((f) => path.basename(String(f?.file || f)))
        .filter((f) => fs.existsSync(path.join(uploadsDir, f)))
        .slice(0, 8)
        .map((f) => ({ file: f, url: `/uploads/${f}`, path: path.join(uploadsDir, f) }));
      // GLBs dropped in the chat: already uploaded to models/ (POST /api/model) but not in the scene yet.
      const mods = (Array.isArray(models) ? models : [])
        .map((f) => ({ file: path.basename(String(f?.file || f)), name: f?.name ? path.basename(String(f.name)) : undefined }))
        .filter((f) => MODEL_FILE.test(f.file) && fs.existsSync(path.join(modelsDir, f.file)))
        .slice(0, 8)
        .map((f) => ({ file: f.file, name: f.name || f.file, url: `/models/${f.file}`, path: path.join(modelsDir, f.file) }));
      if ((!text || !String(text).trim()) && !imgs.length && !mods.length) return json(res, 400, { ok: false, error: 'empty prompt' });
      const p = { id: `p${Date.now().toString(36)}`, text: String(text || '').trim(), context: context || {}, status: 'pending', at: Date.now() };
      if (imgs.length) p.images = imgs;
      if (mods.length) p.models = mods;
      if (detail === 'high') p.detail = 'high';
      prompts.push(p); if (prompts.length > 500) prompts = prompts.slice(-500);
      savePrompts();
      broadcast('prompt', p);
      deliverToWaiters();
      json(res, 200, { ok: true, prompt: p, agent: agentListening() });
    },
    'GET /api/prompt/next': (req, res, url) => {
      lastAgentPoll = Date.now(); touchAgent();
      if (url.searchParams.get('keep') !== '1') closeTaken();
      const p = takePrompt();
      if (p) { pushStatus(); return json(res, 200, { ok: true, prompt: p }); }
      const wait = Math.min(Number(url.searchParams.get('wait') || 0), 3600) * 1000;
      if (!wait) return json(res, 200, { ok: true, prompt: null });
      const w = {
        resolve: (prompt) => { lastAgentPoll = Date.now(); json(res, 200, { ok: true, prompt }); },
        timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); lastAgentPoll = Date.now(); json(res, 200, { ok: true, prompt: null }); pushStatus(); }, wait),
      };
      waiters.push(w);
      req.on('close', () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); clearTimeout(w.timer); pushStatus(); } });
      pushStatus();
    },
    'POST /api/listen': async (req, res) => {
      const { on, session = null, cwd = null } = await readJson(req);
      listen = !!on;
      listenSession = listen ? session : null;
      listenCwd = listen ? cwd : null;
      if (listen) touchAgent();
      fs.writeFileSync(listenPath, JSON.stringify({ on: listen, session: listenSession, cwd: listenCwd }));
      pushStatus();
      json(res, 200, { ok: true, listen });
    },
    'GET /api/prompts': (req, res) => json(res, 200, { prompts: prompts.slice(-50) }),
    'POST /api/prompt/status': async (req, res) => {
      const { id, status } = await readJson(req);
      const p = prompts.find((x) => x.id === id);
      if (!p) return json(res, 404, { ok: false, error: `no prompt ${id}` });
      p.status = status; savePrompts(); broadcast('prompt', p); deliverToWaiters();
      json(res, 200, { ok: true });
    },

    // ----- secrets: typed into a key block in the chat, kept on this machine, never sent to the agent -----
    'POST /api/secret': async (req, res) => {
      const { name, value } = await readJson(req);
      try { saveSecret(name, value); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      json(res, 200, { ok: true, name });
    },
    'GET /api/secrets': (req, res) => json(res, 200, { ok: true, secrets: listSecrets() }),

    // ----- progress: one card in the chat for a long job, updated in place -----
    'POST /api/progress': async (req, res) => {
      const b = await readJson(req);
      touchAgent();
      const text = (v, max) => String(v ?? '').trim().slice(0, max);
      const prev = b.id ? progress.get(String(b.id)) ?? readTail(logPath, Infinity).filter((m) => m.kind === 'progress' && m.progress?.id === b.id).at(-1)?.progress : null;
      if (b.id && !prev) return json(res, 404, { ok: false, error: `no progress card ${b.id} in this chat` });
      if (!prev && !text(b.title, 80)) return json(res, 400, { ok: false, error: 'a progress card needs a title' });
      const now = Date.now();
      const p = prev ? { ...prev } : { id: `g${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`, state: 'running', startedAt: now };
      if (text(b.title, 80)) p.title = text(b.title, 80);
      if (Array.isArray(b.steps)) { p.steps = b.steps.map((s) => text(s, 40)).filter(Boolean).slice(0, 8); if (!p.steps.length) delete p.steps; p.step = p.steps ? Math.min(p.step || 1, p.steps.length) : undefined; }
      if (b.step != null) {
        const n = Number(b.step);
        if (!p.steps || !Number.isInteger(n) || n < 1 || n > p.steps.length) return json(res, 400, { ok: false, error: p.steps ? `step must be 1 to ${p.steps.length}` : 'this card has no steps' });
        if (n !== p.step) delete p.pct; // a percentage belongs to the stage it was given for
        p.step = n;
      }
      if (b.pct != null) { const n = Number(b.pct); if (!(n >= 0 && n <= 100)) return json(res, 400, { ok: false, error: 'pct must be 0 to 100' }); p.pct = Math.round(n); }
      if (b.eta != null) { const n = Number(b.eta); if (n > 0) p.eta = Math.round(n); else delete p.eta; }
      if (b.note != null) { if (text(b.note, 200)) p.note = text(b.note, 200); else delete p.note; }
      if (b.state != null) {
        if (!['running', 'done', 'failed'].includes(b.state)) return json(res, 400, { ok: false, error: 'state must be running, done or failed' });
        p.state = b.state;
        if (p.state === 'running') delete p.endedAt; else p.endedAt = now;
      }
      p.updatedAt = now;
      for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
      if (!prev) endAutoCards(); // the agent's own card replaces the one made from "still working"
      postProgress(p);
      json(res, 200, { ok: true, id: p.id, progress: p });
    },

    // ----- questions: the agent asks in the chat, the answers come back as one prompt -----
    'POST /api/ask': async (req, res) => {
      const body = await readJson(req);
      touchAgent();
      let ask;
      try { ask = normalizeAsk(body); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const taken = prompts.filter((x) => x.status === 'taken');
      const reply = body.reply || (taken.length === 1 ? taken[0].id : undefined);
      ask.id = `q${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
      const entry = { from: 'agent', kind: 'ask', text: ask.title || ask.questions[0].q, ask, reply, at: Date.now() };
      appendLog(entry);
      broadcast('say', entry);
      endAutoCards();
      const rv = reply && reviewFor(reply);
      if (rv) endReview(rv, 'Waiting for your answer');
      // Asking hands the turn to the user: the prompt it answers is no longer being worked on.
      const p = reply && prompts.find((x) => x.id === reply);
      if (p) { p.status = 'done'; p.doneAt = Date.now(); savePrompts(); broadcast('prompt', p); }
      json(res, 200, { ok: true, id: ask.id, questions: ask.questions.length });
    },
    'POST /api/ask/answer': async (req, res) => {
      const { id, answers = {}, cancelled = false, context } = await readJson(req);
      const entry = readTail(logPath, Infinity).find((m) => m.kind === 'ask' && m.ask?.id === id);
      if (!entry) return json(res, 404, { ok: false, error: `no question ${id} in this chat` });
      if (prompts.some((x) => x.ask === id)) return json(res, 409, { ok: false, error: 'already answered' });
      const { text, answers: clean, images } = answerAsk(entry.ask, answers, cancelled, (f) => {
        const file = path.basename(String(f?.file || f));
        return fs.existsSync(path.join(uploadsDir, file)) ? { file, url: `/uploads/${file}`, path: path.join(uploadsDir, file) } : null;
      });
      const p = { id: `p${Date.now().toString(36)}`, text, ask: id, answers: clean, context: context || {}, status: 'pending', at: Date.now() };
      if (cancelled) p.cancelled = true;
      if (images.length) p.images = images;
      if (prompts.find((x) => x.id === entry.reply)?.detail === 'high') p.detail = 'high'; // the answer carries on in high detail
      prompts.push(p); if (prompts.length > 500) prompts = prompts.slice(-500);
      savePrompts();
      broadcast('prompt', p);
      deliverToWaiters();
      json(res, 200, { ok: true, prompt: p, agent: agentListening() });
    },

    // New chat: archive the conversation and start an empty thread. Prompts still queued or being worked on stay.
    'POST /api/chat/new': async (req, res) => {
      const active = (p) => p.status === 'pending' || p.status === 'taken';
      const chat = archiveChat(prompts.filter((p) => !active(p)), readTail(logPath, Infinity));
      try { fs.rmSync(logPath, { force: true }); } catch {}
      prompts = prompts.filter(active);
      savePrompts();
      broadcast('history', currentChat());
      json(res, 200, { ok: true, kept: prompts.length, archived: chat?.id || null });
    },
    // Past chats, newest first, and one past chat in full.
    'GET /api/chats': (req, res) => json(res, 200, { ok: true, chats: listChats() }),
    'GET /api/chats/get': (req, res, url) => {
      const chat = readChat(url.searchParams.get('id'));
      if (!chat) return json(res, 404, { ok: false, error: `no chat ${url.searchParams.get('id')} (see canvas chats)` });
      json(res, 200, { ok: true, chat });
    },
    // ----- high detail: what the agent saw on its last inspection sheet -----
    'POST /api/review': async (req, res) => {
      const { found, skip, reply } = await readJson(req);
      touchAgent();
      const open = reviewCards();
      const p = reply ? reviewFor(reply) : open.length === 1 ? open[0] : null;
      if (!p) return json(res, 404, { ok: false, error: open.length ? 'several reviews are open: pass --reply <promptId>' : 'no high detail review is open (only prompts sent with "High detail" have one)' });
      if (skip != null) {
        const why = String(skip === true ? '' : skip).trim().slice(0, 160);
        if (!why) return json(res, 400, { ok: false, error: 'say why you are skipping the review: canvas review --skip "why"' });
        endReview(p, `Review skipped: ${why}`);
        return json(res, 200, { ok: true, skipped: true });
      }
      const list = (Array.isArray(found) ? found : String(found ?? '').split('|')).map((x) => String(x).trim().slice(0, 140)).filter(Boolean).slice(0, 12);
      if (!list.length) return json(res, 400, { ok: false, error: 'usage: canvas review "rear wheels float 5 cm | no door handles"   (or "no problems")' });
      const passes = p.review.passes;
      if (!passes.length) return json(res, 409, { ok: false, error: 'inspect first: canvas inspect <ids or prefix>, open the PNG, then write up what you saw' });
      const clean = list.length === 1 && /^(no (problems|issues)|nothing( wrong)?|ok|looks (good|right)|all good)\.?$/i.test(list[0]);
      const last = { ...passes.at(-1), found: clean ? [] : list, clean };
      const next = [...passes.slice(0, -1), last];
      reviewUpdate(p, { note: clean ? `Pass ${last.n}: no problems found` : `Pass ${last.n}: ${list.length} to fix`, review: { passes: next } });
      const block = reviewBlock({ ...p, review: { ...p.review, passes: next } });
      json(res, 200, { ok: true, pass: last.n, clean, found: last.found.length, done: !block, next: block });
    },

    // ----- messages: agent -> canvas -----
    'POST /api/say': async (req, res) => {
      const { text, reply: replyTo, kind = 'info', done = true, files } = await readJson(req);
      touchAgent();
      // A reply without --reply answers the prompt the agent is working on, if there is exactly one.
      const taken = prompts.filter((x) => x.status === 'taken');
      const open = reviewCards();
      const reply = replyTo || (taken.length === 1 ? taken[0].id : open.length === 1 ? open[0].review.prompt : undefined);
      const rv = kind !== 'working' && done && reply ? reviewFor(reply) : null;
      if (rv) { const why = reviewBlock(rv); if (why) return json(res, 409, { ok: false, error: `${why} Nothing was sent to the chat.` }); }
      const entry = { from: 'agent', text: String(text || ''), reply, kind, at: Date.now() };
      const attached = (Array.isArray(files) ? files : []).map((f) => ({ file: path.basename(String(f?.file || f)), name: f?.name && path.basename(String(f.name)) }))
        .filter((f) => CHAT_FILE[path.extname(f.file).toLowerCase()] && fs.existsSync(path.join(uploadsDir, f.file))).slice(0, 8).map((f) => chatFile(f.file, f.name));
      if (attached.length) entry.files = attached;
      if (!entry.text && !attached.length) return json(res, 400, { ok: false, error: 'empty message' });
      if (kind === 'working' && !attached.length && stillWorking(entry.text)) return json(res, 200, { ok: true });
      if (kind !== 'working') endAutoCards();
      if (rv) endReview(rv, reviewSummary(rv));
      appendLog(entry);
      broadcast('say', entry);
      const p = reply && prompts.find((x) => x.id === reply);
      if (p && done) { p.status = 'done'; p.doneAt = Date.now(); savePrompts(); broadcast('prompt', p); }
      json(res, 200, { ok: true });
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (route) return await route(req, res, url);
      if (req.method !== 'GET') return json(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
      if (url.pathname === '/vendor/mediabunny.mjs') return serveFile(res, path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs'));
      for (const [prefix, dir] of STATIC) {
        if (!url.pathname.startsWith(prefix)) continue;
        let rel = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!rel || rel.endsWith('/')) rel += 'index.html';
        const file = within(dir, rel);
        if (file) return serveFile(res, file, req);
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { ok: false, error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      log(`ready  http://${host}:${port}`);
      log(`scene  ${scenePath}`);
      log(`export ${exportsDir}`);
      resolve({ server, port, scenePath, exportsDir, close: () => { fs.unwatchFile(scenePath); server.close(); for (const c of clients.values()) c.res.end(); } });
    });
  });
}

function readTail(file, n) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
}

let ffmpegOk;
function transcodeH264(file) {
  if (ffmpegOk === undefined) ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!ffmpegOk) return null;
  const out = file.replace(/\.(webm|mp4)$/i, '') + '.h264.mp4';
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  if (r.status !== 0) return null;
  fs.renameSync(out, file.replace(/\.(webm|mp4)$/i, '.mp4'));
  if (!file.endsWith('.mp4')) fs.unlinkSync(file);
  return file.replace(/\.(webm|mp4)$/i, '.mp4');
}

/** The browser could encode H.264 but not AAC (its audio is Opus): re-encode just the audio to AAC, which every player reads. */
function transcodeAac(file) {
  if (ffmpegOk === undefined) ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!ffmpegOk || !file.endsWith('.mp4')) return null;
  const out = file.replace(/\.mp4$/i, '.aac.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  if (r.status !== 0) return null;
  fs.renameSync(out, file);
  return file;
}

// Allow `node server/index.mjs` directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer({ port: Number(process.env.PORT) || 5317 }).catch((e) => { console.error(e.message); process.exit(1); });
}
