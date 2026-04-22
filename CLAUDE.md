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
    craftingslots.glb       (empty Object3Ds Slot1–Slot9, position markers only)
    craftingslotsfill.glb   (plane meshes Slot1–Slot9 filling each slot hole, used for edge extraction)
    stone.glb
    stick.glb
    coal.glb
    mallet.glb
  Images/
    coalPng.png         (500×500px)
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

## Mallet Interaction (`scene/scene-dev.js`)
- Loaded after table GLB so `tableBox` bbox is available for flush positioning
- Rest pose: `rotation.z = Math.PI` (upside down), flush against `+Z` face of table
- Pivot at handle tip: offset `raw.position.y += size.y / 2` after centering so group origin = handle tip
- **Two body-type modes** to avoid table clipping on return:
  - **Held**: `RigidBodyType.Dynamic` with `gravityScale(0)` — spring force (`MALLET_STIFFNESS` / `MALLET_DAMPING`) chases cursor, real two-way collisions with stones
  - **Returning/rest**: `RigidBodyType.KinematicPositionBased` — lerps position + rotation back to rest pose, no collision interference
  - Switch to dynamic on grab, kinematic on release
- Spring-damper PD controller: `addForce(stiffness * (target - pos) - damping * vel)` each frame when held
- Grip offset (`GRIP_OFFSET_FRAC`) applied to spring target Y so hold point is partway up the handle, not at tip
- Zero body `linvel` on release so leftover momentum doesn't affect the kinematic return
- Rotation always controlled visually (tilt, swing, bounce-back) and synced TO body via `setRotation` + `setAngvel(0)`
- `malletDragPlane.constant = -(tableTopY + N)` — controls hold height above table; currently +0.2
- Update order: `updateMallet(dt)` runs before `updatePhysics()` so rotation is computed before the physics step
- **Mallet is click-toggle**: click to grab, click anywhere on canvas to drop (handled in `onMalletPointerDown`)

## Physics (Rapier)
- `@dimforge/rapier3d-compat` — imported as ES module, WASM embedded (no script tag needed)
- Init: `await RAPIER.init()` then `new RAPIER.World({ x: 0, y: -2.5, z: 0 })` — intentionally low gravity for scene scale
- `world.step()` each frame (fixed internal timestep, no delta needed)
- Table: `RigidBodyDesc.fixed()` + `ColliderDesc.trimesh(Float32Array verts, Uint32Array indices)`
- Stones/coal: `ColliderDesc.cuboid(hx, hy, hz)`; **sticks**: `ColliderDesc.capsule(hy - radius, radius).setRotation(PI/2 around X)` — capsule avoids corner-clipping through thin slot walls; rotation needed because stick long axis is body-local Z, not Y
- All dynamic bodies have `setCcdEnabled(true)` to prevent tunneling through thin walls
- **Stick body-local long axis is Z** (not Y) — inner mesh has `rotation.x = PI/2` baked in, so body-local Z maps to world-Y when upright. Capsule collider needs `setRotation({ x: sin(PI/4), y:0, z:0, w: cos(PI/4) })`. Debug geometry needs `applyMatrix4(makeRotationX(PI/2))` to match.
- **Don't make stick physics collider larger than visual** — oversized XZ collider clips through slot walls; widen detection radius in `updateSlotGlow` instead
- Mallet: dynamic body with `gravityScale(0)`, high density (80), `linearDamping(2)`, `angularDamping(10)` — switches to kinematic when returning to rest (see Mallet section)
- Sync: `body.translation()` → `mesh.position`, `body.rotation()` → `mesh.quaternion` (stones and mallet visual synced from body after `world.step()`)
- Call `model.updateMatrixWorld(true)` before extracting triangle data for the trimesh collider
- Pass mesh quaternion to `RigidBodyDesc.setRotation()` — otherwise body initializes with identity rotation regardless of mesh orientation
- Restitution combine rules: table uses `CoefficientCombineRule.Max`, objects use `CoefficientCombineRule.Min` — gives table bounce without object-object bounce
- Object-object collisions are intentionally less bouncy than object-table; don't flatten restitution globally
- Body type switching: use `setBodyType(RigidBodyType.KinematicPositionBased)` / `setBodyType(RigidBodyType.Dynamic)` to toggle collision behavior (mallet, picked objects). Re-set `gravityScale(0)` after switching back to dynamic.

## GLB Models
- GLB origins are often **not centered** — always wrap in a pivot `Group`, offset `raw.position.sub(center)` after computing bbox, then scale the group
- `stone.glb` has maxDim ~34 units (very large model-space); scale to `targetSize / maxDim`
- Compute `THREE.Box3` **before** applying scale so `maxDim` reflects unscaled geometry
- `stick.glb` long axis is horizontal by default — apply `raw.rotation.x = Math.PI / 2` before bbox to orient vertically
- For sticks: store `slotIndex` on `mesh.userData` to identify them for special physics handling (near-vertical spawn, tip impulse)
- To make a stick always topple: add a small off-center `ColliderDesc.ball` collider attached to the same body
- `loadSlotModel` accepts optional `axisScale` (`{x,y,z}` multipliers) and `rotation` (`{x,y,z}` radians) params

## Drag-to-3D Interaction (`scene/scene-dev.js`)
- `#inventory-overlay` has `pointer-events: none`; individual `.slot` elements need `pointer-events: auto` to be clickable
- Drag ghost: a `position: fixed` div appended to `<body>`, `transform: translate(-50%, -50%)`, `pointer-events: none`
- Hide ghost with `display: none` (not opacity) when over canvas — opacity just fades it, doesn't remove it from view
- Tag cloned dragStone with `userData.slotIndex` at clone time so physics body can identify item type on drop
- `slotTemplates[index]` map holds hidden GLB templates; each drag clones the template for that slot index
- `controls.enabled = false` on drag start, `true` on release — prevents OrbitControls fighting pointer events
- Drop plane: `new THREE.Plane(new THREE.Vector3(0,1,0), 0)` — set `constant = -(tableTopY + 0.4)` after table loads
- **Pick-up existing objects**: canvas `pointerdown` raycasts against `stoneBodies` meshes; hit body switches to `RigidBodyType.KinematicPositionBased`, follows drag plane on move, reverts to `Dynamic` with zeroed velocity on release
- On `pointerdown`, immediately call `setNextKinematicTranslation` — don't wait for first `pointermove` or object stays put on static hold
- **Drag lag**: both inventory drag and pick-up use `position.lerp(target, DRAG_LAG_FACTOR)` — same exponential chase as the mallet. `DRAG_LAG_FACTOR` (top of file) controls snappiness for both.
- **Throw velocity**: tracked from cursor target position (not lagged position) via smoothed EMA; scaled by `THROW_SCALE` on release
- **Interaction mode flag**: `CLICK_TOGGLE_ITEMS` (top of file) — `true` = click to grab/drop inventory items and picked objects; `false` = original hold-to-drag. Drop logic extracted into `releasePicked()` and `releaseInventoryDrag()` helpers used by both modes.

## Slot Glow (`scene/scene-dev.js`)
- `loadSlotGlow()` loads `craftingslotsfill.glb`, extracts `EdgesGeometry` from each `Slot*` mesh, creates `LineSegments2` (fat line API) in world space
- Only meshes matching `/^slot\d+$/i` are used — other meshes in the GLB (wood_grid, Object_*) are ignored
- Edge vertices are transformed to world space via `slotMesh.matrixWorld` and offset +0.001 Y to avoid z-fighting with the table surface
- `updateSlotGlow()` runs each frame: fades edge line opacity in/out; also checks `RECIPES` and lerps `bloomPass.strength` for recipe match feedback
- Glow lines are on `BLOOM_LAYER` (layer 1) for selective bloom — only they bloom, not the rest of the scene
- Tunable constants at top of file: `SLOT_GLOW_COLOR`, `SLOT_GLOW_COLOR_RECIPE`, `SLOT_GLOW_INTENSITY`, `SLOT_FILL_RADIUS`, `SLOT_DEPTH`
- `stoneBodies` entries store `{ mesh, body, hy, slotIndex, debugMesh }` — `hy` is spawn-time Y half-extent, used for detection
- **Slot detection** — stones/coal: check `bottomY = t.y - hy` near `tableTopY`; sticks: find closest point on stick segment to slot center (body-local Z axis via quaternion rotation, clamped to `±hy`)
- **Recipes**: `RECIPES` array of `{ slots: { 0-indexed-pos: itemType } }` — `slotItemType[]` tracks current item per crafting slot each frame; match triggers color + bloom change

## Selective Bloom (`scene/scene-dev.js`)
- Two-composer setup: `bloomComposer` renders only bloom-layer objects (all others darkened to black), `composer` composites bloom additively over normal render via a custom `ShaderPass`
- `darkenNonBloom()` / `restoreMaterial()` traverse the scene each frame, swapping non-bloom materials to black for the bloom pass
- `UnrealBloomPass` settings (strength, radius, threshold) adjustable via debug panel sliders
- `LineMaterial` linewidth also adjustable via debug panel
- Resize handler updates both composers and all `LineMaterial` resolutions

## VFX (`scene/scene-dev.js`)
- `spawnCraftVFX(worldPos)` — fires on mallet swing hitting the table; triggered by `malletContactPos` being set
- Hit detection uses XZ footprint check + `headPt.y <= tableBox.max.y + 0.15` — NOT full 3D bbox containment (which misses slot hits)
- Particle count, size, speed, gravity all tunable at top of `spawnCraftVFX`
