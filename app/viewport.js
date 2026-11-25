// The 3D viewport: ground, grid, primitives, the free (orbit) camera, the shot camera driven by the
// timeline, selection + gizmos, and an offscreen renderer for snapshots and video export.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { buildGeometry } from './geometry.js';
import { isCut, sampleCamera, sampleObject, remapTime, fovToLens, lensToFov } from '/core/curves.js';
import { store } from './store.js';
import { toast } from './ui/kit.js';

const DEG = Math.PI / 180;
const r3 = (v) => Math.round(v * 1000) / 1000;
const ACCENT = new THREE.Color('#ff5a1f');
const LENS = { min: 8, max: 300 }; // mm, the same range as the timeline's lens field
const SAFE = { top: 52, bottom: 124, side: 16, chat: 364, gap: 24 }; // keep the shot frame clear of the floating UI

export class Viewport {
  constructor(stage) {
    this.stage = stage;
    // Logarithmic depth: with a 5 cm near plane, a plain depth buffer can't tell apart surfaces a few
    // millimetres apart once you zoom out (roads, lawns, rugs lying on the ground flicker and break up).
    // Every renderer that draws the scene needs it, and custom shaders need the logdepthbuf chunks.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    stage.append(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
    // Shot view: the canvas fills the window and the scene carries on past the shot frame (overscan),
    // dimmed by this outline's shadow, so you can see what's just out of shot while framing it.
    this.frameEl = document.createElement('div');
    this.frameEl.className = 'shot-frame';
    this.frameEl.hidden = true;
    stage.append(this.frameEl);

    this.scene = new THREE.Scene();
    this.objects = new THREE.Group(); this.objects.name = 'objects';
    this.helpers = new THREE.Group(); this.helpers.name = 'helpers';
    this.scene.add(this.objects, this.helpers);
    this.meshes = new Map(); // id -> { mesh, edges, geoKey, model?, mixer?, clipLength?, modelMats? }
    this.gltfs = new Map(); // model file -> Promise<gltf>, loaded once and cloned per object
    this.loading = new Set(); // model loads in flight (renders wait for them: loaded())

    this._buildEnvironment();
    this._buildCameras();
    this._buildGizmo();
    this._buildShotHelpers();
    this._bindPicking();
    this._bindLensWheel();
    this._bindFly();

    this.layout();
    addEventListener('resize', () => this.layout());
    // the timeline grows and shrinks with its shots and the audio lane: keep the shot frame clear of it
    const tlEl = document.getElementById('timeline');
    if (tlEl && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.layout()).observe(tlEl);
    this._lastView = store.state.view;
    store.on('state', (c) => {
      if (c.view) this._applyView();
      if (c.selection) this._applySelection();
      if (c.gizmo) this.gizmo.setMode(store.state.gizmo);
      if (c.key) this._rebuildPath();
      if (c.chat || c.beside) this.layout();
    });
  }

  // ---------- setup ----------
  _buildEnvironment() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a857c, 1.6);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera; sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 0.5; sc.far = 120;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.02; this.sun.shadow.radius = 3;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.groundMat = new THREE.MeshStandardMaterial({ color: 0xdedbd4, roughness: 1 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600, 60, 60).rotateX(-Math.PI / 2), this.groundMat);
    this.ground.receiveShadow = true; this.ground.name = 'ground';
    this.scene.add(this.ground);

    // Infinite-looking ground grid: 1 m minor, 5 m major lines, X/Z axes tinted, fading with distance.
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(600, 600, 60, 60).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      uniforms: { uColor: { value: new THREE.Color(0x000000) }, uFade: { value: 70 } },
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor; uniform float uFade; varying vec3 vWorld;
        float line(float size, float width) {
          vec2 c = vWorld.xz / size; vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          return 1.0 - min(min(g.x, g.y) / width, 1.0);
        }
        float axis(float v) { return 1.0 - min(abs(v) / fwidth(v) / 1.5, 1.0); }
        void main() {
          #include <logdepthbuf_fragment>
          float d = length(vWorld.xz - cameraPosition.xz);
          float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
          float a = max(line(1.0, 1.0) * 0.07, line(5.0, 1.1) * 0.15);
          vec3 col = uColor;
          float ax = axis(vWorld.z), az = axis(vWorld.x);
          if (ax > 0.01) { col = mix(col, vec3(0.85, 0.25, 0.2), ax); a = max(a, ax * 0.45); }
          if (az > 0.01) { col = mix(col, vec3(0.2, 0.4, 0.85), az); a = max(a, az * 0.45); }
          gl_FragColor = vec4(col, a * fade);
          if (gl_FragColor.a < 0.003) discard;
        }`,
    }));
    this.grid.position.y = 0.002;
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);
  }

  _buildCameras() {
    this.freeCam = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
    this.shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 2000);
    // Roll (Dutch tilt, degrees) of each camera. OrbitControls always levels the camera, so tick puts
    // the roll back on after the orbit has aimed it. The shot camera's comes from the timeline keys
    // unless it is being hand-framed.
    this.freeRoll = 0; this.shotRoll = 0;
    this.freeOrbit = new OrbitControls(this.freeCam, this.canvas);
    this.freeOrbit.enableDamping = true; this.freeOrbit.dampingFactor = 0.12;
    this.shotOrbit = new OrbitControls(this.shotCam, this.canvas);
    this.shotOrbit.enabled = false;
    this.shotOrbit.addEventListener('start', () => {
      if (store.state.playing) store.set({ playing: false });
      store.set({ camDirty: true });
    });
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('cc-freecam') || 'null'); } catch {}
    this.freeCam.position.fromArray(saved?.p || [11, 7.5, 13]);
    this.freeOrbit.target.fromArray(saved?.t || [0, 1, 0]);
    if (saved?.f) { this.freeCam.fov = saved.f; this.freeCam.updateProjectionMatrix(); }
    if (saved?.r) this.freeRoll = saved.r;
    this.freeOrbit.update();
    addEventListener('beforeunload', () => {
      try { sessionStorage.setItem('cc-freecam', JSON.stringify({ p: this.freeCam.position.toArray(), t: this.freeOrbit.target.toArray(), f: this.freeCam.fov, r: this.freeRoll })); } catch {}
    });
  }

  _buildGizmo() {
    this.gizmo = new TransformControls(this.freeCam, this.canvas);
    this.gizmo.setSize(0.85);
    this.gizmo.setMode(store.state.gizmo);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.freeOrbit.enabled = !e.value && store.state.view === 'free';
      this.shotOrbit.enabled = !e.value && store.state.view === 'shot';
      this.dragging = e.value;
      if (!e.value) this._commitTransform();
    });
  }

  _buildShotHelpers() {
    const line = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true });
    // camera body: frustum pyramid + "up" notch, drawn in the camera's local space
    this.rig = new THREE.Group();
    this.rigLines = new THREE.LineSegments(new THREE.BufferGeometry(), line(0x1c1c1a, 0.85));
    this.rig.add(this.rigLines);
    this.aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), line(0xff5a1f, 0.6));
    this.targetDot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff5a1f }));
    // Segments rather than one polyline, so the path can break at a cut instead of drawing the jump.
    this.path = new THREE.LineSegments(new THREE.BufferGeometry(), line(0xff5a1f, 0.7));
    this.targetPath = new THREE.LineSegments(new THREE.BufferGeometry(), line(0xff5a1f, 0.25));
    this.keyDots = new THREE.Group();
    this.helpers.add(this.rig, this.aimLine, this.targetDot, this.path, this.targetPath, this.keyDots);
  }

  _bindPicking() {
    const ray = new THREE.Raycaster();
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = (this.gizmo.axis && store.state.selection) ? null : { x: e.clientX, y: e.clientY, button: e.button };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || down.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || this.dragging) { down = null; return; }
      down = null;
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.activeCam);
      const hit = ray.intersectObjects(this._pickables(), false)[0];
      // Ctrl/Cmd-click selects (or clears the selection on empty space). Plain click aims the camera
      // at the clicked point: the object surface, else the ground.
      if (e.ctrlKey || e.metaKey) { store.set({ selection: hit ? hit.object.userData.id : null }); return; }
      const point = hit ? hit.point : ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (point && point.distanceTo(this.activeCam.position) < 1500) this.aimAt(point);
    });
    // On macOS Ctrl-click also fires a context menu: suppress it over the canvas.
    this.canvas.addEventListener('contextmenu', (e) => { if (e.ctrlKey) e.preventDefault(); });
    this.canvas.addEventListener('dblclick', () => { if (store.state.selection) this.frame(store.state.selection); });
  }

  // Ctrl/Cmd + scroll (and trackpad pinch, which browsers send as ctrl + wheel) changes the focal length
  // instead of dollying. It edits what the timeline's lens field edits: in free view the work camera's
  // lens, plus the selected key's (one undo step per gesture); in shot view it hand-frames the shot
  // camera like orbit and scroll do there, so press K to key it.
  _bindLensWheel() {
    let commit = null;
    this.canvas.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // keep OrbitControls from also zooming
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // ~8% per mouse-wheel notch; pinch sends many small deltas, so it scales smoothly
      const step = Math.max(-0.08, Math.min(0.08, dy * 0.01));
      const cam = this.activeCam;
      const mm = Math.max(LENS.min, Math.min(LENS.max, fovToLens(cam.fov) * Math.exp(-step)));
      const fov = +lensToFov(mm).toFixed(3);
      if (Math.abs(fov - cam.fov) < 1e-3) return;
      if (store.state.view === 'shot') {
        if (store.state.playing) store.set({ playing: false });
        cam.fov = fov; cam.updateProjectionMatrix();
        store.set({ camDirty: true });
      } else {
        this.setFreeFov(fov);
        const id = store.state.key;
        if (id) {
          clearTimeout(commit);
          commit = setTimeout(() => store.op({ op: 'key.update', id, fov: +this.freeCam.fov.toFixed(3) }, 'edit key').catch(() => {}), 250);
        }
      }
      store.emit('state', { lens: true }); // refresh the lens field
    }, { capture: true, passive: false });
  }

  // Fly with the keyboard: W A S D move, Q / E go down / up, Z / X roll, Shift is faster, Alt slower.
  // It works on its own (good on a trackpad: drag still orbits around the aim point ahead), and while
  // the right mouse button is held the mouse looks around too, the arrow keys fly as well, and scroll
  // sets the fly speed. Right-drag without a fly key still pans. In shot view it hand-frames the shot
  // camera like orbit does, so press K to key it.
  _bindFly() {
    const MOVE = {
      KeyW: [0, 0, 1], ArrowUp: [0, 0, 1], KeyS: [0, 0, -1], ArrowDown: [0, 0, -1],
      KeyA: [-1, 0, 0], ArrowLeft: [-1, 0, 0], KeyD: [1, 0, 0], ArrowRight: [1, 0, 0],
      KeyQ: [0, -1, 0], KeyE: [0, 1, 0],
      KeyZ: [0, 0, 0], KeyX: [0, 0, 0], // roll left / right, see _stepFly
    };
    let speed = 4; try { speed = +localStorage.getItem('cc-flyspeed') || 4; } catch {}
    const fly = this.fly = { held: false, active: false, look: false, keys: new Set(), speed, last: 0, MOVE };
    const orbitsOn = () => {
      this.freeOrbit.enabled = store.state.view === 'free' && !this.dragging;
      this.shotOrbit.enabled = store.state.view === 'shot' && !this.dragging;
    };
    const start = () => {
      if (!fly.active) {
        fly.active = true; fly.last = performance.now();
        this.aim = null;
        if (store.state.view === 'shot') { if (store.state.playing) store.set({ playing: false }); store.set({ camDirty: true }); }
      }
      // right button held: the mouse looks instead of panning. The orbit is turned back on before its
      // own pointerup runs (on the document).
      if (fly.held && !fly.look) { fly.look = true; this.activeOrbit.enabled = false; this.canvas.style.cursor = 'none'; }
    };
    const endLook = () => {
      fly.held = false;
      if (fly.look) { fly.look = false; orbitsOn(); this.canvas.style.cursor = ''; }
      if (!fly.keys.size) fly.active = false;
    };
    const stop = () => { fly.keys.clear(); endLook(); };
    this.canvas.addEventListener('pointerdown', (e) => { if (e.button === 2) fly.held = true; });
    this.canvas.addEventListener('pointerup', (e) => { if (e.button === 2) endLook(); });
    this.canvas.addEventListener('pointercancel', stop);
    addEventListener('blur', stop);
    // capture on window, so fly keys never reach the scene shortcuts
    const mods = (e) => { fly.shift = e.shiftKey; fly.alt = e.altKey; };
    addEventListener('keydown', mods, true);
    addEventListener('keyup', mods, true);
    addEventListener('keydown', (e) => {
      if (!MOVE[e.code] || e.metaKey || e.ctrlKey || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
      if (e.code.startsWith('Arrow') && !fly.held) return; // arrows step frames unless the right button is held
      if (e.shiftKey && e.code === 'KeyD' && !fly.active) return; // Shift D duplicates; Shift only speeds up a flight already going
      e.preventDefault(); e.stopImmediatePropagation();
      fly.keys.add(e.code); start();
    }, true);
    addEventListener('keyup', (e) => {
      if (!fly.keys.delete(e.code)) return;
      e.preventDefault();
      if (!fly.keys.size && !fly.held) fly.active = false;
    }, true);
    // mouse look while flying: turn the aim point around the camera
    addEventListener('pointermove', (e) => {
      mods(e);
      if (!fly.look) return;
      const cam = this.activeCam, orbit = this.activeOrbit;
      const off = orbit.target.clone().sub(cam.position);
      const dist = Math.max(0.5, off.length());
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta -= e.movementX * 0.003;
      sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi + e.movementY * 0.003));
      sph.radius = dist;
      orbit.target.copy(cam.position).add(new THREE.Vector3().setFromSpherical(sph));
      orbit.update();
    });
    // scroll while the right button is held sets the fly speed instead of dollying
    this.canvas.addEventListener('wheel', (e) => {
      if (!fly.held || e.ctrlKey || e.metaKey) return;
      e.preventDefault(); e.stopImmediatePropagation();
      fly.speed = Math.max(0.25, Math.min(100, fly.speed * (e.deltaY < 0 ? 1.25 : 0.8)));
      try { localStorage.setItem('cc-flyspeed', String(fly.speed)); } catch {}
      fly.toast?.remove(); // one toast that follows the wheel, not a stack of them
      fly.toast = toast(`Fly speed ${fly.speed < 10 ? fly.speed.toFixed(1) : Math.round(fly.speed)} m/s`, { ms: 1200 });
    }, { capture: true, passive: false });
  }

  _stepFly() {
    const fly = this.fly;
    if (!fly?.active) return;
    const now = performance.now(), dt = Math.min(0.1, (now - fly.last) / 1000);
    fly.last = now;
    if (!fly.keys.size) return;
    // Z / X roll the camera (Dutch tilt), 45°/s (Shift 4x, Alt 1/4)
    const rollDir = (fly.keys.has('KeyX') ? 1 : 0) - (fly.keys.has('KeyZ') ? 1 : 0);
    if (rollDir) {
      const shot = store.state.view === 'shot';
      const r = (shot ? this.shotRoll : this.freeRoll) + rollDir * 45 * (fly.shift ? 4 : fly.alt ? 0.25 : 1) * dt;
      this.setRoll(r);
      if (now - (fly.rollEmit || 0) > 100) { fly.rollEmit = now; store.emit('state', { lens: true }); } // refresh the roll field
    }
    const v = new THREE.Vector3();
    for (const c of fly.keys) v.add(new THREE.Vector3().fromArray(fly.MOVE[c]));
    if (!v.lengthSq()) return;
    const cam = this.activeCam, orbit = this.activeOrbit;
    const fwd = orbit.target.clone().sub(cam.position).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const step = fly.speed * (fly.shift ? 4 : fly.alt ? 0.25 : 1) * dt;
    const d = fwd.multiplyScalar(v.z).add(right.multiplyScalar(v.x)).add(new THREE.Vector3(0, v.y, 0)).normalize().multiplyScalar(step);
    cam.position.add(d); orbit.target.add(d);
    orbit.update();
  }

  get activeCam() { return store.state.view === 'shot' ? this.shotCam : this.freeCam; }
  get activeOrbit() { return store.state.view === 'shot' ? this.shotOrbit : this.freeOrbit; }

  // ---------- layout ----------
  layout() {
    const W = innerWidth, H = innerHeight;
    const shot = store.state.view === 'shot' && !!store.doc;
    // The canvas always fills the window. In shot view the shot frame is a rect inside it, kept clear of
    // the floating UI, and the shot camera's projection is widened past that rect (a view offset), so the
    // frame shows exactly the shot and the rest of the window shows the overscan around it.
    Object.assign(this.stage.style, { left: '0px', top: '0px', width: `${W}px`, height: `${H}px` });
    this.stage.classList.toggle('is-shot', shot);
    this.renderer.setSize(W, H, true);
    this.freeCam.aspect = W / H; this.freeCam.updateProjectionMatrix();
    this.shotCam.aspect = store.doc ? store.doc.meta.width / store.doc.meta.height : W / H;
    this.frameEl.hidden = !shot;
    if (shot) {
      const A = this.shotCam.aspect;
      const right = store.state.chat ? SAFE.chat : SAFE.side;
      const tl = document.getElementById('timeline'); // the timeline grows with the audio lane
      const bottom = tl ? Math.max(SAFE.bottom, innerHeight - tl.getBoundingClientRect().top + 12) : SAFE.bottom;
      const aw = W - SAFE.side - right, ah = H - SAFE.top - bottom;
      const V = store.state.beside?.aspect; // a chat video beside the frame: the two the same height, centred together
      const pw = V ? A + V : A, gap = V ? SAFE.gap : 0;
      let h = Math.min(ah, (aw - gap) / pw);
      const w = h * A;
      const x = SAFE.side + (aw - h * pw - gap) / 2, y = SAFE.top + (ah - h) / 2;
      this.besideRect = V ? { x: x + w + gap, y, w: h * V, h } : null;
      this.shotFrame = { x, y, w, h };
      Object.assign(this.frameEl.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      // the frame is the camera's full view; the window is that view extended on every side
      this.shotCam.setViewOffset(w, h, -x, -y, W, H);
    } else {
      this.shotFrame = null;
      this.besideRect = null;
      this.shotCam.clearViewOffset();
    }
    this.shotCam.updateProjectionMatrix();
    this.onLayout?.(this);
  }

  _applyView() {
    const shot = store.state.view === 'shot';
    // Coming back to free with a key selected: pick up where the shot camera was (position, aim, lens),
    // so free view continues from the shot instead of jumping back to the old work view.
    if (!shot && this._lastView === 'shot' && store.state.key) {
      this.freeCam.position.copy(this.shotCam.position);
      this.freeOrbit.target.copy(this.shotOrbit.target);
      this.freeCam.up.set(0, 1, 0);
      this.setFreeFov(this.shotCam.fov);
      this.freeRoll = this.shotRoll;
      this.freeOrbit.update();
    }
    this._lastView = store.state.view;
    this.freeOrbit.enabled = !shot;
    this.shotOrbit.enabled = shot;
    this.gizmo.camera = this.activeCam;
    this.helpers.visible = !shot;
    store.set({ camDirty: false });
    this.layout();
  }

  // ---------- document sync ----------
  sync(doc) {
    const env = doc.env;
    const bg = new THREE.Color(env.background);
    this.scene.background = bg;
    document.documentElement.style.setProperty('--cc-bg', env.background);
    this.groundMat.color.copy(bg).multiplyScalar(0.93);
    this.ground.visible = env.ground;
    this.grid.visible = env.grid;
    this.scene.fog = env.fog > 0 ? new THREE.FogExp2(bg, env.fog) : null;
    this.sun.position.fromArray(env.sun).normalize().multiplyScalar(40);

    const seen = new Set();
    for (const o of doc.objects) {
      seen.add(o.id);
      let m = this.meshes.get(o.id);
      // a person without its own detail follows the scene's env.people
      const params = o.type === 'person' ? { ...o.params, detail: o.params.detail ?? env.people ?? 'low' } : o.params;
      // a model reloads only when its file changes (offset and speed are applied each frame)
      const geoKey = o.type === 'model' ? `model:${params.file}` : o.type + JSON.stringify(params);
      if (!m) {
        const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, color: o.color });
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        mesh.castShadow = mesh.receiveShadow = true;
        const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }));
        mesh.add(edges);
        this.objects.add(mesh);
        m = { mesh, edges, geoKey: null };
        this.meshes.set(o.id, m);
      }
      const { mesh, edges } = m;
      mesh.userData.id = o.id;
      mesh.name = o.name;
      if (m.geoKey !== geoKey) {
        mesh.geometry.dispose(); edges.geometry.dispose();
        mesh.geometry = buildGeometry(o.type, params);
        // the low-detail person paints its face in vertex colours, multiplied by the object's colour
        mesh.material.vertexColors = !!mesh.geometry.attributes.color;
        mesh.material.needsUpdate = true;
        // A body's fine creases would draw as stray lines, so people (and imported models) show selection
        // with a tint instead.
        m.tint = o.type === 'person' || o.type === 'model';
        if (o.type === 'model') this._loadModel(o.id, m, params.file); else this._dropModel(m);
        edges.geometry = m.tint ? new THREE.BufferGeometry() : new THREE.EdgesGeometry(mesh.geometry, 28);
        m.geoKey = geoKey;
      }
      mesh.material.color.set(o.color);
      if (!(this.dragging && this.gizmo.object === mesh)) {
        mesh.position.fromArray(o.position);
        mesh.rotation.set(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG, 'XYZ');
        mesh.scale.fromArray(o.scale);
      }
    }
    for (const [id, m] of this.meshes) {
      if (seen.has(id)) continue;
      if (this.gizmo.object === m.mesh) this.gizmo.detach();
      this._dropModel(m);
      m.mesh.geometry.dispose(); m.edges.geometry.dispose(); m.mesh.material.dispose();
      this.objects.remove(m.mesh);
      this.meshes.delete(id);
    }
    if (store.state.selection && !this.meshes.has(store.state.selection)) store.set({ selection: null });
    this._applySelection();
    this._rebuildPath();
    this.layout();
  }

  _applySelection() {
    const id = store.state.selection;
    for (const [mid, m] of this.meshes) {
      const sel = mid === id;
      m.edges.material.color.set(sel ? ACCENT : 0x000000);
      m.edges.material.opacity = sel ? 1 : 0.22;
      this._tint(m, sel && m.tint);
    }
    const m = id && this.meshes.get(id);
    if (m) this.gizmo.attach(m.mesh); else this.gizmo.detach();
    this._rebuildObjPath();
  }

  _commitTransform() {
    const mesh = this.gizmo.object;
    if (!mesh) return;
    const id = mesh.userData.id;
    const o = store.object(id);
    store.op({
      // an animated object gets a key at the playhead instead (adds one, or updates the key there)
      ...(o?.anim?.length ? { op: 'anim.key', t: +store.state.time.toFixed(3) } : { op: 'update' }), id,
      position: mesh.position.toArray().map(r3),
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map((v) => Math.round((v / DEG) * 100) / 100),
      scale: mesh.scale.toArray().map(r3),
    }, `move ${id}`).catch(() => {});
  }

  _rebuildPath() {
    const tl = store.doc?.timeline;
    if (!tl) return;
    const N = Math.max(2, Math.ceil(tl.duration * 30));
    const keys = [...tl.keys].sort((a, b) => a.t - b.t);
    const pts = [], tps = [];
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const s = sampleCamera(tl, (i / N) * tl.duration);
      if (!s) break;
      // During a hold the camera stands still and then cuts: draw no line across the jump (also when
      // the two keys of a cut are closer together than one sample).
      if (prev && !keys.slice(prev.segment, Math.max(prev.segment + 1, s.segment)).some(isCut)) {
        pts.push(new THREE.Vector3(...prev.position), new THREE.Vector3(...s.position));
        tps.push(new THREE.Vector3(...prev.target), new THREE.Vector3(...s.target));
      }
      prev = s;
    }
    this.path.geometry.dispose(); this.path.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.targetPath.geometry.dispose(); this.targetPath.geometry = new THREE.BufferGeometry().setFromPoints(tps);
    this.keyDots.clear();
    for (const k of tl.keys) {
      const sel = k.id === store.state.key;
      const dot = new THREE.Mesh(new THREE.OctahedronGeometry(sel ? 0.16 : 0.11), new THREE.MeshBasicMaterial({ color: sel ? 0xff5a1f : 0x1c1c1a }));
      dot.position.fromArray(k.position);
      this.keyDots.add(dot);
    }
  }

  // ---------- camera ----------
  /** Put a camera at the timeline pose for time t. */
  poseCamera(cam, t, orbit, timeline = store.doc.timeline) {
    const s = sampleCamera(timeline, t);
    if (!s) return null;
    cam.position.fromArray(s.position);
    cam.up.set(0, 1, 0);
    cam.lookAt(...s.target);
    if (s.roll) cam.rotateZ(s.roll * DEG);
    if (cam === this.shotCam) this.shotRoll = s.roll || 0;
    if (cam.fov !== s.fov) { cam.fov = s.fov; cam.updateProjectionMatrix(); }
    if (orbit) orbit.target.fromArray(s.target);
    return s;
  }

  /** Roll (degrees) of the camera you look through. In shot view it hand-frames the shot camera: press K to key it. */
  setRoll(deg) {
    const r = Math.round(Math.max(-180, Math.min(180, deg)) * 100) / 100;
    if (store.state.view === 'shot') {
      if (store.state.playing) store.set({ playing: false });
      this.shotRoll = r;
      if (!store.state.camDirty) store.set({ camDirty: true });
    } else this.freeRoll = r;
  }

  _applyRoll(cam, orbit, roll) {
    cam.up.set(0, 1, 0);
    cam.lookAt(orbit.target);
    if (roll) cam.rotateZ(roll * DEG);
  }

  /** Field of view of the free (work) camera, so it can look through the same lens as the shot. */
  setFreeFov(fov) {
    if (!(fov > 0) || Math.abs(this.freeCam.fov - fov) < 1e-3) return;
    this.freeCam.fov = fov; this.freeCam.updateProjectionMatrix();
  }

  /** Current pose of the camera the user is looking through. */
  getPose() {
    const shot = store.state.view === 'shot';
    const cam = this.activeCam, orbit = this.activeOrbit;
    return { position: cam.position.toArray().map(r3), target: orbit.target.toArray().map(r3), fov: Math.round(cam.fov * 100) / 100, roll: Math.round((shot ? this.shotRoll : this.freeRoll) * 100) / 100, view: shot ? 'shot' : 'free', time: store.state.time };
  }

  /** Point the active camera at an object (or the whole set). */
  frame(id) {
    const box = new THREE.Box3();
    if (id && this.meshes.get(id)) box.setFromObject(this.meshes.get(id).mesh);
    else if (this.objects.children.length) box.setFromObject(this.objects);
    else box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2, 2));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
    const cam = this.activeCam, orbit = this.activeOrbit;
    const dir = cam.position.clone().sub(orbit.target).normalize();
    const dist = radius / Math.sin((cam.fov * DEG) / 2) * 1.1;
    orbit.target.copy(center);
    cam.position.copy(center).addScaledVector(dir, dist);
    orbit.update();
    if (store.state.view === 'shot') store.set({ camDirty: true });
  }

  /** Where the active camera is focused, on something to stand on: straight below its aim point, the first
   *  upward-facing surface (a table top, a floor), else the ground. Used to place a model dropped on the canvas. */
  focusPoint() {
    const t = this.activeOrbit.target;
    const ray = new THREE.Raycaster(new THREE.Vector3(t.x, Math.max(t.y, 0) + 0.01, t.z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObjects(this._pickables(), false)
      .find((x) => x.face && x.face.normal.clone().transformDirection(x.object.matrixWorld).y > 0.7);
    return new THREE.Vector3(t.x, hit ? Math.max(0, hit.point.y) : 0, t.z);
  }

  /** Smoothly turn the active camera to look at a world point (it stays where it is). */
  aimAt(point, ms = 280) {
    const orbit = this.activeOrbit;
    this.aim = { orbit, from: orbit.target.clone(), to: point.clone(), start: performance.now(), ms };
    if (store.state.view === 'shot') {
      if (store.state.playing) store.set({ playing: false });
      store.set({ camDirty: true }); // press K to key the new framing
    }
  }

  _stepAim() {
    const a = this.aim;
    if (!a) return;
    const u = Math.min(1, (performance.now() - a.start) / a.ms);
    const k = 1 - Math.pow(1 - u, 3);
    a.orbit.target.lerpVectors(a.from, a.to, k);
    a.orbit.update();
    if (u >= 1 || a.orbit !== this.activeOrbit) this.aim = null;
  }

  // ---------- per frame ----------
  /** Put animated objects where they are at time t (the one being dragged stays under the pointer). */
  poseObjects(t, timeline = store.doc.timeline) {
    for (const o of store.doc.objects) {
      if (o.type === 'model') this._poseModel(o, timeline, t);
      if (!o.anim?.length) continue;
      const m = this.meshes.get(o.id);
      if (!m || (this.dragging && this.gizmo.object === m.mesh)) continue;
      const s = sampleObject(o, timeline, t);
      m.mesh.position.fromArray(s.position);
      m.mesh.rotation.set(s.rotation[0] * DEG, s.rotation[1] * DEG, s.rotation[2] * DEG, 'XYZ');
      m.mesh.scale.fromArray(s.scale);
    }
  }

  // ---------- imported models ----------
  /** Resolves once every model in the scene has loaded, so a snapshot or export never misses one. */
  async loaded() {
    while (this.loading.size) await Promise.allSettled([...this.loading]);
  }

  _pickables() {
    const out = [];
    for (const m of this.meshes.values()) {
      out.push(m.mesh);
      m.model?.traverse((c) => { if (c.isMesh) out.push(c); });
    }
    return out;
  }

  _tint(m, on) {
    for (const mat of [m.mesh.material, ...(m.modelMats || [])]) {
      if (!mat.emissive) continue;
      mat.emissive.set(on ? ACCENT : 0x000000);
      mat.emissiveIntensity = 0.35;
    }
  }

  /** Load a model's GLB (once per file) and put a copy of it, with its own skeleton and mixer, under the object. */
  _loadModel(id, m, file) {
    this._dropModel(m);
    m.modelFile = file;
    if (!this.gltfs.has(file)) this.gltfs.set(file, new GLTFLoader().loadAsync(`/models/${encodeURIComponent(file)}`));
    const job = this.gltfs.get(file).then((gltf) => {
      if (m.modelFile !== file || this.meshes.get(id) !== m) return; // replaced or removed while loading
      const model = cloneSkinned(gltf.scene);
      const mats = [];
      model.traverse((c) => {
        c.userData.id = id; // a click on any part selects the object
        if (!c.isMesh) return;
        c.castShadow = c.receiveShadow = true;
        c.frustumCulled = false; // a skinned mesh's bounds are its rest pose, not where the animation puts it
        c.material = Array.isArray(c.material) ? c.material.map((x) => x.clone()) : c.material.clone();
        mats.push(...[c.material].flat());
      });
      m.model = model;
      m.modelMats = mats;
      const clip = gltf.animations[0];
      if (clip) {
        m.mixer = new THREE.AnimationMixer(model);
        const action = m.mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        m.clipLength = clip.duration;
      }
      m.mesh.add(model);
      this._applySelection();
      this.poseObjects(store.state.time);
    }).catch((e) => {
      this.gltfs.delete(file);
      toast(`Could not load model ${file}: ${e.message}`);
    }).finally(() => this.loading.delete(job));
    this.loading.add(job);
  }

  _dropModel(m) {
    if (!m.model && !m.modelFile) return;
    m.mixer?.stopAllAction();
    if (m.model) m.mesh.remove(m.model);
    for (const mat of m.modelMats || []) mat.dispose();
    m.model = m.mixer = m.modelMats = m.modelFile = m.clipLength = null;
  }

  /** Put a model's animation where it is at shot time t: the action time, less its offset, times its speed. */
  _poseModel(o, timeline, t) {
    const m = this.meshes.get(o.id);
    if (!m?.mixer) return;
    const action = remapTime(timeline, t) + (timeline.start || 0);
    const ct = (action - (o.params.offset || 0)) * (o.params.speed ?? 1);
    m.mixer.setTime(Math.min(Math.max(0, ct), Math.max(0, m.clipLength - 1e-4)));
  }

  _rebuildObjPath() {
    if (!this.objPath) {
      this.objPath = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: ACCENT, dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.8 }));
      this.objKeyDots = new THREE.Group();
      this.helpers.add(this.objPath, this.objKeyDots);
    }
    const o = store.state.selection && store.object(store.state.selection);
    const has = !!o?.anim?.length && o.anim.length > 1;
    this.objPath.visible = this.objKeyDots.visible = has;
    this.objKeyDots.clear();
    if (!has) return;
    const t0 = o.anim[0].t, t1 = o.anim[o.anim.length - 1].t;
    const tl = { ...store.doc.timeline, speed: 'linear', start: 0 }; // anim key times are action time
    const N = Math.max(2, Math.ceil((t1 - t0) * 30));
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const p = sampleObject(o, tl, t0 + ((t1 - t0) * i) / N).position;
      pts.push(new THREE.Vector3(p[0], p[1] + 0.02, p[2]));
    }
    this.objPath.geometry.dispose();
    this.objPath.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.objPath.computeLineDistances();
    const dotGeo = new THREE.SphereGeometry(0.06, 10, 8), dotMat = new THREE.MeshBasicMaterial({ color: ACCENT });
    for (const k of o.anim) { const d = new THREE.Mesh(dotGeo, dotMat); d.position.fromArray(k.position).setY(k.position[1] + 0.02); this.objKeyDots.add(d); }
  }

  tick() {
    const { view, time, camDirty } = store.state;
    if (!store.doc) return;
    this.poseObjects(time);
    this._stepAim();
    this._stepFly();
    // shot camera follows the timeline unless the user is hand-framing it
    if (!(view === 'shot' && camDirty)) this.poseCamera(this.shotCam, time, view === 'shot' ? this.shotOrbit : null);
    if (view === 'free') {
      this.freeOrbit.update();
      this._applyRoll(this.freeCam, this.freeOrbit, this.freeRoll);
      this._updateRig();
    } else if (camDirty) this._applyRoll(this.shotCam, this.shotOrbit, this.shotRoll);
    this.renderer.render(this.scene, this.activeCam);
  }

  _updateRig() {
    const cam = this.shotCam;
    const has = store.doc.timeline.keys.length > 0;
    this.rig.visible = this.aimLine.visible = this.targetDot.visible = has;
    if (!has) return;
    this.rig.position.copy(cam.position);
    this.rig.quaternion.copy(cam.quaternion);
    const d = 0.9, hh = Math.tan((cam.fov * DEG) / 2) * d, hw = hh * cam.aspect;
    const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new THREE.Vector3(x, y, -d));
    const o = new THREE.Vector3();
    const seg = [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0],
      new THREE.Vector3(-hw * 0.35, hh * 1.08, -d), new THREE.Vector3(0, hh * 1.4, -d),
      new THREE.Vector3(0, hh * 1.4, -d), new THREE.Vector3(hw * 0.35, hh * 1.08, -d)];
    this.rigLines.geometry.setFromPoints(seg);
    const s = sampleCamera(store.doc.timeline, store.state.time);
    this.targetDot.position.fromArray(s.target);
    this.aimLine.geometry.setFromPoints([cam.position, this.targetDot.position]);
  }

  // ---------- offscreen rendering (snapshots, storyboard, export) ----------
  /**
   * Render the shot camera at time t into an offscreen canvas of width × height.
   * Helpers and gizmos are hidden; the grid follows opts.grid (default: the scene setting).
   * opts.timeline renders another shot's camera and action instead of the active one.
   */
  renderShot(t, width, height, { grid, view = 'shot', from, target, fov, timeline = store.doc.timeline } = {}) {
    if (!this.off || this.off.w !== width || this.off.h !== height) {
      this.off?.renderer.dispose();
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      this.off = { renderer, w: width, h: height, cam: new THREE.PerspectiveCamera(40, width / height, 0.05, 2000) };
    }
    const { renderer, cam } = this.off;
    if (from && target) { // a camera of the agent's own, e.g. to check one area without touching the user's view
      cam.position.fromArray(from); cam.up.set(0, 1, 0); cam.lookAt(...target); cam.fov = fov || 40;
    } else if (view === 'free') { cam.position.copy(this.freeCam.position); cam.quaternion.copy(this.freeCam.quaternion); cam.fov = this.freeCam.fov; }
    else this.poseCamera(cam, t, null, timeline);
    cam.aspect = width / height; cam.updateProjectionMatrix();
    const restore = [[this.helpers, this.helpers.visible], [this.gizmoHelper, this.gizmoHelper.visible], [this.grid, this.grid.visible]];
    this.helpers.visible = false; this.gizmoHelper.visible = false;
    if (grid != null) this.grid.visible = !!grid;
    const sel = store.state.selection && this.meshes.get(store.state.selection);
    if (sel) { sel.edges.material.color.set(0x000000); sel.edges.material.opacity = 0.22; this._tint(sel, false); }
    this.poseObjects(t, timeline);
    renderer.render(this.scene, cam);
    this.poseObjects(store.state.time);
    for (const [o, v] of restore) o.visible = v;
    if (sel) this._applySelection();
    return renderer.domElement;
  }
}
