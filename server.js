
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// --- Scène de base ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101018);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.6, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

// --- Etat du mode choisi ---
let mode = null; // 'pc' ou 'vr'
const infoEl = document.getElementById('info');

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Lumières ---
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(2, 4, 2);
scene.add(dirLight);

// --- Sol de l'arène ---
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 8),
  new THREE.MeshStandardMaterial({ color: 0x2a2a35 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

// Grille pour repère visuel
const grid = new THREE.GridHelper(8, 16, 0x555566, 0x333340);
scene.add(grid);

// --- Murs simples (repères de l'arène) ---
const wallMat = new THREE.MeshStandardMaterial({ color: 0x1c1c24 });
function makeWall(x, z, rotY) {
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 2.5), wallMat);
  wall.position.set(x, 1.25, z);
  wall.rotation.y = rotY;
  scene.add(wall);
}
makeWall(0, -4, 0);
makeWall(0, 4, Math.PI);
makeWall(-4, 0, Math.PI / 2);
makeWall(4, 0, -Math.PI / 2);

// --- Cible ---
const targetGeo = new THREE.SphereGeometry(0.15, 16, 16);
const targetMat = new THREE.MeshStandardMaterial({ color: 0xd85a30 });
const target = new THREE.Mesh(targetGeo, targetMat);
scene.add(target);

function randomizeTarget() {
  const x = (Math.random() - 0.5) * 5;
  const y = 1 + Math.random() * 1.2;
  const z = (Math.random() - 0.5) * 5;
  target.position.set(x, y, z);
}
randomizeTarget();

// --- Score affiché sur un panneau flottant ---
let score = 0;
const scoreCanvas = document.createElement('canvas');
scoreCanvas.width = 256;
scoreCanvas.height = 128;
const scoreCtx = scoreCanvas.getContext('2d');
const scoreTexture = new THREE.CanvasTexture(scoreCanvas);

function drawScore() {
  scoreCtx.fillStyle = '#101018';
  scoreCtx.fillRect(0, 0, scoreCanvas.width, scoreCanvas.height);
  scoreCtx.fillStyle = '#ffffff';
  scoreCtx.font = '48px sans-serif';
  scoreCtx.textAlign = 'center';
  scoreCtx.textBaseline = 'middle';
  scoreCtx.fillText('Score: ' + score, scoreCanvas.width / 2, scoreCanvas.height / 2);
  scoreTexture.needsUpdate = true;
}
drawScore();

const scorePanel = new THREE.Mesh(
  new THREE.PlaneGeometry(0.6, 0.3),
  new THREE.MeshBasicMaterial({ map: scoreTexture })
);
scorePanel.position.set(0, 2.2, -3.9);
scene.add(scorePanel);

// --- Tir : fonction partagée entre manettes VR et souris PC ---
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

function tryShoot(origin, direction) {
  raycaster.ray.origin.copy(origin);
  raycaster.ray.direction.copy(direction);
  const intersections = raycaster.intersectObject(target);
  if (intersections.length > 0) {
    score += 1;
    drawScore();
    randomizeTarget();
  }
}

function onSelectStart(event) {
  const controller = event.target;
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);
  tryShoot(origin, direction);
}

const controller1 = renderer.xr.getController(0);
controller1.addEventListener('selectstart', onSelectStart);
scene.add(controller1);

const controller2 = renderer.xr.getController(1);
controller2.addEventListener('selectstart', onSelectStart);
scene.add(controller2);

// Ligne de visée simple sur chaque manette (aide visuelle)
const rayGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, -5)
]);
const rayLine1 = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
const rayLine2 = rayLine1.clone();
controller1.add(rayLine1);
controller2.add(rayLine2);

// --- Mode PC : déplacement clavier + visée souris + tir au clic ---
const pcControls = new PointerLockControls(camera, renderer.domElement);
const move = { forward: false, back: false, left: false, right: false };
const ARENA_LIMIT = 3.7;

document.addEventListener('keydown', (e) => {
  if (mode !== 'pc') return;
  if (e.code === 'KeyW') move.forward = true;
  if (e.code === 'KeyS') move.back = true;
  if (e.code === 'KeyA') move.left = true;
  if (e.code === 'KeyD') move.right = true;
});
document.addEventListener('keyup', (e) => {
  if (mode !== 'pc') return;
  if (e.code === 'KeyW') move.forward = false;
  if (e.code === 'KeyS') move.back = false;
  if (e.code === 'KeyA') move.left = false;
  if (e.code === 'KeyD') move.right = false;
});

renderer.domElement.addEventListener('click', () => {
  if (mode !== 'pc') return;
  if (!pcControls.isLocked) {
    pcControls.lock();
    return;
  }
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  tryShoot(camera.position, direction);
});

function updatePcMovement(delta) {
  if (mode !== 'pc' || !pcControls.isLocked) return;
  const speed = 2.5 * delta;
  if (move.forward) pcControls.moveForward(speed);
  if (move.back) pcControls.moveForward(-speed);
  if (move.right) pcControls.moveRight(speed);
  if (move.left) pcControls.moveRight(-speed);

  camera.position.x = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, camera.position.x));
  camera.position.z = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, camera.position.z));
  camera.position.y = 1.6;
}

// --- Choix du mode au démarrage ---
const menuEl = document.getElementById('menu');
const menuMsgEl = document.getElementById('menu-msg');

document.getElementById('btn-pc').addEventListener('click', () => {
  mode = 'pc';
  menuEl.style.display = 'none';
  infoEl.textContent = 'Mode PC — ZQSD/WASD pour bouger, souris pour viser, clic pour tirer';
});

document.getElementById('btn-vr').addEventListener('click', async () => {
  if (!navigator.xr) {
    menuMsgEl.textContent = "Ce navigateur ne supporte pas WebXR.";
    return;
  }
  const supported = await navigator.xr.isSessionSupported('immersive-vr');
  if (!supported) {
    menuMsgEl.textContent = "La VR immersive n'est pas disponible ici.";
    return;
  }
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor']
    });
    mode = 'vr';
    menuEl.style.display = 'none';
    infoEl.textContent = 'Mode VR — gâchette pour tirer';
    await renderer.xr.setSession(session);
    session.addEventListener('end', () => location.reload());
  } catch (err) {
    menuMsgEl.textContent = "Impossible de démarrer la session VR.";
  }
});

// --- Boucle de rendu ---
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  target.rotation.y += 0.01;
  updatePcMovement(delta);
  renderer.render(scene, camera);
});
