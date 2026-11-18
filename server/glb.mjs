// Reads what an agent needs to know about a .glb without loading it: its size as authored (from the
// accessor bounds glTF requires on every POSITION attribute, moved by the node transforms) and a few counts.
// Zero dependencies; used when a model is uploaded and by "canvas models".

/** Parse a .glb buffer's JSON chunk. Throws on anything that is not binary glTF 2. */
export function glbJson(buf) {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a .glb file (binary glTF starts with "glTF")');
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`glTF version ${version} is not supported (need 2)`);
  const len = buf.readUInt32LE(12), type = buf.readUInt32LE(16);
  if (type !== 0x4e4f534a || 20 + len > buf.length) throw new Error('the .glb has no JSON chunk');
  return JSON.parse(buf.toString('utf8', 20, 20 + len));
}

const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// column-major 4x4, as glTF stores them
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function trs(n) {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * Size and counts of a .glb: { size: [w, h, d] metres (glTF is in metres, Y up), min, max, meshes,
 * triangles, compressed } where compressed names the extensions that need a decoder (Draco, meshopt).
 */
export function glbInfo(buf) {
  const g = glbJson(buf);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let meshes = 0, triangles = 0;
  const visit = (i, parent, depth) => {
    const n = g.nodes?.[i];
    if (!n || depth > 64) return;
    const m = mul(parent, trs(n));
    if (n.mesh != null && g.meshes?.[n.mesh]) {
      meshes++;
      for (const p of g.meshes[n.mesh].primitives || []) {
        const acc = g.accessors?.[p.attributes?.POSITION];
        if (!acc?.min || !acc?.max) continue;
        const idx = p.indices != null ? g.accessors?.[p.indices] : null;
        if ((p.mode ?? 4) === 4) triangles += Math.floor((idx ? idx.count : acc.count) / 3);
        for (let c = 0; c < 8; c++) {
          const v = [c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]];
          for (let r = 0; r < 3; r++) {
            const w = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r];
            if (w < min[r]) min[r] = w;
            if (w > max[r]) max[r] = w;
          }
        }
      }
    }
    for (const ch of n.children || []) visit(ch, m, depth + 1);
  };
  const scene = g.scenes?.[g.scene ?? 0];
  const roots = scene?.nodes || (g.nodes || []).map((_, i) => i);
  for (const r of roots) visit(r, ident(), 0);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const found = Number.isFinite(min[0]);
  const used = g.extensionsUsed || [];
  return {
    size: found ? max.map((v, i) => r3(v - min[i])) : null,
    min: found ? min.map(r3) : null,
    max: found ? max.map(r3) : null,
    meshes,
    triangles,
    compressed: used.filter((e) => /draco|meshopt/i.test(e)),
  };
}
