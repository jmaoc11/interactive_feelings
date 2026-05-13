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
    craftingGrid2.glb       (current table model; loaded twice — once as the table, once in loadSlotGlow for edge extraction. Replaces craftingGrid.glb which had Grid_Inner sharing geometry with Grid_Walls. Meshes include: Grid_Inner, Grid_Floor, Grid_Walls, Wood_Floor (hidden at load — revealed during forge), Slot1–Slot9 (hidden, used for slot edge extraction only), plus structural meshes. Use the table-mesh log at load if you need exact names.)
    craftingGrid.glb        (legacy — Grid_Inner detach pulled faces from Grid_Walls; no longer referenced)
    stonePick.glb           (forge result for the "Stone Pick" recipe — morph target + final swapped mesh)
    craftingtable.glb       (legacy — no longer referenced)
    craftingslots.glb       (legacy — empty Object3Ds Slot1–Slot9, no longer referenced)
    craftingslotsfill.glb   (legacy — slot fill planes, no longer referenced)
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
- **KinematicPositionBased bodies stop at static colliders** — they sweep to target and get blocked by table geometry. Use `body.setTranslation(pos, true)` (direct teleport, no sweep) before `setNextKinematicTranslation` when picking up an object that may be embedded in the table (e.g. a fallen stick in a slot). Stones/coal sit on top so they're unaffected; sticks can sink into slot geometry.

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

## Table Model — `craftingGrid2.glb` (`scene/scene-dev.js`)
- Loaded as the rendered table in the main loader. The traverse hides two sets of meshes:
  - `Wood_Floor` — hidden at load; revealed during forge as the bright glowing floor underneath the morph
  - Any mesh matching `/^slot\d+$/i` — these are fill planes used only for slot edge extraction; rendering them would overlap the table surface
- `addTablePhysics` applies the **same exclusion list** when building the trimesh collider — hidden meshes must also be skipped for physics, or invisible colliders sit on top of the table where the slot holes should be
- Module-level refs captured during traversal: `gridInner` (`Grid_Inner`), `gridFloor` (`Grid_Floor`), `gridWalls` (`Grid_Walls`), `woodFloor` (`Wood_Floor`) — all consumed by the forge system
- Table-mesh materials are loaded as-authored by the GLB (no force-override). Earlier `craftingGrid2.glb` had overlapping coincident faces with opposing normals on `Grid_Walls`, which produced translucent white seam lines during forge under DoubleSide; the current model has clean normals + no duplicate faces, so no material patching is needed.

## Slot Glow (`scene/scene-dev.js`)
- `loadSlotGlow()` re-loads `craftingGrid2.glb` (separate from the rendered table copy) and extracts `EdgesGeometry` from each `Slot*` mesh, creates `LineSegments2` (fat line API) in world space
- Only meshes matching `/^slot\d+$/i` are used — other meshes in the GLB (wood_grid, Object_*) are ignored
- Edge vertices are transformed to world space via `slotMesh.matrixWorld` and offset +0.001 Y to avoid z-fighting with the table surface
- `updateSlotGlow()` runs each frame: fades edge line opacity in/out; also checks `RECIPES` and lerps `bloomPass.strength` for recipe match feedback
- Glow lines are on `BLOOM_LAYER` (layer 1) for selective bloom — only they bloom, not the rest of the scene
- Tunable constants at top of file: `SLOT_GLOW_COLOR`, `SLOT_GLOW_COLOR_RECIPE`, `SLOT_GLOW_INTENSITY`, `SLOT_FILL_RADIUS`, `SLOT_DEPTH`
- `SLOT_FILL_RADIUS_STICK = 0.11` used for sticks (wider than stone's `SLOT_FILL_RADIUS = 0.06`) — stick axis can be offset from slot center when lying flat; tighter radius causes intermittent glow fade
- `stoneBodies` entries store `{ mesh, body, hy, slotIndex }` — `hy` is spawn-time Y half-extent, used for detection
- **Slot detection** — stones/coal: check `bottomY = t.y - hy` near `tableTopY`; sticks: find closest point on stick segment to slot center (body-local Z axis via quaternion rotation, clamped to `±hy`)
- **Recipes**: `RECIPES` array of `{ name?, result?, slots: { 0-indexed-pos: itemType } }` — `slotItemType[]` tracks current item per crafting slot each frame; match triggers color + bloom change. Optional `name` is the display name (e.g. "Stone Pick"); optional `result` is a GLB path used as the morph target + final swapped mesh.
- **Exact match required**: a recipe matches only when every slot it specifies is filled AND every other slot is empty (`slotItemType[i] === -1`). `currentRecipeMatch` and `currentMatchedRecipe` are exposed module-level for the forge system to read.

## Forge (`scene/scene-dev.js`)
- Recipe-match + mallet table contact triggers a multi-step "fuse + morph + reveal" sequence handled by `handleForgeHammer()` (called from the mallet contact block in `updateMallet`, alongside the VFX spawn)
- **State machine** — `forgeState`: `idle` → `forging` → `complete`. `forgeHammerCount` / `forgeHammerTotal` track progress; total is randomized per forge in `[FORGE_HAMMER_MIN, FORGE_HAMMER_MAX]` (currently 4–8)
- **First hit (`startForge`)**: collects matching `stoneBodies` entries per recipe slot, pushes `Grid_Inner` onto the merge list. `buildFusedMesh(meshList, centerOverride)` merges them into a bloom-layer mesh positioned at `slotCenters[4]` with Y anchored to Wood_Floor's `max.y` (so the morphed result's bottom lands on the floor). Originals are torn down (item meshes removed, bodies removed, `stoneBodies` entries spliced). `Grid_Inner` is detached from the table (`gridInner.parent.remove`). `Grid_Floor` is hidden, `Wood_Floor` is revealed with its original texture. All slot edge lines + bottom walls are set `visible = false` immediately to prevent bloom amplifying half-opacity residue.
- **Merge gotcha**: items are pivot Groups, so `buildFusedMesh` traverses each entry to collect leaf Meshes; non-position attributes are stripped before merging so geometries with different attribute layouts can combine. `buildFusedMesh(meshList, centerOverride)` accepts an optional `centerOverride` — when omitted, falls back to averaging leaf world positions.
- **Subsequent hits (`compressForge`)**: each bumps `morphTargetProgress` by `1 / (total - 1)` plus the Y-squash punch (`FORGE_COMPRESS_Y` / `FORGE_WIDEN_XZ`). Scale lerps toward `fusedTargetScale` each frame in `updateForge` while state is `forging`. **First hammer does NOT advance the morph** — `startForge` sets `morphTargetProgress = 0`; need ≥ 2 hits to see any morph progress.
- **Morph algorithm (`computeMorphTarget`)**: axis-aligned ray-cast wrap. Step 1: map target's longest bbox axis to source's longest (avoids "rotated diamond" results when source spreads along X but target's long axis is Z). Step 2: for each source vert, shoot a ray from the source centroid through that vert; use the furthest target hit as the target position. Falls back to nearest-point if the ray misses (e.g. vert at centroid). O(N×M) — for ~2k src × ~2k tri targets, takes ~0.5–1s on first hammer.
- **Target sizing**: `computeMorphTarget(srcGeo, tgtGeo, srcScale, scaleFactor)`. Default `scaleFactor = 0.3` (small thumbnail cube); recipe results use `1.0` so the GLB shape morphs at its natural proportions. After computing, `startForge` shifts `morphTargetPositions` up so the target's lowest local-Y is 0 — combined with `mesh.position.y = woodFloorY`, the morphed result rests on Wood_Floor.
- **Per-recipe results**: recipes can carry `name` and `result` (GLB path). On init, each result GLB is preloaded into both `recipeResultCache` (merged geometry for the morph) and `recipeResultSceneCache` (full scene with materials for the final swap). `startForge` picks the recipe's result if present, otherwise falls back to the global `forgeResultGeometry` (default `BoxGeometry(1,1,1)`, settable via `setForgeResult(geoOrMesh)`).
- **GLB swap at morph completion**: in `startForge`, a clone of the result scene (`pendingResultMesh`) is created, scaled to match the morph target's world maxDim, positioned with its bbox bottom on Wood_Floor, and kept hidden until morph reaches 1.0. When `updateMorph` detects `forgeState === 'complete'` AND `|morphProgress - 1| < 0.001`, it makes `pendingResultMesh` visible, calls `startResultFade`, removes `fusedMesh`.
- **Result fade (`startResultFade` / `updateResultFade`)**: each leaf material is cloned with `emissive = 0xffffff`, `emissiveIntensity = FORGE_EMISSIVE_INTENSITY`, bloom layer enabled. Over `RESULT_FADE_DURATION` seconds, `emissiveIntensity` lerps to 0; at end the original material is restored and bloom layer is disabled. Originals captured in `resultFadeOriginals` (Map keyed by mesh). `updateResultFade(dt)` runs in the animate loop after `updateForge`.
- **Completion hook**: `onForgeComplete(mesh)` fires when the final hammer lands (morph reaches 1.0 a few frames later via the lerp). Override to chain follow-up effects.
- **Tunables at the top of the forge section**: `FORGE_HAMMER_MIN/MAX`, `FORGE_COMPRESS_Y`, `FORGE_WIDEN_XZ`, `FORGE_EMISSIVE_INTENSITY`, `FORGE_GLOW_COLOR`, `FORGE_SCALE_LERP`, `MORPH_LERP`, `RESULT_FADE_DURATION`
- The fused mesh has **no physics body** — the mallet still stops at the table-top contact check. If you want the mallet head to physically rest on the blob, add a kinematic cuboid sized to `fusedMesh`'s bbox.

### Forge morph — limitations
- Mesh-to-mesh vertex morph without correspondence is fundamentally lossy: source verts always cluster onto a subset of the target surface. Axis alignment + ray-cast wrap reduces obvious failure modes (rotated/diamond results), but the mid-morph blob will always look approximate. The clean reveal is the `pendingResultMesh` swap at completion, not the morph itself.
- Truly faithful mesh morphing requires shape keys (matching topology authored in Blender) or a fundamentally different technique (particle dissolve + reform).

### Forge morph — debugging visibility
- If the fused mesh "doesn't morph," verify math first by swapping `buildFusedMesh`'s return for `new THREE.Mesh(new THREE.SphereGeometry(0.25, 32, 32), new THREE.MeshBasicMaterial({ color: 0xff00ff }))` with no bloom layer. If pink sphere morphs, the math is fine; investigate render-side (likely bloom drowning silhouette, or another mesh occluding).
- Sample vertex distances logged in `handleForgeHammer` ("v0:", "v100:") confirm target positions diverge from source. If `dist > 0.05` and you still see no visible change, it's a render issue, not math.

### Forge — Grid_Walls seam-line history (resolved)
- Earlier versions of `craftingGrid2.glb` showed translucent white seam lines on `Grid_Walls` during forge. Root cause: overlapping coincident faces with opposing normals on Grid_Walls — visible in Blender's Face Orientation overlay as blue clipping into red at the same positions. With DoubleSide materials the flipped face's back side rendered as a lighter shade; with FrontSide the flipped faces were culled, leaving holes. Fix lived in Blender, not code: Edit Mode → select all → `Mesh → Clean Up → Merge by Distance`, `Select → All by Trait → Interior Faces` → delete, then `Shift+N` to Recalculate Outside. Re-export.
- Diagnostic: in Blender, toggle viewport overlays → **Face Orientation**. Blue = correct outward, red = flipped. Any red on Grid_Walls means this artifact will return.

## Selective Bloom (`scene/scene-dev.js`)
- `BLOOM_ENABLED` const at top of file — set `false` to bypass the entire bloom pipeline (animate loop falls back to `renderer.render(scene, camera)`). Diagnostic switch for separating bloom-bleed from real geometry/material issues.
- Two-composer setup: `bloomComposer` renders only bloom-layer objects (all others darkened to black), `composer` composites bloom additively over normal render via a custom `ShaderPass`
- `darkenNonBloom()` / `restoreMaterial()` traverse the scene each frame, swapping non-bloom materials to black for the bloom pass
- `UnrealBloomPass` settings (strength, radius, threshold) adjustable via debug panel sliders
- `LineMaterial` linewidth also adjustable via debug panel
- Resize handler updates both composers and all `LineMaterial` resolutions

## Debug Panel (`scene/index.html` + `scene/scene-dev.js`)
- Three tabs: **Scene** (progress, mallet lag), **Bloom** (line width, bloom strength/radius/threshold), **Sparks** (all `vfx*` params)
- Tab switching: pure CSS `.hidden` class + JS `querySelectorAll('.tab-btn')` click handler in `setupControls()`
- Sparks tab built entirely in JS via `makeSlider()` helper — keeps HTML clean; sliders grouped by `makeSectionHead()` into Burst / Speed / Lifetime / Physics / Particles
- **Hidden by default** (`<div id="controls" class="hidden">`); press `,` to toggle. The keydown handler in `setupControls` ignores the key while focus is in an `input`/`textarea`/`select`. CSS rule `#controls.hidden { display: none }` is separate from `.tab-panel.hidden` — adding the class to `#controls` requires its own rule.

## VFX (`scene/scene-dev.js`)
- `spawnCraftVFX(worldPos)` — fires on mallet swing hitting the table; triggered by `malletContactPos` being set
- Hit detection uses XZ footprint check + `headPt.y <= tableBox.max.y + 0.15` — NOT full 3D bbox containment (which misses slot hits)
- Particle count, size, speed, gravity all tunable at top of `spawnCraftVFX`
- `USE_3D_VFX` toggle (top of file) — `true` = 3D blocky cube sparks with bloom + trails; `false` = 2D CSS overlay fallback
- 3D sparks: `spawn3DVfx(worldPos)` / `update3DVfx(dt)` — `BoxGeometry` cubes on `BLOOM_LAYER`, per-particle `MeshBasicMaterial` (need independent opacity), trail via `THREE.Line` with shifting position buffer (length: `SPARK_TRAIL_LENGTH`)
- All 3D spark params are mutable module-level `vfx*` vars (count, speedMin/Max, coneMin/Max, decayMin/Max, gravity, upKick, sizeMin/Max, trailOpacity) — driven live by debug panel Sparks tab
- Contact point: `new THREE.Vector3(headPt.x - faceNormal.x * offset, tableBox.max.y, headPt.z - faceNormal.z * offset)` where `faceNormal` = mallet local +Y projected onto XZ — offsets from raised rim toward flat face center
