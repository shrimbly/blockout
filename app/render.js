// Snapshots, storyboards and blockout video export.
// Video: frame-accurate render through the shot camera, encoded in the browser with WebCodecs
// (mediabunny, H.264 MP4 where available, VP9 otherwise), then uploaded to the server's exports/ folder.
// If the browser cannot encode H.264 and ffmpeg is installed, the server transcodes to H.264.
// The timeline's audio track (if any, and not muted) is mixed down for the shot and muxed in (AAC, or Opus
// re-encoded to AAC by the server when ffmpeg is there).

import { store } from './store.js';
import { toast, h } from './ui/kit.js';
import { audio } from './audio.js';
import * as THREE from 'three';
import { findShot, shotList } from '/core/doc.js';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

async function upload(blob, name, query = '') {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(name)}${query}`, { method: 'POST', body: blob });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'upload failed');
  return data;
}
const toBlob = (canvas, type = 'image/png', q) => new Promise((r) => canvas.toBlob(r, type, q));
const safeName = (s) => String(s || 'shot').replace(/[^a-z0-9._-]+/gi, '-');

export function createRenderer(viewport) {
  const size = (p = {}) => {
    const w = p.width || store.doc.meta.width, hgt = p.height || store.doc.meta.height;
    return [w + (w % 2), hgt + (hgt % 2)];
  };

  // A shot to render: the active one unless the agent names another ({ shot }).
  const pick = (shot) => {
    const s = findShot(store.doc, shot ?? store.doc.shot);
    return shotList(store.doc).find((x) => x.id === s.id);
  };
  // File stem: the scene name, plus the shot when one shot of several is exported on its own.
  const stem = (name, s) => safeName(name || (store.doc.shots.length > 1 ? `${store.doc.meta.name}-${s.id}` : store.doc.meta.name));
  const fileStem = (name, seq, s) => seq ? safeName(name || store.doc.meta.name) : stem(name, s);

  async function snapshot({ t = store.state.time, view = 'shot', name, width, height, grid, from, target, fov, shot } = {}) {
    await viewport.loaded();
    const [w, hh] = size({ width, height });
    const timeline = pick(shot).timeline;
    const canvas = viewport.renderShot(t, w, hh, { view, grid, from, target, fov, timeline });
    const blob = await toBlob(canvas);
    const file = name ? safeName(name).replace(/(\.png)?$/i, '.png') : `snapshot-${stamp()}-t${t.toFixed(2)}.png`;
    const r = await upload(blob, file);
    return { path: r.path, url: r.url, t, width: w, height: hh };
  }

  async function storyboard({ frames = 8, cols = 4, width = 480, shot } = {}) {
    await viewport.loaded();
    const s = pick(shot), tl = s.timeline;
    const A = store.doc.meta.width / store.doc.meta.height;
    const cw = width, ch = Math.round(width / A), rows = Math.ceil(frames / cols), gap = 8, label = 18;
    const sheet = h('canvas', { width: cols * cw + (cols + 1) * gap, height: rows * (ch + label) + (rows + 1) * gap });
    const g = sheet.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, sheet.width, sheet.height);
    g.font = '12px ui-monospace, Menlo, monospace'; g.textBaseline = 'top';
    const times = [];
    for (let i = 0; i < frames; i++) {
      const t = frames === 1 ? 0 : (i / (frames - 1)) * tl.duration;
      times.push(+t.toFixed(3));
      const frame = viewport.renderShot(t, cw * 2, ch * 2, { timeline: tl });
      const x = gap + (i % cols) * (cw + gap), y = gap + Math.floor(i / cols) * (ch + label + gap);
      g.drawImage(frame, x, y, cw, ch);
      g.fillStyle = '#bbb';
      g.fillText(`${String(i + 1).padStart(2, '0')}  ${t.toFixed(2)}s  f${Math.round(t * tl.fps)}`, x, y + ch + 3);
    }
    const r = await upload(await toBlob(sheet), `storyboard-${store.doc.shots.length > 1 ? `${safeName(s.id)}-` : ''}${stamp()}.png`);
    return { path: r.path, url: r.url, times, shot: s.id };
  }

  /**
   * canvas inspect: one asset (ids, or prefixes ending in - or *) rendered on its own, framed tight on its
   * bounding box, from the front, back, both sides, a high 3/4 and the top, plus a close-up of each id in
   * close. A 1.8 m figure stands beside it for scale. Returns the sheet and plain checks (size, lowest
   * point, parts that touch nothing below them).
   */
  async function inspect({ ids = [], close = [], t = store.state.time, shot, width = 520, figure = true } = {}) {
    await viewport.loaded();
    const tl = pick(shot).timeline;
    const all = store.doc.objects.map((o) => o.id);
    const match = (tok) => {
      tok = String(tok).trim();
      if (!tok) return [];
      if (all.includes(tok)) return [tok];
      const pre = tok.replace(/\*$/, '');
      return /[-*_]$/.test(tok) ? all.filter((id) => id.startsWith(pre)) : [];
    };
    const want = [...new Set(ids.flatMap(match))];
    if (!want.length) throw new Error(ids.length ? `no objects match ${ids.join(', ')} (give ids, or a prefix ending in "-" such as van-)` : 'name the asset to inspect: ids, or a prefix such as van-');
    const closeIds = close.flatMap(match);
    const boxes = viewport.objectBoxes(t, tl);
    const box = new THREE.Box3();
    for (const id of want) if (boxes.get(id)) box.union(boxes.get(id));
    if (box.isEmpty()) throw new Error('those objects have nothing to render');
    const size = box.getSize(new THREE.Vector3());
    const big = Math.max(size.x, size.y, size.z);

    // Parts with nothing under them: above the ground, and not touching any other object below or around.
    const floating = [];
    for (const id of want) {
      const b = boxes.get(id);
      if (!b || b.min.y < 0.02) continue;
      const probe = b.clone().expandByVector(new THREE.Vector3(0.005, 0.02, 0.005));
      let touch = false, below = 0;
      for (const [oid, ob] of boxes) {
        if (oid === id) continue;
        if (ob.intersectsBox(probe)) { touch = true; break; }
        const overXZ = ob.max.x > b.min.x && ob.min.x < b.max.x && ob.max.z > b.min.z && ob.min.z < b.max.z;
        if (overXZ && ob.max.y <= b.min.y) below = Math.max(below, ob.max.y);
      }
      if (!touch) floating.push({ id, gap: +(b.min.y - below).toFixed(3) });
    }

    const sunk = want.filter((id) => boxes.get(id)?.min.y < -0.02).map((id) => ({ id, depth: +(-boxes.get(id).min.y).toFixed(3) }));
    const only = new Set(want);
    const extra = [];
    const fitBox = box.clone();
    if (figure && big >= 0.6 && big <= 40) {
      // at the back-left corner: beside the asset in the four side views, behind it in the 3/4 view
      const fig = viewport.scaleFigure([box.min.x - 0.5, 0, box.min.z - 0.3]);
      extra.push(fig);
      fitBox.union(new THREE.Box3().setFromObject(fig));
    }
    const fov = 30, A = 4 / 3;
    // Camera for direction d (from the box toward the camera), far enough that every corner is in frame.
    const fit = (b, d, margin = 1.08) => {
      const c = b.getCenter(new THREE.Vector3()), dir = new THREE.Vector3(...d).normalize();
      const top = Math.abs(dir.y) > 0.99;
      const up = top ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
      const f = dir.clone().negate(), r = new THREE.Vector3().crossVectors(f, up).normalize(), u = new THREE.Vector3().crossVectors(r, f);
      const tv = Math.tan((fov * Math.PI) / 360), th = tv * A;
      let dist = 0.3;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const p = new THREE.Vector3(x, y, z).sub(c);
        dist = Math.max(dist, p.dot(dir) + Math.abs(p.dot(r)) / th * margin, p.dot(dir) + Math.abs(p.dot(u)) / tv * margin);
      }
      return { from: c.clone().addScaledVector(dir, dist).toArray(), target: c.toArray(), up: up.toArray() };
    };
    const views = [
      ['front (+z)', [0, 0.06, 1]], ['back (-z)', [0, 0.06, -1]], ['side (+x)', [1, 0.06, 0]],
      ['side (-x)', [-1, 0.06, 0]], ['3/4 high', [1, 0.8, 1.1]], ['top', [0, 1, 0]],
    ].map(([label, d]) => ({ label, ...fit(fitBox, d) }));
    for (const id of closeIds) {
      const b = boxes.get(id);
      if (b) views.push({ label: `close: ${id}`, ...fit(b.clone().expandByScalar(Math.max(0.4, b.getSize(new THREE.Vector3()).length())), [0.9, 0.6, 1], 1.1) });
    }

    const cols = 3, cw = width, ch = Math.round(width / A), gap = 6, head = 28;
    const rows = Math.ceil(views.length / cols);
    const sheet = h('canvas', { width: cols * cw + (cols + 1) * gap, height: head + rows * ch + (rows + 1) * gap });
    const g = sheet.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, sheet.width, sheet.height);
    g.textBaseline = 'middle';
    g.font = '13px ui-monospace, Menlo, monospace'; g.fillStyle = '#ddd';
    const dims = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`;
    g.fillText(`inspect ${ids.join(' ')} · ${want.length} objects · ${dims} (x × y × z)${extra.length ? ' · figure 1.8 m' : ''}`, gap + 2, head / 2 + 2);
    views.forEach((v, i) => {
      const frame = viewport.renderShot(t, cw * 2, ch * 2, { from: v.from, target: v.target, up: v.up, fov, only, extra, timeline: tl });
      const x = gap + (i % cols) * (cw + gap), y = head + gap + Math.floor(i / cols) * (ch + gap);
      g.drawImage(frame, x, y, cw, ch);
      g.font = '12px ui-monospace, Menlo, monospace';
      const w = g.measureText(v.label).width + 12;
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, y, w, 20);
      g.fillStyle = '#fff'; g.fillText(v.label, x + 6, y + 10);
    });
    const r = await upload(await toBlob(sheet), `inspect-${safeName(ids.join('-')).slice(0, 40)}-${stamp()}.png`);
    return {
      path: r.path, url: r.url, objects: want.length, ids: want, views: views.map((v) => v.label),
      size: [size.x, size.y, size.z].map((n) => +n.toFixed(3)), lowest: +box.min.y.toFixed(3), floating, sunk,
    };
  }

  /**
   * Render the whole timeline to one mp4: every shot in order, each through its own camera, cut together at
   * one frame rate (fps, else the active shot's) with the audio track running under the cuts. { shot } (or
   * { sequence: false } for the active shot) renders just that one shot.
   */
  async function exportVideo({ fps, width, height, grid, name, shot, sequence } = {}) {
    if (store.state.exporting) throw new Error('an export is already running');
    await viewport.loaded();
    const all = shotList(store.doc);
    const seq = all.length > 1 && (sequence ?? shot == null);
    const shots = seq ? all : [pick(shot)];
    const empty = shots.find((s) => !s.timeline.keys.length);
    if (empty) throw new Error(seq ? `shot "${empty.name || empty.id}" has no camera keys: add one before exporting the timeline` : 'add at least one camera key before exporting');
    const rate = fps || (seq ? store.doc.timeline.fps : shots[0].timeline.fps);
    const parts = shots.map((s) => ({ s, frames: Math.max(1, Math.round(s.timeline.duration * rate)) }));
    const realtime = () => exportRealtime({ rate, width, height, grid, name, parts, seq });
    if (typeof VideoEncoder === 'undefined') return realtime();
    const M = await import('/vendor/mediabunny.mjs');
    const [w, hh] = size({ width, height });
    const total = parts.reduce((n, p) => n + p.frames, 0);
    const codec = await M.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: w, height: hh });
    if (!codec) return realtime();

    store.set({ exporting: true });
    const what = seq ? `${shots.length} shots` : 'blockout';
    const progress = toast(`Rendering ${what}… 0%`, { ms: 30 * 60 * 1000 });
    try {
      const target = new M.BufferTarget();
      const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const first = viewport.renderShot(0, w, hh, { grid, timeline: shots[0].timeline });
      const source = new M.CanvasSource(first, { codec, bitrate: Math.round(w * hh * rate * 0.18), keyFrameInterval: 1 });
      output.addVideoTrack(source, { frameRate: rate });
      const mix = await mixParts(parts, rate);
      let aCodec = null, aSource = null;
      if (mix) {
        aCodec = await M.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate });
        if (aCodec) { aSource = new M.AudioBufferSource({ codec: aCodec, bitrate: 192e3 }); output.addAudioTrack(aSource); }
        else toast('This browser cannot encode audio: exporting the video without it', { kind: 'error' });
      }
      await output.start();
      if (aSource) { await aSource.add(mix); aSource.close(); }
      let done = 0;
      for (const { s, frames } of parts) {
        for (let i = 0; i < frames; i++) {
          viewport.renderShot(i / rate, w, hh, { grid, timeline: s.timeline });
          await source.add((done + i) / rate, 1 / rate);
          if (i % 6 === 0) { progress.textContent = `Rendering ${what}… ${Math.round(((done + i) / total) * 100)}%`; await new Promise((r) => setTimeout(r)); }
        }
        done += frames;
      }
      await output.finalize();
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      const file = `${fileStem(name, seq, shots[0])}-${stamp()}.mp4`;
      const r = await upload(blob, file, codec !== 'avc' ? '&transcode=h264' : aCodec && aCodec !== 'aac' ? '&transcode=aac' : '');
      const result = { path: r.path, url: r.url, frames: total, fps: rate, width: w, height: hh, codec: codec === 'avc' ? 'h264' : `${codec} (transcoded to h264 if ffmpeg was available)`, bytes: blob.size };
      if (seq) result.shots = parts.map(({ s, frames }) => ({ id: s.id, name: s.name, frames }));
      else result.shot = shots[0].id;
      if (aCodec) result.audio = aCodec === 'aac' ? 'aac' : `${aCodec} (transcoded to aac if ffmpeg was available)`;
      progress.remove();
      toast(h('span', {}, 'Exported ', h('a', { href: r.url, target: '_blank' }, r.path.split('/').pop())), { ms: 8000 });
      return result;
    } finally {
      progress.remove();
      store.set({ exporting: false });
    }
  }

  // The scene's audio under each part's span of the action, back to back. Null when there is no audio.
  async function mixParts(parts, rate) {
    const st = (p) => p.s.timeline.start || 0;
    if (parts.length === 1) return audio.mixdown(st(parts[0]), parts[0].frames / rate);
    const mixes = [];
    for (const p of parts) mixes.push(await audio.mixdown(st(p), p.frames / rate, { channels: 2 }));
    if (!mixes.some(Boolean)) return null;
    const len = (p) => Math.round((p.frames / rate) * audio.RATE);
    const out = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, parts.reduce((n, p) => n + len(p), 0)), sampleRate: audio.RATE });
    let at = 0;
    parts.forEach((p, i) => {
      const m = mixes[i];
      if (m) for (let c = 0; c < 2; c++) out.getChannelData(c).set(m.getChannelData(Math.min(c, m.numberOfChannels - 1)).subarray(0, len(p)), at);
      at += len(p);
    });
    return out;
  }

  // Fallback for browsers without WebCodecs: real-time capture with MediaRecorder, the parts played back to back.
  async function exportRealtime({ rate, width, height, grid, name, parts, seq }) {
    const [w, hh] = size({ width, height });
    const ends = []; let D = 0;
    for (const p of parts) ends.push(D += p.frames / rate);
    const at = (t) => { // the part playing at time t of the video, and the time inside it
      let i = ends.findIndex((e) => t < e); if (i < 0) i = parts.length - 1;
      return [parts[i].s.timeline, Math.min(t - (ends[i] - parts[i].frames / rate), parts[i].s.timeline.duration)];
    };
    const canvas = viewport.renderShot(0, w, hh, { grid, timeline: parts[0].s.timeline });
    const stream = canvas.captureStream(rate);
    const mix = await mixParts(parts, rate);
    let mixCtx = null, mixSrc = null;
    if (mix) { // play the mixdown into the recording, in real time alongside the frames
      mixCtx = new AudioContext({ sampleRate: mix.sampleRate });
      const dest = mixCtx.createMediaStreamDestination();
      mixSrc = mixCtx.createBufferSource(); mixSrc.buffer = mix; mixSrc.connect(dest);
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
    const type = (mix ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus'] : []).concat(['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']).find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    store.set({ exporting: true });
    try {
      const done = new Promise((r) => { rec.onstop = r; });
      rec.start();
      mixSrc?.start();
      const t0 = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          const t = (performance.now() - t0) / 1000;
          const [timeline, local] = at(Math.min(t, D));
          viewport.renderShot(local, w, hh, { grid, timeline });
          if (t >= D) return resolve();
          requestAnimationFrame(step);
        };
        step();
      });
      rec.stop();
      await done;
      const blob = new Blob(chunks, { type: rec.mimeType });
      const ext = rec.mimeType.includes('mp4') ? 'mp4' : 'webm';
      const r = await upload(blob, `${fileStem(name, seq, parts[0].s)}-${stamp()}.${ext}`, '&transcode=h264');
      const result = { path: r.path, url: r.url, frames: parts.reduce((n, p) => n + p.frames, 0), fps: rate, width: w, height: hh, codec: `${rec.mimeType} (realtime)`, bytes: blob.size };
      if (seq) result.shots = parts.map(({ s, frames }) => ({ id: s.id, name: s.name, frames }));
      else result.shot = parts[0].s.id;
      return result;
    } finally { store.set({ exporting: false }); mixCtx?.close(); }
  }

  return { snapshot, storyboard, inspect, exportVideo };
}
