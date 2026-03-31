import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';

// Scene, camera, renderer
let scene, camera, renderer, controls;
let animationId = null;
let autoAnimate = false;
let currentProgress = 0;
let objects = [];

// Stone drag state
const slotTemplates = {};   // slot index → hidden template mesh, cloned for each drag
let dragStone = null;       // clone currently following the mouse
let isDragging = false;
let dragGhost = null;
let tableTopY = 0;

// Pick-up state (clicking existing scene stones)
let pickedEntry = null;     // { mesh, body } being held

// Drag plane for 3D hover positioning
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const clock = new THREE.Clock();
const loader = new GLTFLoader();

// Rapier physics
let world = null;
const stoneBodies = []; // { mesh, body }

// ─── Rapier init ──────────────────────────────────────────────────────────────

async function initPhysics() {
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -2.5, z: 0 });
}

// ─── Scene init ───────────────────────────────────────────────────────────────

async function init() {
  await initPhysics();

  const canvas = document.getElementById('scene-canvas');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(3, 4, 3);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
  scene.add(gridHelper);
  const axesHelper = new THREE.AxesHelper(5);
  scene.add(axesHelper);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 10, 5);
  scene.add(directionalLight);

  // Load crafting table
  loader.load('/assets/Models/craftingtable.glb', (gltf) => {
    const model = gltf.scene;
    scene.add(model);
    objects.push(model);

    // Ensure world matrices are current before extracting geometry
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    tableTopY = box.max.y;
    dragPlane.constant = -(tableTopY + 0.4);

    const topCenter = new THREE.Vector3(
      (box.min.x + box.max.x) / 2,
      box.max.y,
      (box.min.z + box.max.z) / 2
    );
    topCenter.y -= 0.4;
    controls.target.copy(topCenter);

    const offset = new THREE.Vector3(3, 4, 3).normalize().multiplyScalar(
      camera.position.distanceTo(topCenter) / 3
    );
    camera.position.copy(topCenter).add(offset);
    controls.update();

    addTablePhysics(model);
  });

  loadSlotModel(0, '/assets/Models/stone.glb', 0.175);
  loadSlotModel(1, '/assets/Models/stick.glb', 0.175);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableZoom = true;
  controls.enablePan = false;
  controls.rotateSpeed = 0.4;
  controls.zoomSpeed = 1.2;
  controls.update();

  window.addEventListener('resize', onResize);
  setupControls();
  setupDrag();
  animate();

  setSlotItem(0, '/assets/Images/stonePng.png');
  setSlotItem(1, '/assets/Images/stickPng.png');
}

// ─── Table trimesh collider ───────────────────────────────────────────────────

function addTablePhysics(model) {
  const verts = [];
  const indices = [];
  let indexOffset = 0;

  model.traverse((child) => {
    if (!child.isMesh) return;
    child.updateWorldMatrix(true, false);
    const geo = child.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();

    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
        .applyMatrix4(child.matrixWorld);
      verts.push(v.x, v.y, v.z);
    }

    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(indexOffset + idx.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(indexOffset + i);
    }
    indexOffset += pos.count;
  });

  const tableBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const colliderDesc = RAPIER.ColliderDesc
    .trimesh(new Float32Array(verts), new Uint32Array(indices))
    .setRestitution(0.3)
    .setFriction(0.6);
  world.createCollider(colliderDesc, tableBody);
}

// ─── Stone loading ────────────────────────────────────────────────────────────

function loadSlotModel(slotIndex, path, targetSize) {
  loader.load(
    path,
    (gltf) => {
      const raw = gltf.scene;
      const box = new THREE.Box3().setFromObject(raw);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);

      raw.position.sub(center);

      const group = new THREE.Group();
      group.add(raw);
      if (maxDim > 0) group.scale.setScalar(targetSize / maxDim);
      group.visible = false;
      scene.add(group);
      slotTemplates[slotIndex] = group;
    },
    undefined,
    () => {
      // fallback box
      const geo = new THREE.BoxGeometry(0.125, 0.075, 0.125);
      const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.9 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      slotTemplates[slotIndex] = mesh;
    }
  );
}

// ─── Stone physics body ───────────────────────────────────────────────────────

function addStonePhysics(mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const { x, y, z } = mesh.position;

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinearDamping(0.2)
    .setAngularDamping(0.2);
  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc
    .cuboid(size.x / 2, size.y / 2, size.z / 2)
    .setRestitution(0.3)
    .setFriction(0.6);
  world.createCollider(colliderDesc, body);

  stoneBodies.push({ mesh, body });
}

// ─── Drag-to-scene system ─────────────────────────────────────────────────────

function setupDrag() {
  document.querySelectorAll('.slot').forEach(slot => {
    slot.addEventListener('pointerdown', onSlotPointerDown);
  });
  renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
}

function onSlotPointerDown(e) {
  const img = e.currentTarget.querySelector('img');
  const slotIndex = e.currentTarget.dataset.slot;
  const template = slotTemplates[slotIndex];
  if (!img || !template || isDragging) return;

  e.preventDefault();
  isDragging = true;
  controls.enabled = false;

  dragStone = template.clone();
  dragStone.visible = false;
  scene.add(dragStone);

  dragGhost = document.createElement('div');
  dragGhost.id = 'drag-ghost';
  dragGhost.appendChild(img.cloneNode(true));
  document.body.appendChild(dragGhost);
  moveDragGhost(e.clientX, e.clientY);
}

function onCanvasPointerDown(e) {
  if (isDragging || pickedEntry) return;

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const meshes = stoneBodies.map(s => s.mesh);
  const hits = raycaster.intersectObjects(meshes, true);
  if (hits.length === 0) return;

  const hitObj = hits[0].object;
  const entry = stoneBodies.find(s => {
    let found = false;
    s.mesh.traverse(c => { if (c === hitObj) found = true; });
    return found;
  });
  if (!entry) return;

  e.stopPropagation();
  pickedEntry = entry;
  controls.enabled = false;
  entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);

  // Snap to cursor immediately without waiting for pointermove
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(dragPlane, hit)) {
    entry.body.setNextKinematicTranslation({ x: hit.x, y: hit.y, z: hit.z });
  }
}

function moveDragGhost(x, y) {
  if (!dragGhost) return;
  dragGhost.style.left = x + 'px';
  dragGhost.style.top = y + 'px';
}

function isOverCanvas(x, y) {
  const rect = renderer.domElement.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function positionStoneAtCursor(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(dragPlane, hit)) {
    dragStone.position.copy(hit);
  } else {
    raycaster.ray.at(4, hit);
    dragStone.position.copy(hit);
  }
}

function onPointerMove(e) {
  if (pickedEntry) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, hit)) {
      pickedEntry.body.setNextKinematicTranslation({ x: hit.x, y: hit.y, z: hit.z });
    }
    return;
  }

  if (!isDragging) return;
  moveDragGhost(e.clientX, e.clientY);

  if (!dragStone) return;

  if (isOverCanvas(e.clientX, e.clientY)) {
    dragStone.visible = true;
    positionStoneAtCursor(e.clientX, e.clientY);
    if (dragGhost) dragGhost.style.opacity = '0.25';
  } else {
    dragStone.visible = false;
    if (dragGhost) dragGhost.style.opacity = '1';
  }
}

function onPointerUp(e) {
  if (pickedEntry) {
    pickedEntry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    pickedEntry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    pickedEntry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    pickedEntry = null;
    controls.enabled = true;
    return;
  }

  if (!isDragging) return;
  isDragging = false;

  if (dragGhost) { dragGhost.remove(); dragGhost = null; }

  if (dragStone && dragStone.visible && isOverCanvas(e.clientX, e.clientY)) {
    addStonePhysics(dragStone);
  } else {
    if (dragStone) scene.remove(dragStone);
  }
  dragStone = null;
  controls.enabled = true;
}

// ─── Physics step ─────────────────────────────────────────────────────────────

function updatePhysics() {
  if (!world) return;
  world.step();

  for (const { mesh, body } of stoneBodies) {
    const { x, y, z } = body.translation();
    const rot = body.rotation();
    mesh.position.set(x, y, z);
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  }
}

// ─── Scene loop ───────────────────────────────────────────────────────────────

function updateScene(progress) {
  currentProgress = progress;
  document.getElementById('progress-display').textContent = progress.toFixed(2);
  document.getElementById('progress-slider').value = progress * 100;
}

function animate() {
  animationId = requestAnimationFrame(animate);
  clock.getDelta(); // keep clock ticking for future use

  updatePhysics();

  if (autoAnimate) {
    currentProgress += 0.002;
    if (currentProgress > 1) currentProgress = 0;
    updateScene(currentProgress);
  }

  controls.update();
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

function setupControls() {
  const slider = document.getElementById('progress-slider');
  const resetBtn = document.getElementById('reset-btn');
  const animateBtn = document.getElementById('animate-btn');

  slider.addEventListener('input', (e) => {
    updateScene(parseFloat(e.target.value) / 100);
  });

  resetBtn.addEventListener('click', () => updateScene(0));

  animateBtn.addEventListener('click', () => {
    autoAnimate = !autoAnimate;
    animateBtn.classList.toggle('active', autoAnimate);
    animateBtn.textContent = autoAnimate ? 'Stop Animation' : 'Auto Animate';
  });
}

// ─── Inventory slot API ───────────────────────────────────────────────────────

export function setSlotItem(index, imageSrc) {
  const slot = document.querySelector(`.slot[data-slot="${index}"]`);
  if (!slot) return;
  slot.innerHTML = `<img src="${imageSrc}" alt="item" draggable="false" />`;
}

export function clearSlot(index) {
  const slot = document.querySelector(`.slot[data-slot="${index}"]`);
  if (slot) slot.innerHTML = '';
}

export function clearAllSlots() {
  document.querySelectorAll('.slot').forEach(s => s.innerHTML = '');
}

init();
