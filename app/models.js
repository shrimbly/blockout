// GLB models dropped into the app: uploaded to the scene folder's models/ (POST /api/model), then either added to
// the scene where the camera is focused (dropped on the canvas) or attached to a chat message for the agent
// (dropped in the chat, see prompt.js).

import { store } from './store.js';
import { toast } from './ui/kit.js';

export const isGlb = (f) => /\.glb$/i.test(f?.name || '');
export const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
/** Why a dropped file is not a model, for a toast. */
export const notGlbNote = (files) => ([...files].some((f) => /\.gltf$/i.test(f.name))
  ? 'Export the model as a single .glb (a .gltf keeps its data in separate files)'
  : 'Drop a .glb model here');

/** Upload a GLB. Resolves with the server's answer: { file, name, height, clips, ... }; throws with its error. */
export async function uploadModel(f) {
  const res = await fetch(`/api/model?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f })
    .then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  if (!res.ok) throw new Error(res.error || `could not upload ${f.name}`);
  return res;
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const slug = (name) => name.replace(/\.glb$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'model';

/** Upload GLBs and add them to the scene at a point (several: side by side along x), then select the last one.
 *  The same fields as "canvas import": its first clip's length and its height. */
export async function importModels(files, at) {
  let last = null, x = at.x;
  for (const f of files) {
    let up;
    try { up = await uploadModel(f); } catch (e) { toast(e.message, { kind: 'error', ms: 6000 }); continue; }
    const [r] = await store.op({ op: 'add', type: 'model', name: slug(f.name), file: up.file, position: [r3(x), r3(at.y), r3(at.z)], length: up.clips?.[0]?.length ?? null, h: up.height }, `import ${f.name}`).catch(() => [null]);
    if (!r) continue;
    last = r.id;
    x += 1.5;
    if (up.height != null && (up.height > 200 || up.height < 0.02)) toast(`${f.name} is ${up.height} m tall as authored: probably not in metres. Ask your agent to scale it to its real height.`, { ms: 7000 });
  }
  if (last) store.set({ selection: last });
  return last;
}
