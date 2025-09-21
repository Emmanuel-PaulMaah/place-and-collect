import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { XRButton } from 'https://unpkg.com/three@0.160.0/examples/jsm/webxr/XRButton.js';

let renderer, scene, camera, clock;
let xrRefSpace, xrViewerSpace, hitTestSource = null;

let reticle;
let spawnRoot = null;      // where coins are spawned (placed by user)
let placed = false;        // has the user placed the spawn point?
let paused = false;

const coins = new Set();
let score = 0;

const MAX_COINS = 30;
const SPAWN_INTERVAL_MS = 1400;
const COIN_RADIUS = 0.12;       // torus outer radius
const COLLECT_RADIUS = 0.5;     // meters from head to collect
const SPAWN_RADIUS_MIN = 0.6;   // around spawn root
const SPAWN_RADIUS_MAX = 2.6;
const COIN_LIFETIME = 20000;

// UI
const $score = document.getElementById('score');
const $alive = document.getElementById('alive');
const $status = document.getElementById('status');
const $btnReset = document.getElementById('reset');
const $btnPause = document.getElementById('pause');
const $btnBurst = document.getElementById('burst');

let lastSpawnAt = 0;

init();

function init() {
  // renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  // scene + camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);
  scene.fog = new THREE.FogExp2(0x000000, 0.16);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333366, 1.0));

  // reticle
  reticle = makeReticle();
  reticle.visible = false;
  scene.add(reticle);

  // spawn root (invisible until placed)
  spawnRoot = new THREE.Group();
  scene.add(spawnRoot);

  // input
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', onResize);

  // controls
  $btnReset.addEventListener('click', resetGame);
  $btnPause.addEventListener('click', () => { paused = !paused; $btnPause.textContent = paused ? 'resume' : 'pause'; });
  $btnBurst.addEventListener('click', spawnBurst);

  // XR entry
  document.body.appendChild(XRButton.createButton(renderer, {
    requiredFeatures: ['hit-test', 'local-floor'],
    optionalFeatures: []
  }));

  // when XR session starts, set up hit-test
  renderer.xr.addEventListener('sessionstart', async () => {
    const session = renderer.xr.getSession();
    xrRefSpace = await session.requestReferenceSpace('local-floor');
    xrViewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: xrViewerSpace });
    clock = new THREE.Clock();
    lastSpawnAt = 0;
  });

  // clean up on end
  renderer.xr.addEventListener('sessionend', () => {
    hitTestSource = null;
    placed = false;
    $status.textContent = 'find a surface, then tap to place the spawn point.';
    $btnBurst.disabled = true;
  });

  // start loop
  renderer.setAnimationLoop(onXRFrame);

  window.__app = { THREE, scene, renderer, camera, coins };
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onXRFrame(time, frame) {
  const dt = clock ? clock.getDelta() : 0.016;

  // reticle update via hit-test
  updateReticle(frame);

  if (!paused && placed) {
    maybeSpawnCoins(time);
    updateCoins(dt, time);
    checkProximityCollect();
  }

  renderer.render(scene, camera);
}

function updateReticle(frame) {
  if (!hitTestSource || !frame) {
    reticle.visible = false;
    return;
  }
  const hits = frame.getHitTestResults(hitTestSource);
  if (hits.length) {
    const pose = hits[0].getPose(xrRefSpace);
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);
    } else {
      reticle.visible = false;
    }
  } else {
    reticle.visible = false;
  }
  // surface hint
  if (!placed) {
    $status.textContent = reticle.visible
      ? 'tap to place spawn point.'
      : 'move your phone to help it find a surface…';
  }
}

function onPointerDown(e) {
  // if not placed yet and we have a reticle pose, place spawn root there
  if (!placed) {
    if (reticle.visible) {
      spawnRoot.position.copy(reticle.position);
      spawnRoot.quaternion.copy(reticle.quaternion);
      placed = true;
      $btnBurst.disabled = false;
      $status.textContent = 'walk into coins to collect them. they’ll keep spawning.';
    } else {
      // fallback: drop spawn 1.5m forward if no surface found (so demo never stalls)
      const xrCam = renderer.xr.getCamera(camera);
      const origin = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion).normalize();
      spawnRoot.position.copy(origin).addScaledVector(fwd, 1.5);
      spawnRoot.position.y -= 0.8; // rough guess for floor
      placed = true;
      $btnBurst.disabled = false;
      $status.textContent = 'fallback placement used. walk into coins to collect them.';
    }
    return;
  }

  // optional: allow tapping a coin to collect (handy in tight spaces)
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), renderer.xr.getCamera(camera));
  const hits = raycaster.intersectObjects(Array.from(coins), false);
  if (hits.length) collect(hits[0].object);
}

function maybeSpawnCoins(nowMs) {
  if (coins.size >= MAX_COINS) return;
  if (nowMs - lastSpawnAt < SPAWN_INTERVAL_MS * (0.7 + Math.random() * 0.8)) return;
  lastSpawnAt = nowMs;

  const c = makeCoin();
  positionCoinAroundRoot(c);
  scene.add(c);
  coins.add(c);
  updateHUD();
}

function makeCoin() {
  const geo = getSharedCoinGeo();
  const mat = getSharedCoinMat();
  const m = new THREE.Mesh(geo, mat);
  m.userData.type = 'coin';
  m.userData.createdAt = performance.now();
  m.userData.spin = (1.2 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1);
  m.userData.bobAmp = 0.06 + Math.random() * 0.06;
  m.userData.phase = Math.random() * Math.PI * 2;
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

let _coinGeo, _coinMat;
function getSharedCoinGeo() {
  if (!_coinGeo) _coinGeo = new THREE.TorusGeometry(COIN_RADIUS, 0.028, 12, 32);
  return _coinGeo;
}
function getSharedCoinMat() {
  if (!_coinMat) {
    _coinMat = new THREE.MeshStandardMaterial({
      color: 0xffd54a, emissive: 0x553300, metalness: 0.8, roughness: 0.25
    });
  }
  return _coinMat;
}

function positionCoinAroundRoot(m) {
  // random polar around spawnRoot on the placed plane (approx y)
  const r = THREE.MathUtils.lerp(SPAWN_RADIUS_MIN, SPAWN_RADIUS_MAX, Math.random());
  const theta = Math.random() * Math.PI * 2;
  const offset = new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r);

  // align offset with spawnRoot orientation (so "forward" respects placement)
  offset.applyQuaternion(spawnRoot.quaternion);

  const base = spawnRoot.position.clone().add(offset);
  base.y = spawnRoot.position.y + 0.02; // sit slightly above plane
  m.position.copy(base);

  // face coin roughly toward user for nicer look
  const xrCam = renderer.xr.getCamera(camera);
  m.lookAt(new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld));
}

function updateCoins(dt, nowMs) {
  const t = nowMs * 0.001;
  const toRemove = [];
  for (const c of coins) {
    // idle motion
    c.rotation.y += c.userData.spin * dt;
    c.position.y = spawnRoot.position.y + 0.02 + Math.sin(t + c.userData.phase) * c.userData.bobAmp;

    if (nowMs - c.userData.createdAt > COIN_LIFETIME) toRemove.push(c);
  }
  for (const c of toRemove) {
    scene.remove(c);
    coins.delete(c);
  }
  if (toRemove.length) updateHUD();
}

function checkProximityCollect() {
  const head = renderer.xr.getCamera(camera).position;
  const toRemove = [];
  for (const c of coins) {
    if (c.position.distanceTo(head) < COLLECT_RADIUS) toRemove.push(c);
  }
  for (const c of toRemove) collect(c);
}

function collect(obj) {
  if (!coins.has(obj)) return;
  coins.delete(obj);

  // quick sparkle-ish pop: scale + emissive flash
  const start = performance.now();
  const dur = 180;
  const startScale = obj.scale.x;
  const startEm = obj.material.emissive.getHex();

  function tween() {
    const t = Math.min(1, (performance.now() - start) / dur);
    const s = startScale * (1 + 1.2 * t);
    obj.scale.setScalar(s);
    obj.material.emissive.setHex(THREE.MathUtils.lerpColors(
      new THREE.Color(startEm), new THREE.Color(0xffffff), t
    ).getHex());
    obj.material.opacity = 1 - t;
    obj.material.transparent = true;

    if (t < 1) requestAnimationFrame(tween);
    else scene.remove(obj);
  }
  tween();

  score += 1;
  updateHUD();
}

function spawnBurst() {
  if (!placed) return;
  const n = Math.min(10, MAX_COINS - coins.size);
  for (let i = 0; i < n; i++) {
    const c = makeCoin();
    positionCoinAroundRoot(c);
    scene.add(c);
    coins.add(c);
  }
  updateHUD();
}

function resetGame() {
  for (const c of coins) scene.remove(c);
  coins.clear();
  score = 0;
  placed = false;
  $btnBurst.disabled = true;
  $btnPause.textContent = 'pause';
  paused = false;
  $status.textContent = 'find a surface, then tap to place the spawn point.';
  updateHUD();
}

function updateHUD() {
  $score.textContent = String(score);
  $alive.textContent = String(coins.size);
}

// ---- visuals

function makeReticle() {
  // thin ring + dot, oriented flat to the floor
  const g1 = new THREE.RingGeometry(0.06, 0.075, 48);
  const m1 = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const ring = new THREE.Mesh(g1, m1);
  ring.rotation.x = -Math.PI / 2;

  const g2 = new THREE.CircleGeometry(0.006, 16);
  const m2 = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const dot = new THREE.Mesh(g2, m2);
  dot.position.y = 0.001; // avoid z-fighting
  dot.rotation.x = -Math.PI / 2;

  const group = new THREE.Group();
  group.add(ring, dot);
  group.name = 'reticle';
  group.classList = ['reticle'];
  group.traverse(o => { if (o.material) o.material.depthTest = true; });
  group.matrixAutoUpdate = true;
  return group;
}

// tiny helper to lerp emissive (hex) cleanly
THREE.MathUtils.lerpColors = (c1, c2, t) => new THREE.Color(
  c1.r + (c2.r - c1.r) * t,
  c1.g + (c2.g - c1.g) * t,
  c1.b + (c2.b - c1.b) * t
);
