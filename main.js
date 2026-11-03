import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import GUI from "lil-gui";
import { FlyControls } from "./fly-controls.js";

const $ = (id) => document.getElementById(id);

// ---------- Scene ----------

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const view = { fov: 60, background: "#111316" };
scene.background = new THREE.Color(view.background);

const camera = new THREE.PerspectiveCamera(view.fov, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 0.5, 3);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

// modelRoot carries the orientation fix. The splat inside it is offset so the
// scan's center sits at the origin, which makes rotations spin it in place.
const modelRoot = new THREE.Group();
scene.add(modelRoot);

let splat = null;
let splatCount = 0;
let modelRadius = 1;
let fileName = null;

// ---------- Controls ----------

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

const fly = new FlyControls(camera, renderer.domElement);

let mode = "orbit";

function setMode(next) {
  mode = next;
  if (mode === "fly") {
    orbit.enabled = false;
    fly.enabled = true;
    fly.syncFromCamera();
  } else {
    fly.unlock();
    fly.enabled = false;
    // Orbit around a point straight ahead, as far away as the model's center.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const dist = Math.max(camera.position.length(), modelRadius * 0.05);
    orbit.target.copy(camera.position).addScaledVector(forward, dist);
    orbit.enabled = true;
    orbit.update();
  }
  guiState.mode = mode === "fly" ? "Fly" : "Orbit";
  $("hud-mode").textContent = guiState.mode;
}

document.addEventListener("pointerlockchange", () => {
  document.body.classList.toggle("locked", fly.isLocked);
});

function recenter() {
  const dir = new THREE.Vector3(0, 0.35, 1).normalize();
  camera.position.copy(dir.multiplyScalar(modelRadius * 1.6));
  camera.lookAt(0, 0, 0);
  orbit.target.set(0, 0, 0);
  orbit.update();
  fly.syncFromCamera();
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
}

function resetOrientation() {
  modelRoot.quaternion.copy(DEFAULT_ORIENTATION);
  saveOrientation();
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

    if (splat) {
      modelRoot.remove(splat);
      splat.dispose();
    }
    splat = mesh;
    modelRoot.add(splat);

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
  fly.unlock();
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
  rotateX: () => rotateModel("x", Math.PI / 2),
  rotateY: () => rotateModel("y", Math.PI / 2),
  rotateZ: () => rotateModel("z", Math.PI / 2),
  flip: () => rotateModel("x", Math.PI),
  resetOrientation,
  recenter,
  open: openFilePicker,
};

const gui = new GUI({ title: "Settings" });
gui.add(guiState, "mode", ["Orbit", "Fly"]).name("Mode").listen()
  .onChange((v) => setMode(v.toLowerCase()));

const flyFolder = gui.addFolder("Fly controls");
flyFolder.add(guiState, "speed").name("Speed (scroll)").listen();
flyFolder.add(fly, "boost", 1, 10, 0.5).name("Shift boost ×");
flyFolder.add(fly, "slow", 0.05, 1, 0.05).name("Alt slow ×");
flyFolder.add(fly, "lookSensitivity", 0.0005, 0.006, 0.0001).name("Look sensitivity");
flyFolder.add(fly, "smoothing", 0, 0.5, 0.01).name("Smoothing (s)");

const viewFolder = gui.addFolder("View");
viewFolder.add(view, "fov", 30, 110, 1).name("Field of view").onChange((v) => {
  camera.fov = v;
  camera.updateProjectionMatrix();
});
viewFolder.addColor(view, "background").name("Background").onChange((v) => scene.background.set(v));

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
    case "KeyF": setMode(mode === "fly" ? "orbit" : "fly"); break;
    case "KeyR": recenter(); break;
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

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (mode === "fly") fly.update(dt);
  else orbit.update();
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastHud >= 500) {
    $("hud-fps").textContent = Math.round((frames * 1000) / (now - lastHud));
    $("hud-speed").textContent = mode === "fly"
      ? `${fmt(fly.velocity.length())} / ${fmt(fly.speed)} u/s`
      : "–";
    const p = camera.position;
    $("hud-pos").textContent = `${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}`;
    frames = 0;
    lastHud = now;
  }
});

// ---------- Startup: ?url=path/to/scan.ply loads a file served next to the page ----------

const startUrl = new URLSearchParams(location.search).get("url");
if (startUrl) loadSplat({ url: startUrl, name: decodeURIComponent(startUrl.split("/").pop()) });
