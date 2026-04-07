import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';

// Scene, camera, renderer
let scene, camera, renderer, controls;
let animationId = null;
let lastDt = 0.016;
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
const pickedTargetPos = new THREE.Vector3();   // raw cursor position
const pickedCurrentPos = new THREE.Vector3();  // spring follow position
const pickedSpringVel = new THREE.Vector3();   // spring velocity (causes overshoot)
const pickedTargetVel = new THREE.Vector3();   // smoothed cursor velocity for throw
const pickedTargetPrev = new THREE.Vector3();
const pickedPosPrev = new THREE.Vector3();     // previous spring position for velocity tracking
// Pendulum hang offset
const hangOffset = new THREE.Vector3();        // current XZ swing offset
const hangVel = new THREE.Vector3();           // pendulum velocity

// Mallet state
let malletGroup = null;
let malletHeld = false;
let malletReturning = false;
let malletRestPosition = new THREE.Vector3();
let malletRestRotation = new THREE.Euler();
// Cursor tracking for mallet
const malletTargetPos = new THREE.Vector3();
const malletCurrentPos = new THREE.Vector3();
let malletLagFactor = 0.13;
const malletVelocity = new THREE.Vector3();
const malletPrevVelocity = new THREE.Vector3();
// Swing animation state
let malletSwinging = false;
let malletSwingT = 0;          // 0→1 animation progress
let malletSwingDir = 1;        // +1 down, -1 up
let malletBaseRotZ = 0;        // rotation.z at swing start
const SWING_ANGLE = Math.PI * 0.5;   // 90° arc
const SWING_DURATION = 0.38;         // seconds
// Flick detection: rolling window of recent screen-Y deltas
const flickWindow = [];              // { dy, t } entries (screen pixels, timestamp)
const FLICK_WINDOW_MS = 100;         // look back this far
const FLICK_THRESHOLD_PX = 70;      // net downward px displacement to trigger swing
const FLICK_DIRECTION_RATIO = 0.6;  // net dy must be >= 60% of total abs movement (mostly downward)
// Held drag plane at table-top height for mallet
const malletDragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
// Handle grip offset (fraction of full length above tip)
const GRIP_OFFSET_FRAC = 0.25;
const THROW_SCALE = 0.5;
const GRAB_STIFFNESS = 400;
const GRAB_DAMPING = 28;

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
    loadMallet(box);
  });

  loadSlotModel(0, '/assets/Models/stone.glb', 0.16);
  loadSlotModel(1, '/assets/Models/stick.glb', 0.175, { x: 1.3, y: 1.3, z: 1.3 });
  loadSlotModel(2, '/assets/Models/coal.glb', 0.16);

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
  setSlotItem(2, '/assets/Images/coalPng.png');
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
  const trimeshDesc = RAPIER.ColliderDesc
    .trimesh(new Float32Array(verts), new Uint32Array(indices))
    .setRestitution(0.3)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
    .setFriction(0.6);
  world.createCollider(trimeshDesc, tableBody);
}

// ─── Mallet placement ─────────────────────────────────────────────────────────

function loadMallet(tableBox) {
  loader.load('/assets/Models/mallet.glb', (gltf) => {
    const raw = gltf.scene;
    const mbox = new THREE.Box3().setFromObject(raw);
    const center = mbox.getCenter(new THREE.Vector3());
    const size = mbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // Offset so handle tip (bottom of model) is at group origin — pivot point for rotation
    raw.position.sub(center);
    raw.position.y += size.y / 2;  // shift up so bottom is at 0
    const group = new THREE.Group();
    group.add(raw);
    const targetSize = 0.625;
    group.scale.setScalar(targetSize / maxDim);

    // Flip upside down (rest pose)
    group.rotation.z = Math.PI;

    const scaledHalfDepth = (size.z / maxDim) * targetSize / 2;
    const restPos = new THREE.Vector3(
      (tableBox.min.x + tableBox.max.x) / 2,
      tableBox.min.y + (tableBox.max.y - tableBox.min.y) / 2,
      tableBox.max.z + scaledHalfDepth
    );
    group.position.copy(restPos);

    // Scaled half-height — used to offset grip point to handle tip
    const scaledHalfHeight = (size.y / maxDim) * targetSize / 2;
    malletGroup = group;
    malletGroup.userData.halfHeight = scaledHalfHeight;

    scene.add(group);
    malletRestPosition.copy(restPos);
    malletRestRotation.copy(group.rotation);
    malletDragPlane.constant = -tableTopY;

    // Click to grab
    renderer.domElement.addEventListener('pointerdown', onMalletPointerDown);
  });
}

function onMalletPointerDown(e) {
  if (isDragging || pickedEntry || malletHeld || !malletGroup) return;

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const hits = raycaster.intersectObject(malletGroup, true);
  if (hits.length === 0) return;

  e.stopPropagation();
  malletHeld = true;
  malletReturning = false;
  malletSwinging = false;
  renderer.domElement.style.cursor = 'grabbing';
  malletVelocity.set(0, 0, 0);
  malletPrevVelocity.set(0, 0, 0);
  flickWindow.length = 0;
  _prevClientY = null;
  _prevClientX = null;
  _malletTilt = 0;
  malletCurrentPos.copy(malletTargetPos);
  controls.enabled = false;

  // Flip right-side up when grabbed, rotated 20° on Y
  malletGroup.rotation.set(0, -30 * (Math.PI / 180), 0);

  // Set target to current cursor position
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(malletDragPlane, hit);
  malletTargetPos.copy(hit.length() > 0 ? hit : malletGroup.position);
}

// ─── Stone loading ────────────────────────────────────────────────────────────

function loadSlotModel(slotIndex, path, targetSize, axisScale = {}) {
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
      if (maxDim > 0) {
        const s = targetSize / maxDim;
        group.scale.set(
          s * (axisScale.x ?? 1),
          s * (axisScale.y ?? 1),
          s * (axisScale.z ?? 1)
        );
      }
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

  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;

  const { x, y, z } = mesh.position;
  const q = mesh.quaternion;

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    .setLinearDamping(0.2)
    .setAngularDamping(0.05);
  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc
    .cuboid(hx, hy, hz)
    .setRestitution(0.05)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setFriction(0.6);
  world.createCollider(colliderDesc, body);

  // Add a tiny off-center bump at the base so sticks always tip over
  if (mesh.userData.slotIndex === 1) {
    const angle = Math.random() * Math.PI * 2;
    const bumpOffset = 0.012;
    const bumpDesc = RAPIER.ColliderDesc.ball(0.004)
      .setTranslation(Math.cos(angle) * bumpOffset, -hy, Math.sin(angle) * bumpOffset);
    world.createCollider(bumpDesc, body);
  }

  stoneBodies.push({ mesh, body, slotIndex: mesh.userData.slotIndex });
  return body;
}

function nearVerticalQuat() {
  // Base: undo the baked x=PI/2 rotation so stick points up in world space
  const base = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  // Small random tilt 15–20°
  const maxAngle = (15 + Math.random() * 5) * (Math.PI / 180);
  const tiltAngle = Math.random() * maxAngle;
  const tiltAxis = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
  const tilt = new THREE.Quaternion().setFromAxisAngle(tiltAxis, tiltAngle);
  base.premultiply(tilt);
  return { x: base.x, y: base.y, z: base.z, w: base.w };
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
  dragStoneInitialized = false;
  dragStoneVel.set(0, 0, 0);
  controls.enabled = false;
  renderer.domElement.style.cursor = 'grabbing';

  dragStone = template.clone();
  dragStone.visible = false;
  dragStone.userData.slotIndex = parseInt(slotIndex);
  if (dragStone.userData.slotIndex === 1) {
    const q = nearVerticalQuat();
    dragStone.quaternion.set(q.x, q.y, q.z, q.w);
  }
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
  renderer.domElement.style.cursor = 'grabbing';
  entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);

  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(dragPlane, hit)) {
    pickedTargetPos.copy(hit);
    pickedCurrentPos.copy(hit);
    pickedTargetPrev.copy(hit);
    pickedPosPrev.copy(hit);
    entry.body.setNextKinematicTranslation({ x: hit.x, y: hit.y, z: hit.z });
  }
  pickedTargetVel.set(0, 0, 0);
  pickedSpringVel.set(0, 0, 0);
  hangOffset.set(0, 0, 0);
  hangVel.set(0, 0, 0);
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

const dragStoneTargetPos = new THREE.Vector3();
const dragStoneCurrentPos = new THREE.Vector3();
const dragStoneVel = new THREE.Vector3();
let dragStoneInitialized = false;

function positionStoneAtCursor(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(dragPlane, hit)) {
    raycaster.ray.at(4, hit);
  }

  if (!dragStoneInitialized) {
    dragStoneCurrentPos.copy(hit);
    dragStoneVel.set(0, 0, 0);
    dragStoneInitialized = true;
  }
  dragStoneTargetPos.copy(hit);
}

let _prevClientY = null;
let _prevClientX = null;
let _malletTilt = 0;  // current tilt angle (radians), lerped each frame

function onPointerMove(e) {
  if (malletHeld && malletGroup) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(malletDragPlane, hit)) {
      malletTargetPos.copy(hit);
    }

    // Track screen deltas for tilt and flick detection
    if (!malletSwinging) {
      const now = performance.now();
      const dx = _prevClientX !== null ? e.clientX - _prevClientX : 0;
      const dy = _prevClientY !== null ? e.clientY - _prevClientY : 0;
      _prevClientX = e.clientX;
      _prevClientY = e.clientY;

      // Tilt: moving right → tilt left (negative Z), moving left → tilt right (positive Z)
      // dx in screen pixels per frame; scale to radians, clamp to ±18°
      const MAX_TILT = 18 * (Math.PI / 180);
      const tiltTarget = Math.max(-MAX_TILT, Math.min(MAX_TILT, dx * 0.18));
      _malletTilt = _malletTilt + (tiltTarget - _malletTilt) * 0.12;

      if (dy !== 0) flickWindow.push({ dy, t: now });
      // Also track X for horizontal flick detection
      if (dx !== 0) flickWindow.push({ dy: 0, dx, t: now });

      // Prune old entries
      const cutoff = now - FLICK_WINDOW_MS;
      while (flickWindow.length && flickWindow[0].t < cutoff) flickWindow.shift();

      // Sum displacement in window
      const netDy = flickWindow.reduce((s, f) => s + f.dy, 0);
      const netDx = flickWindow.reduce((s, f) => s + (f.dx ?? 0), 0);
      const absDx = flickWindow.reduce((s, f) => s + Math.abs(f.dx ?? 0), 0);
      // Trigger on leftward horizontal flick (right-to-left, negative netDx)
      const isLeftFlick = netDx <= -FLICK_THRESHOLD_PX && absDx > 0 && (-netDx / absDx) >= FLICK_DIRECTION_RATIO;
      // Only trigger on downward flick with mostly-downward motion
      if (isLeftFlick && netDy >= FLICK_THRESHOLD_PX) {
        malletSwinging = true;
        malletSwingT = 0;
        malletSwingDir = 1; // always swing down
        malletBaseRotZ = malletGroup.rotation.z;
        flickWindow.length = 0;
        _prevClientY = null;
        _prevClientX = null;
      }
    }
    return;
  }

  if (pickedEntry) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, hit)) {
      pickedTargetPos.copy(hit);
    }
    return;
  }

  // Hover cursor — check if over mallet or any scene object
  if (!isDragging && isOverCanvas(e.clientX, e.clientY)) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const hoverTargets = [...stoneBodies.map(s => s.mesh), ...(malletGroup ? [malletGroup] : [])];
    const hits = raycaster.intersectObjects(hoverTargets, true);
    renderer.domElement.style.cursor = hits.length > 0 ? 'grab' : '';
  } else if (!isDragging) {
    renderer.domElement.style.cursor = '';
  }

  if (!isDragging) return;
  moveDragGhost(e.clientX, e.clientY);

  if (!dragStone) return;

  if (isOverCanvas(e.clientX, e.clientY)) {
    dragStone.visible = true;
    positionStoneAtCursor(e.clientX, e.clientY);
    if (dragGhost) dragGhost.style.display = 'none';
  } else {
    dragStone.visible = false;
    if (dragGhost) dragGhost.style.display = '';
  }
}

function onPointerUp(e) {
  if (malletHeld && malletGroup) {
    malletHeld = false;
    malletReturning = true;
    malletVelocity.set(0, 0, 0);
    controls.enabled = true;
    renderer.domElement.style.cursor = '';
    return;
  }

  if (pickedEntry) {
    pickedEntry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const tv = pickedTargetVel;
    pickedEntry.body.setLinvel({
      x: tv.x * THROW_SCALE, y: tv.y * THROW_SCALE, z: tv.z * THROW_SCALE
    }, true);
    pickedEntry.body.setAngvel({
      x: tv.z * THROW_SCALE * 4, y: 0, z: -tv.x * THROW_SCALE * 4
    }, true);
    pickedEntry = null;
    controls.enabled = true;
    renderer.domElement.style.cursor = '';
    return;
  }

  if (!isDragging) return;
  isDragging = false;
  renderer.domElement.style.cursor = '';

  if (dragGhost) { dragGhost.remove(); dragGhost = null; }

  if (dragStone && dragStone.visible && isOverCanvas(e.clientX, e.clientY)) {
    const body = addStonePhysics(dragStone);
    body.setLinvel({ x: dragStoneVel.x * THROW_SCALE, y: dragStoneVel.y * THROW_SCALE, z: dragStoneVel.z * THROW_SCALE }, true);
  } else {
    if (dragStone) scene.remove(dragStone);
  }
  dragStone = null;
  controls.enabled = true;
}

// ─── Physics step ─────────────────────────────────────────────────────────────

function updatePhysics() {
  if (!world) return;

  if (pickedEntry) {
    // Spring toward cursor
    const diff = pickedTargetPos.clone().sub(pickedCurrentPos);
    pickedSpringVel.addScaledVector(diff, GRAB_STIFFNESS * lastDt);
    pickedSpringVel.addScaledVector(pickedSpringVel, -GRAB_DAMPING * lastDt);
    pickedCurrentPos.addScaledVector(pickedSpringVel, lastDt);


    // const xzSpeed = Math.sqrt(
    //   pickedTargetVel.x * pickedTargetVel.x + pickedTargetVel.z * pickedTargetVel.z
    // );
    // const sag = Math.min(xzSpeed * 0.04, 0.18);
    pickedEntry.body.setNextKinematicTranslation({
      x: pickedCurrentPos.x,
      y: pickedCurrentPos.y,
      z: pickedCurrentPos.z
    });

    // Track actual spring position velocity for throw on release
    const posDelta = pickedCurrentPos.clone().sub(pickedPosPrev);
    const instantVel = posDelta.divideScalar(Math.max(lastDt, 0.001));
    pickedTargetVel.lerp(instantVel, 0.5);
    pickedPosPrev.copy(pickedCurrentPos);
  }

  world.step();

  for (const { mesh, body } of stoneBodies) {
    const { x, y, z } = body.translation();
    const rot = body.rotation();
    mesh.position.set(x, y, z);
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  }
}

// ─── Mallet update ────────────────────────────────────────────────────────────

function updateDragStoneSpring(dt) {
  if (!isDragging || !dragStone || !dragStone.visible || !dragStoneInitialized) return;
  const diff = dragStoneTargetPos.clone().sub(dragStoneCurrentPos);
  dragStoneVel.addScaledVector(diff, GRAB_STIFFNESS * dt);
  dragStoneVel.addScaledVector(dragStoneVel, -GRAB_DAMPING * dt);
  dragStoneCurrentPos.addScaledVector(dragStoneVel, dt);
  dragStone.position.copy(dragStoneCurrentPos);
}

function updateMallet(dt) {
  if (!malletGroup) return;

  const halfHeight = malletGroup.userData.halfHeight ?? 0;
  // Grip offset in local space: positive Y moves the hold point up the handle
  const gripOffset = halfHeight * GRIP_OFFSET_FRAC * 2;

  if (malletHeld) {
    // Lag position toward cursor — feels like dragging a weighted object
    malletCurrentPos.lerp(malletTargetPos, malletLagFactor);
    malletGroup.position.copy(malletCurrentPos);
    malletGroup.position.y -= gripOffset;

    // Apply swing animation (overrides free rotation while active)
    if (malletSwinging) {
      malletSwingT += dt / SWING_DURATION;
      if (malletSwingT >= 1) {
        malletSwingT = 1;
        malletSwinging = false;
      }
      // Ease-in-out cubic
      const ease = malletSwingT < 0.5
        ? 4 * malletSwingT * malletSwingT * malletSwingT
        : 1 - Math.pow(-2 * malletSwingT + 2, 3) / 2;
      malletGroup.rotation.z = malletBaseRotZ + malletSwingDir * SWING_ANGLE * ease;
    } else {
      // Decay tilt back toward 0 when not moving
      _malletTilt *= 0.90;
      malletGroup.rotation.z += (_malletTilt - malletGroup.rotation.z) * 0.08;
    }

  } else if (malletReturning) {
    // Lerp back to rest position and rotation
    malletGroup.position.lerp(malletRestPosition, 0.08);
    malletGroup.rotation.x += (malletRestRotation.x - malletGroup.rotation.x) * 0.08;
    malletGroup.rotation.y += (malletRestRotation.y - malletGroup.rotation.y) * 0.08;
    malletGroup.rotation.z += (malletRestRotation.z - malletGroup.rotation.z) * 0.08;

    if (malletGroup.position.distanceTo(malletRestPosition) < 0.001) {
      malletGroup.position.copy(malletRestPosition);
      malletGroup.rotation.copy(malletRestRotation);
      malletReturning = false;
    }
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
  const dt = Math.min(clock.getDelta(), 0.05);
  lastDt = dt;

  updatePhysics();
  updateMallet(dt);
  updateDragStoneSpring(dt);

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

  const lagSlider = document.getElementById('lag-slider');
  const lagDisplay = document.getElementById('lag-display');
  lagSlider.addEventListener('input', (e) => {
    malletLagFactor = parseFloat(e.target.value);
    lagDisplay.textContent = malletLagFactor.toFixed(2);
  });

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
