// A tiny valid .glb for tests: one box mesh (w × h × d, sitting on y = 0 in its own space) under a node
// with an optional translation and scale, so size checks have to follow the node transform.
export function boxGlb({ w = 1, h = 1, d = 1, translation, scale } = {}) {
  const x = w / 2, z = d / 2;
  const pos = new Float32Array([-x, 0, -z, x, 0, -z, x, h, -z, -x, h, -z, -x, 0, z, x, 0, z, x, h, z, -x, h, z]);
  const idx = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const node = { mesh: 0 };
  if (translation) node.translation = translation;
  if (scale) node.scale = scale;
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [node],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-x, 0, -z], max: [x, h, z] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
    buffers: [{ byteLength: binPadded.length }],
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + binPadded.length, 8);
  jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(binPadded.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, js, bh, binPadded]);
}
