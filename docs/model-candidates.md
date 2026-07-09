# Comic30 3D Model Candidates

Inspected from the uploaded archives in `C:\Users\ignit\Downloads` on July 7, 2026.

## Converted GLB Assets

The following files are now browser-ready and available for `<model-viewer>`:

| Asset | Output | Size | Animation status |
| --- | --- | ---: | --- |
| E-45 Aircraft | `public/assets/models/generated/e45-aircraft.glb` | 1.13 MB | 1 animation |
| Futuristic Five-Wheeler | `public/assets/models/generated/five-wheeler.glb` | 6.13 MB | 1 animation |
| Nathan Walking Character | `public/assets/models/generated/nathan-walking.glb` | 22.66 MB | 1 walking animation |
| Neck Mech Walker | `public/assets/models/generated/neck-mech-walker.glb` | 11.98 MB | 15 animations |
| Space Station Scene | `public/assets/models/generated/space-station-scene.glb` | 5.49 MB | 1 default take |
| Futuristic Transport Shuttle | `public/assets/models/generated/transport-shuttle.glb` | 11.18 MB | 2 animations |

Conversion script: `tools/convert-models.js`

## Best Candidates

| Section | Asset | Archive | Web readiness | Notes |
| --- | --- | --- | --- | --- |
| Hero / AI Stack | E-45 Aircraft | `c2lpk7avgum8-E-45-Aircraft.zip` | Convert FBX/OBJ to GLB | Lightweight aircraft FBX variants plus large texture set. Strong replacement for flat overlay art. |
| World Builder | Space Station Scene | `89-fbx.zip` or `91-space-station-new.zip` | Convert FBX/OBJ/Blend to GLB | Best for a generated environment scene. More environment than rig. |
| Character / Cast | Nathan Walking Character | `55-rp_nathan_animated_003_walking_fbx.zip` | Convert FBX to GLB | Confirmed animation and skeleton markers. Good human character demo. |
| Character / Boss Rig | Neck Mech Walker | `78-fbx-neck_mech_walker_by_3dhaupt.zip` | Convert FBX to GLB | Confirmed animation/skeleton markers. Good mechanical enemy/companion rig. |
| Economy / Rewards | Futuristic Transport Shuttle | `6nioagpbdym8-Futuristic_Transport_Shuttle_Rigged.zip` | Convert FBX/OBJ/DAE to GLB | Confirmed rig markers. Good shuttle/cargo/reward economy visual. |
| Build / Deploy | Futuristic Five-Wheeler | `86-fbx.zip` | Convert FBX to GLB | Contains animation markers. Useful as a mobile-build vehicle or deployable game asset. |

## Confirmed Rig Or Animation Markers

- `Neck_Mech_Walker_by_3DHaupt.fbx`: animation stack, animation curves, skeleton, limb nodes.
- `Transport Shuttle_fbx.fbx`: animation stack, curves, skeleton, bind pose.
- `E 45 Aircraft-sketchfab-Version.fbx`: animation stack, curves, skeleton, bind pose.
- `rp_nathan_animated_003_walking.fbx`: animation stack, curves, skeleton, bind pose.
- `Five_Wheeler-(FBX 7.4 binary mit Animation).fbx`: animation stack and animation curves.

## Conversion Notes

The current site uses `<model-viewer>`, which works best with `.glb` / `.gltf`. The best FBX assets have now been converted to GLB.

Recommended next steps:

1. Replace placeholder/robot overlays with the generated `<model-viewer>` files section by section.
2. Compress the larger GLBs if needed so the homepage stays smooth.
3. Tune camera orbit, scale, and animation names inside each section.
