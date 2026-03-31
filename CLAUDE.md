# Interactive Feelings

Scroll-based interactive multimedia article with a Three.js sticky scene, GSAP ScrollTrigger, lazy-loaded video, and a crafting-table UI scene.

## Stack
- **Vite** (`"type": "module"` — always use `fileURLToPath` for `__dirname` in config)
- **Three.js** (`^0.160`) — import loaders/controls from `three/examples/jsm/`
- **GSAP** + ScrollTrigger — scroll progress drives scene updates via `scroll.js`
- No build-time TypeScript, no framework

## Entry Points
| URL | File | Purpose |
|-----|------|---------|
| `localhost:5173/` | `index.html` + `scroll.js` | Main scroll article |
| `localhost:5173/scene` | `scene/index.html` + `scene/scene-dev.js` | Isolated scene sandbox |

- `/scene` (no trailing slash) works via a Vite middleware rewrite in `vite.config.js`
- Both entries declared in `vite.config.js` `build.rollupOptions.input` for production

## File Structure
```
index.html          # Main article
scroll.js           # GSAP ScrollTrigger scroll manager
scene.js            # Three.js scene (used by main article)
style.css           # Main article styles
scene/
  index.html        # Scene sandbox shell
  scene-dev.js      # Scene sandbox — Three.js + inventory API
  style.css         # Scene sandbox styles
assets/
  Images/           # 2D sprites/images (NOT "Sprites/")
    inventorySlots.png  (1925×233px, 9 slots)
    stonePng.png        (500×500px, no baked-in padding)
    stickPng.png        (500×500px, no baked-in padding)
  Models/
    craftingtable.glb
    stone.glb
    stick.glb
```

## Main Article (`scroll.js` / `scene.js`)
- `ScrollManager` class wires GSAP ScrollTrigger to `updateScene(progress)` in `scene.js`
- Three.js section uses `.scene-wrapper { height: 300vh }` + `.scene-sticky { position: sticky }` pattern
- Lazy video: `data-lazy-video` + `IntersectionObserver`, loads `video[data-src]` on enter
- Lazy widget: `data-lazy-widget` + `IntersectionObserver`

## Scene Sandbox (`scene/scene-dev.js`)
- Camera: 50° FOV, 3/4 overhead view, repositioned after GLB loads to be 3× closer to model top
- Orbit target set to bounding box top-center of loaded model (`box.max.y - 0.4` offset for screen centering)
- `OrbitControls`: zoom enabled (pinch supported), pan disabled, `rotateSpeed: 0.4`
- GLB loaded with `GLTFLoader`; camera repositioned relative to `controls.target` after load

## Inventory UI
- `inventorySlots.png` overlaid with `#slots-overlay` (CSS grid, 9 columns, `position: absolute; inset: 0`)
- Scaled to 40% via `transform: scale(0.4)` on `#inventory-bar`, anchored `bottom: 20px` center
- Slot grid: **no padding, no gap** — `grid-template-columns: 223fr repeat(7, 211fr) 223fr`
  - Outer slots 223px (include 10px bar border), inner 7 slots 211px — **9 slots total**
  - First slot needs `padding-left: 10px`, last needs `padding-right: 10px` to re-center content past bar border
- Slot images: 500×500px with no baked-in padding; display at `width: 63%; height: auto` centered in slot
- `transform: scale(0.4)` is layout-only — CSS `%` and `fr` still resolve against the pre-transform dimensions (1925px wide)
- **Slot item API** (exported from `scene/scene-dev.js`):
  - `setSlotItem(index, '/assets/Images/foo.png')` — set item image in slot 0–8
  - `clearSlot(index)` — remove item from slot
  - `clearAllSlots()` — empty all slots
  - `loadSlotModel(index, '/assets/Models/foo.glb', targetSize)` — register a GLB for a slot
  - Call inside `init()` or after DOM ready (not bare module scope)

## Physics (Rapier)
- `@dimforge/rapier3d-compat` — imported as ES module, WASM embedded (no script tag needed)
- Init: `await RAPIER.init()` then `new RAPIER.World({ x: 0, y: -9.81, z: 0 })`
- `world.step()` each frame (fixed internal timestep, no delta needed)
- Table: `RigidBodyDesc.fixed()` + `ColliderDesc.trimesh(Float32Array verts, Uint32Array indices)`
- Stones: `RigidBodyDesc.dynamic().setLinearDamping(...).setAngularDamping(...)` + `ColliderDesc.cuboid(hx, hy, hz)`
- Sync: `body.translation()` → `mesh.position`, `body.rotation()` → `mesh.quaternion`
- Call `model.updateMatrixWorld(true)` before extracting triangle data for the trimesh collider

## GLB Models
- GLB origins are often **not centered** — always wrap in a pivot `Group`, offset `raw.position.sub(center)` after computing bbox, then scale the group
- `stone.glb` has maxDim ~34 units (very large model-space); scale to `targetSize / maxDim`
- Compute `THREE.Box3` **before** applying scale so `maxDim` reflects unscaled geometry

## Drag-to-3D Interaction (`scene/scene-dev.js`)
- `#inventory-overlay` has `pointer-events: none`; individual `.slot` elements need `pointer-events: auto` to be clickable
- Drag ghost: a `position: fixed` div appended to `<body>`, `transform: translate(-50%, -50%)`, `pointer-events: none`
- `slotTemplates[index]` map holds hidden GLB templates; each drag clones the template for that slot index
- `controls.enabled = false` on drag start, `true` on release — prevents OrbitControls fighting pointer events
- Drop plane: `new THREE.Plane(new THREE.Vector3(0,1,0), 0)` — set `constant = -(tableTopY + 0.4)` after table loads
- **Pick-up existing objects**: canvas `pointerdown` raycasts against `stoneBodies` meshes; hit body switches to `RigidBodyType.KinematicPositionBased`, follows drag plane on move, reverts to `Dynamic` with zeroed velocity on release
- On `pointerdown`, immediately call `setNextKinematicTranslation` — don't wait for first `pointermove` or object stays put on static hold
