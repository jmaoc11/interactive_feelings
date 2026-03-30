import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Scene, camera, renderer
let scene, camera, renderer, controls;
let animationId = null;
let autoAnimate = false;
let currentProgress = 0;

let objects = [];

function init() {
  const canvas = document.getElementById('scene-canvas');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  // 3/4 view from above
  camera.position.set(3, 4, 3);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Grid & axes helpers
  const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
  scene.add(gridHelper);
  const axesHelper = new THREE.AxesHelper(5);
  scene.add(axesHelper);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 10, 5);
  scene.add(directionalLight);

  // Load crafting table
  const loader = new GLTFLoader();
  loader.load('/assets/Models/craftingtable.glb', (gltf) => {
    const model = gltf.scene;
    scene.add(model);
    objects.push(model);

    // Orbit around the top surface of the model
    const box = new THREE.Box3().setFromObject(model);
    const topCenter = new THREE.Vector3(
      (box.min.x + box.max.x) / 2,
      box.max.y,
      (box.min.z + box.max.z) / 2
    );
    topCenter.y -= 0.4;
    controls.target.copy(topCenter);

    // Position camera 3x closer in the same 3/4 direction from the target
    const offset = new THREE.Vector3(3, 4, 3).normalize().multiplyScalar(
      camera.position.distanceTo(topCenter) / 3
    );
    camera.position.copy(topCenter).add(offset);

    controls.update();
  });

  // Orbit controls — locked to a tight range around the 3/4 view
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableZoom = true;
  controls.enablePan = false;
  controls.rotateSpeed = 0.4;
  controls.zoomSpeed = 1.2;

  controls.update();

  window.addEventListener('resize', onResize);
  setupControls();
  animate();

  setSlotItem(0, '/assets/Images/rockPng.png');
}

function updateScene(progress) {
  currentProgress = progress;
  document.getElementById('progress-display').textContent = progress.toFixed(2);
  document.getElementById('progress-slider').value = progress * 100;
}

function animate() {
  animationId = requestAnimationFrame(animate);

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

// Inventory slot API
// setSlotItem(0, '/assets/Sprites/someitem.png') — put an item in a slot
// clearSlot(0) — remove item from a slot
// clearAllSlots() — empty everything
export function setSlotItem(index, imageSrc) {
  const slot = document.querySelector(`.slot[data-slot="${index}"]`);
  if (!slot) return;
  slot.innerHTML = `<img src="${imageSrc}" alt="item" />`;
}

export function clearSlot(index) {
  const slot = document.querySelector(`.slot[data-slot="${index}"]`);
  if (slot) slot.innerHTML = '';
}

export function clearAllSlots() {
  document.querySelectorAll('.slot').forEach(s => s.innerHTML = '');
}

init();
