import * as THREE from 'three';

let scene, camera, renderer, mesh;
let isInitialized = false;

/**
 * Initialize Three.js scene
 * @param {HTMLCanvasElement} canvas - The canvas element to render to
 */
export function initScene(canvas) {
  if (isInitialized) return;

  // Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);

  // Camera setup
  camera = new THREE.PerspectiveCamera(
    75,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    1000
  );
  camera.position.z = 5;

  // Renderer setup
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false
  });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Create a demo mesh (torus knot)
  const geometry = new THREE.TorusKnotGeometry(1, 0.3, 128, 16);
  const material = new THREE.MeshStandardMaterial({
    color: 0x00ffff,
    roughness: 0.3,
    metalness: 0.8
  });
  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const pointLight1 = new THREE.PointLight(0xff00ff, 1, 100);
  pointLight1.position.set(5, 5, 5);
  scene.add(pointLight1);

  const pointLight2 = new THREE.PointLight(0x00ffff, 1, 100);
  pointLight2.position.set(-5, -5, 5);
  scene.add(pointLight2);

  // Handle window resize
  window.addEventListener('resize', () => {
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  });

  isInitialized = true;

  // Start render loop
  animate();
}

/**
 * Update scene based on scroll progress
 * @param {number} progress - Scroll progress (0-1)
 */
export function updateScene(progress) {
  if (!isInitialized || !mesh) return;

  // Rotate mesh based on progress
  mesh.rotation.x = progress * Math.PI * 2;
  mesh.rotation.y = progress * Math.PI * 3;

  // Scale mesh based on progress
  const scale = 1 + Math.sin(progress * Math.PI) * 0.5;
  mesh.scale.set(scale, scale, scale);

  // Move camera based on progress
  camera.position.z = 5 - progress * 2;
  camera.position.x = Math.sin(progress * Math.PI * 2) * 2;
  camera.position.y = Math.cos(progress * Math.PI * 2) * 2;
  camera.lookAt(0, 0, 0);

  // Update material color based on progress
  const hue = progress * 0.5; // 0 to 0.5 (cyan to magenta range)
  mesh.material.color.setHSL(hue, 1, 0.5);
}

/**
 * Animation loop
 */
function animate() {
  requestAnimationFrame(animate);

  if (mesh) {
    // Subtle continuous rotation
    mesh.rotation.z += 0.001;
  }

  renderer.render(scene, camera);
}
