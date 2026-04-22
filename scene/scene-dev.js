import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
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
let tableBox = null;

// Mallet bounce-back state
let malletBouncing = false;
let malletBounceTargetZ = 0;
let malletContactPos = null;

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

// Drag lag (shared by pick-up and inventory drag) — same style as mallet
const DRAG_LAG_FACTOR = 0.16;
const CLICK_TOGGLE_ITEMS = true;  // true = click to grab, click again to drop; false = hold to drag

// Idle rotation when holding an object
const HELD_IDLE_ROTATION = false;              // toggle to enable slow idle spin while held
const heldIdleQuat = new THREE.Quaternion();   // accumulated idle rotation
const heldIdleAxis = new THREE.Vector3();      // current rotation axis
let heldIdleSpeed = 0;                         // radians/sec

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
const FLICK_WINDOW_MS = 85;          // look back this far
const FLICK_THRESHOLD_PX = 138;     // net downward px displacement to trigger swing
const FLICK_DIRECTION_RATIO = 0.72; // net dy must be >= 72% of total abs movement (mostly downward)
// Held drag plane at table-top height for mallet
const malletDragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
// Handle grip offset (fraction of full length above tip)
const GRIP_OFFSET_FRAC = 0.25;
const THROW_SCALE = 0.3;
const GRAB_STIFFNESS = 400;
const GRAB_DAMPING = 28;
const MALLET_STIFFNESS = 150;
const MALLET_DAMPING = 18;

// Drag plane for 3D hover positioning
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const clock = new THREE.Clock();
const loader = new GLTFLoader();

// Rapier physics
let world = null;
let eventQueue = null;
const stoneBodies = []; // { mesh, body }

// Bloom post-processing
let composer = null;
let bloomComposer = null;
let bloomPass = null;
const BLOOM_LAYER = 1;
const bloomLayer = new THREE.Layers();
bloomLayer.set(BLOOM_LAYER);
const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
const storedMaterials = {};  // uuid → original material

// Slot glow state
const slotEdgeLines = [];       // index 0–8, top edge lines
const slotEdgeLinesBottom = []; // index 0–8, bottom edge lines
const slotTopPositions = [];    // index 0–8, raw top positions array for recomputing bottom
const slotCenters = [];     // world-space center of each slot hole
const slotFilled = [];      // boolean per slot
const slotItemType = [];    // index 0–8, inventory slotIndex of item in slot (or -1)
const SLOT_GLOW_COLOR = new THREE.Color(0xC8AA92);
const SLOT_GLOW_COLOR_RECIPE = new THREE.Color(0xFFBC85);
const SLOT_GLOW_INTENSITY = 2.5;
const SLOT_FILL_RADIUS = 0.06;       // XZ distance threshold to count as "in slot"
const SLOT_FILL_RADIUS_STICK = 0.11; // wider threshold for sticks (thin axis can be offset from slot center)
const SLOT_DEPTH = 0.13;        // how far down the bottom ring sits below the top ring

// Crafting recipes — slots are 1-indexed in comments, 0-indexed in code
// Item types: 0 = stone, 1 = stick, 2 = coal
const RECIPES = [
  { slots: { 0: 0, 1: 0, 2: 0, 4: 1, 7: 1 } }, // stone1,stone2,stone3 + stick5,stick8
];


// Mallet physics
let malletBody = null;
let malletCollider = null;
let malletHitFiredThisSwing = false;

// ─── Craft VFX ────────────────────────────────────────────────────────────────
const activeParticles = [];
let vfxContainer = null;
const VFX_COLORS = ['#FFD700', '#FFC300', '#FFFFFF', '#F5E642', '#FFA500', '#C8A96A', '#AAAAAA'];

function initVFX() {
  vfxContainer = document.createElement('div');
  vfxContainer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:100;';
  document.body.appendChild(vfxContainer);
}

function spawnCraftVFX(worldPos) {
  if (!vfxContainer || !camera) return;
  const projected = worldPos.clone().project(camera);
  const sx = (projected.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-projected.y * 0.5 + 0.5) * window.innerHeight;

  const count = 21;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i / count) + (Math.random() - 0.5) * 0.1;
    const speed = 175 + Math.random() * 275;
    const size = 60 + Math.floor(Math.random() * 75);
    const color = VFX_COLORS[Math.floor(Math.random() * VFX_COLORS.length)];
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;width:${size}px;height:${size}px;background:${color};pointer-events:none;left:${sx}px;top:${sy}px;`;
    vfxContainer.appendChild(el);
    activeParticles.push({
      el, x: sx, y: sy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.7 - 180,
      gravity: 760,
      life: 1.0,
      decay: 1.4 + Math.random() * 0.8,
    });
  }
}

function updateVFX(dt) {
  for (let i = activeParticles.length - 1; i >= 0; i--) {
    const p = activeParticles[i];
    p.life -= p.decay * dt;
    if (p.life <= 0) { p.el.remove(); activeParticles.splice(i, 1); continue; }
    p.vy += p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.el.style.left = p.x + 'px';
    p.el.style.top = p.y + 'px';
    p.el.style.opacity = Math.max(0, p.life);
  }
}

// ─── Slot Glow ────────────────────────────────────────────────────────────────

function loadSlotGlow() {
  loader.load('/assets/Models/craftingslotsfill.glb', (gltf) => {
    const slotsRoot = gltf.scene;
    slotsRoot.updateMatrixWorld(true);

    // Collect slot meshes sorted by name
    const slotMeshes = [];
    slotsRoot.traverse((child) => {
      if (child.isMesh && /^slot\d+$/i.test(child.name)) slotMeshes.push(child);
    });
    slotMeshes.sort((a, b) => {
      const numA = parseInt(a.name.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.name.replace(/\D/g, '')) || 0;
      return numA - numB;
    });

    for (let i = 0; i < slotMeshes.length; i++) {
      const slotMesh = slotMeshes[i];

      // World-space center for fill detection
      const box = new THREE.Box3().setFromObject(slotMesh);
      const center = box.getCenter(new THREE.Vector3());
      slotCenters[i] = center;
      slotFilled[i] = false;

      // Extract edges from the fill plane geometry
      const edges = new THREE.EdgesGeometry(slotMesh.geometry, 1);

      // Transform edge vertices into world space
      const posAttr = edges.getAttribute('position');
      const positionsTop = [];
      const positionsBottom = [];
      const v = new THREE.Vector3();
      for (let j = 0; j < posAttr.count; j++) {
        v.set(posAttr.getX(j), posAttr.getY(j), posAttr.getZ(j));
        v.applyMatrix4(slotMesh.matrixWorld);
        positionsTop.push(v.x, v.y + 0.001, v.z);
        positionsBottom.push(v.x, v.y + 0.001 - SLOT_DEPTH, v.z);
      }

      function makeLineSegments(positions) {
        const geo = new LineSegmentsGeometry();
        geo.setPositions(positions);
        const mat = new LineMaterial({
          color: SLOT_GLOW_COLOR.getHex(),
          linewidth: 2,
          transparent: true,
          opacity: 0,
          depthTest: true,
          resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
        });
        const ls = new LineSegments2(geo, mat);
        ls.layers.enable(BLOOM_LAYER);
        ls.renderOrder = 999;
        ls.frustumCulled = false;
        scene.add(ls);
        return ls;
      }

      slotTopPositions[i] = positionsTop;
      slotEdgeLines[i] = makeLineSegments(positionsTop);
      // slotEdgeLinesBottom[i] = makeLineSegments(positionsBottom);
    }
    // Don't add slotsRoot to scene — we only want the edge lines, not the fill planes
  });
}

function darkenNonBloom(obj) {
  if (obj.isMesh || obj.isLineSegments || obj.isLineSegments2 || obj.isLine) {
    if (!bloomLayer.test(obj.layers)) {
      storedMaterials[obj.uuid] = obj.material;
      obj.material = darkMaterial;
    }
  }
}

function restoreMaterial(obj) {
  if (storedMaterials[obj.uuid]) {
    obj.material = storedMaterials[obj.uuid];
    delete storedMaterials[obj.uuid];
  }
}

function updateSlotGlow() {
  if (slotCenters.length === 0) return;

  for (let i = 0; i < slotCenters.length; i++) {
    const center = slotCenters[i];
    if (!center) continue;

    // Check if any stone body is resting within this slot's XZ radius
    let filled = false;
    let itemType = -1;
    for (const { body, hy, slotIndex } of stoneBodies) {
      const t = body.translation();
      let checkX, checkY, checkZ;

      if (slotIndex === 1) {
        // Stick: find closest point on stick segment to slot center.
        // Stick long axis = body-local Z. Rotate (0,0,1) by body quaternion.
        const { x: qx, y: qy, z: qz, w: qw } = body.rotation();
        const axX = 2*(qw*qy + qx*qz);
        const axY = 2*(qy*qz - qw*qx);
        const axZ = 1 - 2*(qx*qx + qy*qy);
        const proj = (center.x-t.x)*axX + (center.y-t.y)*axY + (center.z-t.z)*axZ;
        const c = Math.max(-hy, Math.min(hy, proj));
        checkX = t.x + c*axX;
        checkY = t.y + c*axY;
        checkZ = t.z + c*axZ;
      } else {
        // Stones/coal: use bottom of body
        checkX = t.x; checkY = t.y - hy; checkZ = t.z;
      }

      const distXZ = Math.sqrt((checkX-center.x)**2 + (checkZ-center.z)**2);
      const fillRadius = slotIndex === 1 ? SLOT_FILL_RADIUS_STICK : SLOT_FILL_RADIUS;
      if (distXZ < fillRadius && tableTopY > 0 && checkY >= tableTopY - 0.15 && checkY <= tableTopY + 0.15) {
        filled = true;
        itemType = slotIndex;
        break;
      }
    }

    slotFilled[i] = filled;
    slotItemType[i] = itemType;
  }

  // Check if any recipe is fully matched
  let recipeMatch = false;
  for (const recipe of RECIPES) {
    const match = Object.entries(recipe.slots).every(
      ([pos, type]) => slotItemType[+pos] === type
    );
    if (match) { recipeMatch = true; break; }
  }

  const activeColor = recipeMatch ? SLOT_GLOW_COLOR_RECIPE : SLOT_GLOW_COLOR;

  // Smoothly lerp bloom strength toward recipe target
  if (bloomPass) {
    const targetStrength = recipeMatch ? 0.55 : 0.45;
    bloomPass.strength += (targetStrength - bloomPass.strength) * 0.05;
  }

  for (let i = 0; i < slotEdgeLines.length; i++) {
    const line = slotEdgeLines[i];
    if (!line) continue;

    // Smoothly fade glow in/out
    const targetOpacity = slotFilled[i] ? 1 : 0;
    const mat = line.material;
    mat.opacity += (targetOpacity - mat.opacity) * 0.08;
    mat.color.set(activeColor);

    const lineB = slotEdgeLinesBottom[i];
    if (lineB) { lineB.material.opacity = mat.opacity; lineB.material.color.set(activeColor); }
  }
}

// ─── Rapier init ──────────────────────────────────────────────────────────────

async function initPhysics() {
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -2.5, z: 0 });
  eventQueue = new RAPIER.EventQueue(true);
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

  // Selective bloom: bloom composer renders only BLOOM_LAYER objects
  const renderPass = new RenderPass(scene, camera);
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.45,   // strength
    0.1,  // radius
    0.1   // threshold
  );

  bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(renderPass);
  bloomComposer.addPass(bloomPass);

  // Final composer: normal render + additive bloom overlay
  const finalPass = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv);
        }
      `,
    }),
    'baseTexture'
  );
  finalPass.needsSwap = true;

  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(finalPass);
  composer.addPass(new OutputPass());

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
    tableBox = box;
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
    loadSlotGlow();
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

  initVFX();
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

  // Trimesh: only collides with stones (not the mallet)
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
      tableBox.max.y - 0.05,
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
    malletDragPlane.constant = -(tableTopY + 0.2);

    // ── Mallet physics body (kinematic) ──────────────────────────────────────
    group.updateMatrixWorld(true);
    const fullBbox = new THREE.Box3().setFromObject(group);
    const fSize = fullBbox.getSize(new THREE.Vector3());
    const fCenter = fullBbox.getCenter(new THREE.Vector3());
    // Long axis = mallet length direction
    const fAxis = fSize.x > fSize.y
      ? (fSize.x > fSize.z ? 'x' : 'z')
      : (fSize.y > fSize.z ? 'y' : 'z');
    const fHalf = fSize[fAxis] / 2;
    const fA = fCenter.clone(); fA[fAxis] += fHalf;
    const fB = fCenter.clone(); fB[fAxis] -= fHalf;
    // Head = end furthest from pivot (handle tip = group world position)
    const headWorldPos = fA.distanceTo(restPos) > fB.distanceTo(restPos) ? fA : fB;

    const bodyQuat = new THREE.Quaternion().setFromEuler(group.rotation);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(restPos.x, restPos.y, restPos.z)
      .setRotation({ x: bodyQuat.x, y: bodyQuat.y, z: bodyQuat.z, w: bodyQuat.w })
      .setGravityScale(0)
      .setLinearDamping(2)
      .setAngularDamping(10);
    malletBody = world.createRigidBody(bodyDesc);

    // Collider offset = head pos in body-local space
    const headOffset = headWorldPos.clone()
      .sub(restPos)
      .applyQuaternion(bodyQuat.clone().invert());
    const crossAxes = ['x', 'y', 'z'].filter(a => a !== fAxis);
    const headRadius = Math.max(
      Math.min(fSize[crossAxes[0]], fSize[crossAxes[1]]) * 0.5, 0.04
    );
    malletCollider = world.createCollider(
      RAPIER.ColliderDesc.ball(headRadius)
        .setTranslation(headOffset.x, headOffset.y, headOffset.z)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setDensity(80),
      malletBody
    );

    // Click to grab
    renderer.domElement.addEventListener('pointerdown', onMalletPointerDown);
  });
}

function onMalletPointerDown(e) {
  if (isDragging || pickedEntry || !malletGroup) return;

  // Toggle: if already held, drop it on any canvas click
  if (malletHeld) {
    malletHeld = false;
    malletReturning = true;
    malletVelocity.set(0, 0, 0);
    controls.enabled = true;
    renderer.domElement.style.cursor = '';
    if (malletBody) {
      malletBody.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    }
    return;
  }

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
  // Switch back to dynamic so collisions work while held
  if (malletBody) {
    malletBody.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    malletBody.setGravityScale(0, true);
  }
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
    .setAngularDamping(0.05)
    .setCcdEnabled(true);
  const body = world.createRigidBody(bodyDesc);

  const isStick = mesh.userData.slotIndex === 1;
  // Stick's long axis is body-local Z (inner mesh has baked rotation.x=PI/2 which maps Z→Y visually,
  // so the capsule must be rotated PI/2 around X to align with body-local Z instead of Y)
  const stickCapsuleRot = { x: Math.sin(Math.PI / 4), y: 0, z: 0, w: Math.cos(Math.PI / 4) };
  const capsuleHH = Math.max(0.001, hy - Math.min(hx, hz));
  const capsuleR = Math.min(hx, hz);
  const colliderDesc = isStick
    ? RAPIER.ColliderDesc.capsule(capsuleHH, capsuleR).setRotation(stickCapsuleRot)
    : RAPIER.ColliderDesc.cuboid(hx, hy, hz);
  colliderDesc
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

  let debugMesh = null;
  if (isStick) {
    const debugGeo = new THREE.CapsuleGeometry(capsuleR, capsuleHH * 2, 4, 8);
    // Bake PI/2 around X into geometry so it aligns with body-local Z (matching the collider rotation)
    debugGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    const debugMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
    debugMesh = new THREE.Mesh(debugGeo, debugMat);
    scene.add(debugMesh);
  }

  stoneBodies.push({ mesh, body, hy, slotIndex: mesh.userData.slotIndex, debugMesh });
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

// ─── Held idle rotation ───────────────────────────────────────────────────────

function resetHeldIdle(mesh) {
  // Seed idle rotation from current mesh orientation so there's no snap
  heldIdleQuat.copy(mesh.quaternion);
  // Pick a random axis and speed (0.4–0.9 rad/s)
  heldIdleAxis.set(
    Math.random() - 0.5,
    Math.random() - 0.5,
    Math.random() - 0.5
  ).normalize();
  heldIdleSpeed = 0.4 + Math.random() * 0.5;
}

function updateHeldIdle(dt) {
  const delta = new THREE.Quaternion().setFromAxisAngle(heldIdleAxis, heldIdleSpeed * dt);
  heldIdleQuat.multiply(delta);
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
  if (HELD_IDLE_ROTATION) resetHeldIdle(dragStone);

  dragGhost = document.createElement('div');
  dragGhost.id = 'drag-ghost';
  dragGhost.appendChild(img.cloneNode(true));
  document.body.appendChild(dragGhost);
  moveDragGhost(e.clientX, e.clientY);
}

function releasePicked() {
  pickedEntry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  const tv = pickedTargetVel;
  pickedEntry.body.setLinvel({ x: tv.x * THROW_SCALE, y: tv.y * THROW_SCALE, z: tv.z * THROW_SCALE }, true);
  pickedEntry.body.setAngvel({ x: tv.z * THROW_SCALE * 4, y: 0, z: -tv.x * THROW_SCALE * 4 }, true);
  pickedEntry = null;
  controls.enabled = true;
  renderer.domElement.style.cursor = '';
}

function releaseInventoryDrag(clientX, clientY) {
  isDragging = false;
  renderer.domElement.style.cursor = '';
  if (dragGhost) { dragGhost.remove(); dragGhost = null; }
  if (dragStone && dragStone.visible && isOverCanvas(clientX, clientY)) {
    const body = addStonePhysics(dragStone);
    body.setLinvel({ x: dragStoneVel.x * THROW_SCALE, y: dragStoneVel.y * THROW_SCALE, z: dragStoneVel.z * THROW_SCALE }, true);
  } else {
    if (dragStone) scene.remove(dragStone);
  }
  dragStone = null;
  controls.enabled = true;
}

function onCanvasPointerDown(e) {
  // Toggle-drop for picked object
  if (CLICK_TOGGLE_ITEMS && pickedEntry) {
    releasePicked();
    return;
  }
  // Toggle-drop for inventory drag
  if (CLICK_TOGGLE_ITEMS && isDragging) {
    releaseInventoryDrag(e.clientX, e.clientY);
    return;
  }
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
  if (HELD_IDLE_ROTATION) resetHeldIdle(entry.mesh);

  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(dragPlane, hit)) {
    pickedTargetPos.copy(hit);
    pickedCurrentPos.copy(hit);
    pickedTargetPrev.copy(hit);
    pickedPosPrev.copy(hit);
    // Teleport body directly to target (bypasses kinematic sweep, which gets blocked
    // when the body is embedded inside the table's slot geometry, e.g. a fallen stick)
    entry.body.setTranslation({ x: hit.x, y: hit.y, z: hit.z }, true);
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
const dragStonePrevPos = new THREE.Vector3();
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
    dragStonePrevPos.copy(hit);
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
        malletSwingDir = 1;
        malletBaseRotZ = malletGroup.rotation.z;
        malletHitFiredThisSwing = false;
        malletBouncing = false;
        malletContactPos = null;
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
  if (CLICK_TOGGLE_ITEMS) return;

  if (pickedEntry) {
    releasePicked();
    return;
  }

  if (!isDragging) return;
  releaseInventoryDrag(e.clientX, e.clientY);
}

// ─── Physics step ─────────────────────────────────────────────────────────────

function updatePhysics() {
  if (!world) return;

  if (pickedEntry) {
    // Lag position toward cursor — same as mallet
    pickedCurrentPos.lerp(pickedTargetPos, DRAG_LAG_FACTOR);


    // const xzSpeed = Math.sqrt(
    //   pickedTargetVel.x * pickedTargetVel.x + pickedTargetVel.z * pickedTargetVel.z
    // );
    // const sag = Math.min(xzSpeed * 0.04, 0.18);
    if (HELD_IDLE_ROTATION) updateHeldIdle(lastDt);
    pickedEntry.body.setNextKinematicTranslation({
      x: pickedCurrentPos.x,
      y: pickedCurrentPos.y,
      z: pickedCurrentPos.z
    });
    if (HELD_IDLE_ROTATION) pickedEntry.body.setNextKinematicRotation({
      x: heldIdleQuat.x,
      y: heldIdleQuat.y,
      z: heldIdleQuat.z,
      w: heldIdleQuat.w
    });

    // Track cursor velocity for throw on release
    const posDelta = pickedTargetPos.clone().sub(pickedPosPrev);
    const instantVel = posDelta.divideScalar(Math.max(lastDt, 0.001));
    pickedTargetVel.lerp(instantVel, 0.5);
    pickedPosPrev.copy(pickedTargetPos);
  }

  // Mallet physics: dynamic with spring force when held, kinematic lerp when returning
  if (malletBody && malletGroup) {
    if (malletHeld) {
      const halfHeight = malletGroup.userData.halfHeight ?? 0;
      const gripOff = halfHeight * GRIP_OFFSET_FRAC * 2;

      const pos = malletBody.translation();
      const vel = malletBody.linvel();

      malletBody.resetForces(true);
      malletBody.addForce({
        x: MALLET_STIFFNESS * (malletTargetPos.x - pos.x) - MALLET_DAMPING * vel.x,
        y: MALLET_STIFFNESS * (malletTargetPos.y - gripOff - pos.y) - MALLET_DAMPING * vel.y,
        z: MALLET_STIFFNESS * (malletTargetPos.z - pos.z) - MALLET_DAMPING * vel.z,
      }, true);

      // Sync body rotation from visual (rotation handled by updateMallet)
      const q = malletGroup.quaternion;
      malletBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      malletBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      // Kinematic return — lerp toward rest, no collisions
      const p = malletGroup.position;
      const q = malletGroup.quaternion;
      malletBody.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      malletBody.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  world.step(eventQueue);

  // Always drain so the queue doesn't back up
  if (eventQueue) eventQueue.drainCollisionEvents(() => {});

  // Detect mallet head entering table bbox during a swing
  if (malletCollider && malletSwinging && tableBox && !malletHitFiredThisSwing) {
    const t = malletCollider.translation();
    const headPt = new THREE.Vector3(t.x, t.y, t.z);
    const inXZ = headPt.x >= tableBox.min.x - 0.06 && headPt.x <= tableBox.max.x + 0.06
               && headPt.z >= tableBox.min.z - 0.06 && headPt.z <= tableBox.max.z + 0.06;
    if (inXZ && headPt.y <= tableBox.max.y + 0.15) {
      malletHitFiredThisSwing = true;
      malletContactPos = headPt;
    }
  }

  for (const { mesh, body, debugMesh } of stoneBodies) {
    const { x, y, z } = body.translation();
    const rot = body.rotation();
    mesh.position.set(x, y, z);
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    if (debugMesh) {
      debugMesh.position.set(x, y, z);
      debugMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
  }

  // Sync mallet visual position from physics body
  if (malletBody && malletGroup) {
    const t = malletBody.translation();
    malletGroup.position.set(t.x, t.y, t.z);
  }
}

// ─── Mallet update ────────────────────────────────────────────────────────────

function updateDragStoneSpring(dt) {
  if (!isDragging || !dragStone || !dragStone.visible || !dragStoneInitialized) return;
  dragStoneCurrentPos.lerp(dragStoneTargetPos, DRAG_LAG_FACTOR);
  dragStone.position.copy(dragStoneCurrentPos);
  // Track cursor velocity for throw on release
  const posDelta = dragStoneTargetPos.clone().sub(dragStonePrevPos);
  const instantVel = posDelta.divideScalar(Math.max(dt, 0.001));
  dragStoneVel.lerp(instantVel, 0.5);
  dragStonePrevPos.copy(dragStoneTargetPos);
  if (HELD_IDLE_ROTATION) { updateHeldIdle(dt); dragStone.quaternion.copy(heldIdleQuat); }
}

function updateMallet(dt) {
  if (!malletGroup) return;

  if (malletHeld) {

    // Consume a detected table contact: stop swing, bounce back
    if (malletContactPos) {
      spawnCraftVFX(malletContactPos);
      malletContactPos = null;
      malletSwinging = false;
      malletBouncing = true;
      malletBounceTargetZ = malletBaseRotZ;
    }

    // Apply swing animation (overrides free rotation while active)
    if (malletSwinging) {
      malletSwingT += dt / SWING_DURATION;
      if (malletSwingT >= 1) {
        malletSwingT = 1;
        malletSwinging = false;
        malletBouncing = true;
        malletBounceTargetZ = malletBaseRotZ;
      }
      // Ease-in-out cubic
      const ease = malletSwingT < 0.5
        ? 4 * malletSwingT * malletSwingT * malletSwingT
        : 1 - Math.pow(-2 * malletSwingT + 2, 3) / 2;
      malletGroup.rotation.z = malletBaseRotZ + malletSwingDir * SWING_ANGLE * ease;
    } else if (malletBouncing) {
      // Spring back to pre-swing rotation
      malletGroup.rotation.z += (malletBounceTargetZ - malletGroup.rotation.z) * 0.18;
      if (Math.abs(malletGroup.rotation.z - malletBounceTargetZ) < 0.01) {
        malletGroup.rotation.z = malletBounceTargetZ;
        malletBouncing = false;
      }
    } else {
      // Decay tilt back toward 0 when not moving
      _malletTilt *= 0.90;
      malletGroup.rotation.z += (_malletTilt - malletGroup.rotation.z) * 0.08;
    }

  } else if (malletReturning) {
    // Kinematic return — lerp position and rotation to rest
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

  updateMallet(dt);
  updatePhysics();
  updateDragStoneSpring(dt);
  updateVFX(dt);

  if (autoAnimate) {
    currentProgress += 0.002;
    if (currentProgress > 1) currentProgress = 0;
    updateScene(currentProgress);
  }

  controls.update();
  updateSlotGlow();

  // Selective bloom: darken non-bloom objects, render bloom pass, restore
  scene.traverse(darkenNonBloom);
  bloomComposer.render();
  scene.traverse(restoreMaterial);

  composer.render();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  if (bloomComposer) bloomComposer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  for (const line of slotEdgeLines) {
    if (line && line.material.resolution) {
      line.material.resolution.set(window.innerWidth, window.innerHeight);
    }
  }
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

  // Slot glow controls
  const glowWidthSlider = document.getElementById('glow-width-slider');
  const glowWidthDisplay = document.getElementById('glow-width-display');
  glowWidthSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    glowWidthDisplay.textContent = val.toFixed(1);
    for (const line of slotEdgeLines) {
      if (line && line.material) line.material.linewidth = val;
    }
  });

  const bloomStrengthSlider = document.getElementById('bloom-strength-slider');
  const bloomStrengthDisplay = document.getElementById('bloom-strength-display');
  bloomStrengthSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    bloomStrengthDisplay.textContent = val.toFixed(2);
    if (bloomPass) bloomPass.strength = val;
  });

  const bloomRadiusSlider = document.getElementById('bloom-radius-slider');
  const bloomRadiusDisplay = document.getElementById('bloom-radius-display');
  bloomRadiusSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    bloomRadiusDisplay.textContent = val.toFixed(2);
    if (bloomPass) bloomPass.radius = val;
  });

  const bloomThresholdSlider = document.getElementById('bloom-threshold-slider');
  const bloomThresholdDisplay = document.getElementById('bloom-threshold-display');
  bloomThresholdSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    bloomThresholdDisplay.textContent = val.toFixed(2);
    if (bloomPass) bloomPass.threshold = val;
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
