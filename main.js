import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import GUI from "lil-gui";
import { FlyControls } from "./fly-controls.js";
import { WalkControls } from "./walk-controls.js";
import { buildVoxelGrid } from "./voxel-grid.js";

const $ = (id) => document.getElementById(id);

// ---------- Scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const GLIDE_KEY = "splat-viewer:orbitGlide";
let savedGlide = null;
try { savedGlide = localStorage.getItem(GLIDE_KEY); } catch {}
const view = { fov: 60, background: "#111316", orbitGlide: savedGlide !== "false" };
scene.background = new THREE.Color(view.background);

const camera = new THREE.PerspectiveCamera(view.fov, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 0.5, 3);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

// Lights only affect regular meshes (the walking character); splats carry their own color.
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1, 2, 1.5);
scene.add(sun);

// modelRoot carries the orientation fix. The splat inside it is offset so the
// scan's center sits at the origin, which makes rotations spin it in place.
const modelRoot = new THREE.Group();
scene.add(modelRoot);

let splat = null;
let splatCount = 0;
let modelRadius = 1;
let fileName = null;

function toast(text, ms = 3500) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), ms);
}

// ---------- Controls ----------

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = view.orbitGlide;

// Glide = orbit keeps drifting after you let go; off = it stops dead.
function setOrbitGlide(on) {
  view.orbitGlide = on;
  orbit.enableDamping = on;
  try { localStorage.setItem(GLIDE_KEY, String(on)); } catch {}
}

const fly = new FlyControls(camera, renderer.domElement);
const walk = new WalkControls(camera, renderer.domElement, scene);

const MODES = ["orbit", "fly", "walk"];
const MODE_LABELS = { orbit: "Orbit", fly: "Fly", walk: "Walk" };
let mode = "orbit";

function syncModeLabel() {
  guiState.mode = MODE_LABELS[mode];
  $("hud-mode").textContent = MODE_LABELS[mode];
}

async function setMode(next) {
  if (next === "walk" && !(await prepareCollision())) {
    syncModeLabel();
    return;
  }

  const prev = mode;
  mode = next;
  orbit.enabled = mode === "orbit";
  fly.enabled = mode === "fly";
  if (prev === "fly" && mode !== "fly") fly.unlock();
  walk.setEnabled(mode === "walk");

  if (mode === "fly") {
    fly.syncFromCamera();
  } else if (mode === "orbit") {
    // Orbit around a point straight ahead, as far away as the model's center.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const dist = Math.max(camera.position.length(), modelRadius * 0.05);
    orbit.target.copy(camera.position).addScaledVector(forward, dist);
    orbit.update();
  } else if (mode === "walk") {
    // From orbit, land near the point being orbited; from fly, land below the camera.
    const look = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    const from = prev === "orbit"
      ? orbit.target.clone()
      : camera.position.clone().setY(camera.position.y - walk.height * 0.9);
    if (!walk.spawn(from.x, from.z, from.y, look.y)) {
      toast("Couldn't find anywhere to stand in this scan");
      return setMode("orbit");
    }
    toast("Click to look around · WASD walk · Space jump · Scroll zoom", 5000);
  }
  syncModeLabel();
}

document.addEventListener("pointerlockchange", () => {
  document.body.classList.toggle("locked", document.pointerLockElement === renderer.domElement);
});

function recenter() {
  if (mode === "walk") {
    walk.spawn(0, 0, 0, walk.yaw);
    return;
  }
  const dir = new THREE.Vector3(0, 0.35, 1).normalize();
  camera.position.copy(dir.multiplyScalar(modelRadius * 1.6));
  camera.lookAt(0, 0, 0);
  orbit.target.set(0, 0, 0);
  orbit.update();
  fly.syncFromCamera();
}

// ---------- Collision (invisible blocks the character walks on) ----------

const collisionSettings = {
  blockSize: 0.05,
  minOpacity: 0.15,
  minSplats: 1,
  maxSplatSize: 1,
  fillHoles: true,
  addFloor: true,
  show: false,
};
let collision = null;
let collisionDirty = true;
let collisionView = null;

async function prepareCollision() {
  if (!splat) {
    toast("Load a scan first");
    return false;
  }
  if (collision && !collisionDirty) return true;
  toast("Building collision…");
  await new Promise((r) => setTimeout(r, 30)); // let the message paint first
  try {
    const start = performance.now();
    collision = buildVoxelGrid(splat, { ...collisionSettings, headroom: walk.height * 1.5 });
    collisionDirty = false;
    walk.grid = collision;
    console.info(`Collision: ${collision.solidCount} solid blocks, grid ${collision.dims.join("×")}, ` +
      `${Math.round(performance.now() - start)} ms`);
    $("hud-collision").textContent = `${collision.solidCount.toLocaleString()} blocks`;
    updateCollisionView();
    return true;
  } catch (err) {
    console.error(err);
    toast(`Couldn't build collision: ${err.message ?? err}`);
    return false;
  }
}

function invalidateCollision() {
  collisionDirty = true;
  if (mode === "walk") rebuildCollision();
  else if (collisionSettings.show) prepareCollision();
}

async function rebuildCollision() {
  collisionDirty = true;
  if (!(await prepareCollision())) return;
  if (mode === "walk") walk.spawn(walk.position.x, walk.position.z, walk.position.y, walk.yaw);
}

// Debug view: a dot at every solid block, colored by height.
function updateCollisionView() {
  if (collisionView) {
    scene.remove(collisionView);
    collisionView.geometry.dispose();
    collisionView.material.dispose();
    collisionView = null;
  }
  if (!collisionSettings.show || !collision || collisionDirty) return;

  const positions = collision.solidCenters();
  const colors = new Float32Array(positions.length);
  const top = collision.dims[1] * collision.size;
  const color = new THREE.Color();
  for (let i = 0; i < positions.length; i += 3) {
    const t = (positions[i + 1] - collision.min.y) / top;
    color.setHSL(0.66 - 0.66 * t, 0.9, 0.55);
    colors.set([color.r, color.g, color.b], i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: collision.size * 0.8, vertexColors: true });
  collisionView = new THREE.Points(geometry, material);
  scene.add(collisionView);
}

async function setCollisionVisible(on) {
  collisionSettings.show = on;
  if (on && !(await prepareCollision())) collisionSettings.show = false;
  updateCollisionView();
}

// ---------- Orientation (remembered per file name) ----------

const DEFAULT_ORIENTATION = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));
const orientKey = (name) => `splat-viewer:orientation:${name}`;

function loadOrientation(name) {
  try {
    const saved = JSON.parse(localStorage.getItem(orientKey(name)));
    if (Array.isArray(saved) && saved.length === 4) return new THREE.Quaternion().fromArray(saved);
  } catch {}
  return DEFAULT_ORIENTATION.clone();
}

function saveOrientation() {
  if (!fileName) return;
  try {
    localStorage.setItem(orientKey(fileName), JSON.stringify(modelRoot.quaternion.toArray()));
  } catch {}
}

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

function rotateModel(axis, angle) {
  const turn = new THREE.Quaternion().setFromAxisAngle(AXES[axis], angle);
  modelRoot.quaternion.premultiply(turn).normalize();
  saveOrientation();
  invalidateCollision();
}

function resetOrientation() {
  modelRoot.quaternion.copy(DEFAULT_ORIENTATION);
  saveOrientation();
  invalidateCollision();
}

// ---------- Loading ----------

// Center and size from the 2nd–98th percentile of splat positions, so a few
// stray floaters far away don't throw off the framing.
function robustBounds(mesh) {
  const xs = [], ys = [], zs = [];
  let count = 0;
  mesh.forEachSplat((index, center) => {
    count++;
    if (index % 4 === 0) {
      xs.push(center.x);
      ys.push(center.y);
      zs.push(center.z);
    }
  });
  const range = (values) => {
    const sorted = Float32Array.from(values).sort();
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return [at(0.02), at(0.98)];
  };
  const [x0, x1] = range(xs), [y0, y1] = range(ys), [z0, z1] = range(zs);
  const center = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const radius = Math.max(new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).length() / 2, 1e-3);
  return { center, radius, count };
}

function setStatus(text) {
  $("status").textContent = text;
}

async function loadSplat({ bytes, url, name }) {
  $("drop").classList.remove("hidden");
  setStatus(`Loading ${name}…`);
  const start = performance.now();
  try {
    const mesh = new SplatMesh(
      bytes
        ? { fileBytes: bytes, fileName: name }
        : {
            url,
            onProgress: (e) => {
              if (e.lengthComputable) setStatus(`Downloading ${name}… ${Math.round((100 * e.loaded) / e.total)}%`);
            },
          },
    );
    await mesh.initialized;

    if (mode === "walk") await setMode("orbit");
    if (splat) {
      modelRoot.remove(splat);
      splat.dispose();
    }
    splat = mesh;
    modelRoot.add(splat);
    collision = null;
    collisionDirty = true;
    walk.grid = null;
    updateCollisionView();
    $("hud-collision").textContent = "–";

    const { center, radius, count } = robustBounds(splat);
    splat.position.copy(center).negate();
    modelRadius = radius;
    splatCount = count;
    fileName = name;
    modelRoot.quaternion.copy(loadOrientation(name));

    camera.near = radius / 1000;
    camera.far = radius * 200;
    camera.updateProjectionMatrix();
    fly.minSpeed = radius * 0.002;
    fly.maxSpeed = radius * 20;
    fly.setSpeed(radius * 0.4);
    recenter();

    $("hud-file").textContent = name.length > 24 ? name.slice(0, 22) + "…" : name;
    $("hud-file").title = name;
    $("hud-splats").textContent = splatCount.toLocaleString();
    $("hud-load").textContent = `${((performance.now() - start) / 1000).toFixed(1)} s`;
    $("drop").classList.add("hidden");
    setStatus("");
    if (collisionSettings.show) setCollisionVisible(true);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't load ${name}: ${err.message ?? err}`);
  }
}

async function loadFile(file) {
  if (!file) return;
  setStatus(`Reading ${file.name}…`);
  $("drop").classList.remove("hidden");
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadSplat({ bytes, name: file.name });
}

function openFilePicker() {
  if (document.pointerLockElement) document.exitPointerLock();
  $("file-input").click();
}

$("open-btn").addEventListener("click", openFilePicker);
$("file-input").addEventListener("change", (e) => {
  loadFile(e.target.files[0]);
  e.target.value = "";
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  $("drop").classList.remove("hidden");
  $("drop").classList.add("over");
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget) return;
  $("drop").classList.remove("over");
  if (splat) $("drop").classList.add("hidden");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
  else if (splat) $("drop").classList.add("hidden");
});

// ---------- Settings panel ----------

const guiState = {
  mode: "Orbit",
  // Rounded view of the fly speed so the panel doesn't show 15 decimals.
  get speed() { return Number(fly.speed.toPrecision(3)); },
  set speed(v) { fly.setSpeed(v); },
  get showCollision() { return collisionSettings.show; },
  set showCollision(v) { setCollisionVisible(v); },
  rotateX: () => rotateModel("x", Math.PI / 2),
  rotateY: () => rotateModel("y", Math.PI / 2),
  rotateZ: () => rotateModel("z", Math.PI / 2),
  flip: () => rotateModel("x", Math.PI),
  resetOrientation,
  recenter,
  open: openFilePicker,
  toggleView: () => walk.toggleView(),
  respawn: () => walk.respawn(),
  rebuild: rebuildCollision,
};

const gui = new GUI({ title: "Settings" });
gui.add(guiState, "mode", Object.values(MODE_LABELS)).name("Mode").listen()
  .onChange((v) => setMode(v.toLowerCase()));

const flyFolder = gui.addFolder("Fly controls");
flyFolder.add(guiState, "speed").name("Speed (scroll)").listen();
flyFolder.add(fly, "boost", 1, 10, 0.5).name("Shift boost ×");
flyFolder.add(fly, "slow", 0.05, 1, 0.05).name("Alt slow ×");
flyFolder.add(fly, "lookSensitivity", 0.0005, 0.006, 0.0001).name("Look sensitivity");
flyFolder.add(fly, "smoothing", 0, 0.5, 0.01).name("Smoothing (s)");
flyFolder.close();

const walkFolder = gui.addFolder("Walk controls");
walkFolder.add(walk, "height", 0.1, 5, 0.05).name("Player height");
walkFolder.add(walk, "walkSpeed", 0.5, 8, 0.1).name("Walk speed");
walkFolder.add(walk, "runMultiplier", 1, 5, 0.1).name("Shift run ×");
walkFolder.add(walk, "jumpHeight", 0, 3, 0.05).name("Jump height");
walkFolder.add(walk, "gravity", 1, 30, 0.1).name("Gravity");
walkFolder.add(walk, "cameraDistance", 0, 17, 0.1).name("Camera distance").listen()
  .onChange(() => { walk.avatar.visible = walk.enabled && walk.cameraDistance > 0; });
walkFolder.add(walk, "lookSensitivity", 0.0005, 0.006, 0.0001).name("Look sensitivity");
walkFolder.add(guiState, "toggleView").name("1st / 3rd person  (V)");
walkFolder.add(guiState, "respawn").name("Back to last ground  (T)");

const collisionFolder = gui.addFolder("Collision");
collisionFolder.add(guiState, "showCollision").name("Show blocks  (C)").listen();
collisionFolder.add(collisionSettings, "blockSize", 0.02, 0.3, 0.01).name("Block size");
collisionFolder.add(collisionSettings, "minOpacity", 0.05, 0.95, 0.05).name("Min splat opacity");
collisionFolder.add(collisionSettings, "minSplats", 1, 10, 1).name("Splats per block");
collisionFolder.add(collisionSettings, "maxSplatSize", 0.05, 2, 0.05).name("Ignore splats over");
collisionFolder.add(collisionSettings, "fillHoles").name("Fill pinholes");
collisionFolder.add(collisionSettings, "addFloor").name("Add flat floor");
collisionFolder.add(guiState, "rebuild").name("Rebuild collision");
collisionFolder.close();

const viewFolder = gui.addFolder("View");
viewFolder.add(view, "fov", 30, 110, 1).name("Field of view").onChange((v) => {
  camera.fov = v;
  camera.updateProjectionMatrix();
});
viewFolder.addColor(view, "background").name("Background").onChange((v) => scene.background.set(v));
viewFolder.add(view, "orbitGlide").name("Orbit glide  (G)").listen().onChange(setOrbitGlide);

const modelFolder = gui.addFolder("Model");
modelFolder.add(guiState, "rotateX").name("Rotate 90° about X  (1)");
modelFolder.add(guiState, "rotateY").name("Rotate 90° about Y  (2)");
modelFolder.add(guiState, "rotateZ").name("Rotate 90° about Z  (3)");
modelFolder.add(guiState, "flip").name("Flip upside down  (U)");
modelFolder.add(guiState, "resetOrientation").name("Reset orientation");
modelFolder.add(guiState, "recenter").name("Recenter view  (R)");
modelFolder.add(guiState, "open").name("Open file…  (O)");

// ---------- Keyboard shortcuts ----------

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.repeat || e.ctrlKey || e.metaKey) return;
  switch (e.code) {
    case "KeyF": setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]); break;
    case "KeyR": recenter(); break;
    case "KeyV": if (mode === "walk") walk.toggleView(); break;
    case "KeyT": if (mode === "walk") walk.respawn(); break;
    case "KeyC": setCollisionVisible(!collisionSettings.show); break;
    case "KeyG":
      setOrbitGlide(!view.orbitGlide);
      toast(`Orbit glide ${view.orbitGlide ? "on" : "off"}`, 1500);
      break;
    case "Digit1": guiState.rotateX(); break;
    case "Digit2": guiState.rotateY(); break;
    case "Digit3": guiState.rotateZ(); break;
    case "KeyU": guiState.flip(); break;
    case "KeyH": $("help").classList.toggle("hidden"); break;
    case "KeyO": openFilePicker(); break;
  }
});

// ---------- Render loop ----------

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
let frames = 0;
let lastHud = performance.now();
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3));

function step(dt) {
  if (mode === "fly") fly.update(dt);
  else if (mode === "walk") walk.update(dt);
  else orbit.update();
}

renderer.setAnimationLoop((time) => {
  timer.update(time);
  step(Math.min(timer.getDelta(), 0.1));
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastHud >= 500) {
    $("hud-fps").textContent = Math.round((frames * 1000) / (now - lastHud));
    $("hud-speed").textContent =
      mode === "fly" ? `${fmt(fly.velocity.length())} / ${fmt(fly.speed)} u/s`
      : mode === "walk" ? `${fmt(walk.speed)} u/s${walk.onGround ? "" : " · airborne"}`
      : "–";
    const p = camera.position;
    $("hud-pos").textContent = `${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}`;
    frames = 0;
    lastHud = now;
  }
});

// Handles for poking at the viewer from the browser console.
window.viewer = { scene, camera, renderer, walk, fly, step, setMode, get collision() { return collision; } };

// ---------- Startup: ?url=path/to/scan.ply loads a file served next to the page ----------

const startUrl = new URLSearchParams(location.search).get("url");
if (startUrl) loadSplat({ url: startUrl, name: decodeURIComponent(startUrl.split("/").pop()) });
