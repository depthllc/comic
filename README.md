# Comic30 Creator Portal

Comic30 is now scaffolded as an AI-enabled game creation portal with a working local backend and a polished responsive frontend.

## What Is Included

- Account registration, login, logout, and HttpOnly cookie sessions.
- Email verification, password reset token generation, CSRF, rate limiting, and audit events.
- Supabase/Postgres persistence in production, with `data/db.json` retained only for local development.
- Project creation for storyline, genre, audience, art style, and gameplay loop.
- Eight persisted internal creation stages: Story, Scenes, Levels, Characters, Gameplay, World/Terrain, Economy, and Export.
- A deterministic internal creation engine, with an optional Python process boundary and an automatic JavaScript fallback.
- AI chat inference through the internal model, OpenAI (`OPENAI_API_KEY`), or OpenRouter (`OPENROUTER_API_KEY`). Cloud failures fall back to the deterministic internal model and are recorded.
- Playable story-graph sessions with persisted choices, scores, progression, and rewards.
- Studio analytics derived from actual deployments, playtests, QA reports, and ledger activity.
- Pipeline operations for navigation baking, shader-profile validation, asset optimization, LOD generation, QA, packaging, deployment, archiving, and replication.
- Character roster editing.
- Internal wallet ledger for player rewards and debits.
- In-app purchase product configuration.
- Serverless-safe export generation through private Supabase Storage or in-memory download streams.
- A persisted project asset library with multi-file uploads for GLB/GLTF/FBX/OBJ,
  Unreal and Unity packages, textures, audio, and video. GLBs receive structural,
  geometry, UV, PBR-material, texture, and optional rig-profile validation before
  they are admitted to the library.
- Export contents: game data, story, characters, economy, playable HTML prototype, mobile runtime notes, Unity/Unreal/Flutter/React Native/Comic30 runtime pipeline notes, store checklist, and API contract.
- Consent-gated contact import preview tooling.

## Production game compiler

Comic30 now separates the fast browser interaction sketch from production game output. Three.js/WebGL is never treated as the asset generator or shipping engine.

On a workstation with Unreal Engine 5.6, the production worker can:

- Turn a creator prompt into an Unreal project based on Epic's Advanced Vehicle or Third Person templates.
- Stage GLB, GLTF, FBX, or USD source assets and import them through Unreal Interchange.
- Persist Unreal skeletal meshes, skeletons, animation sequences, physics assets, materials, and textures as `.uasset` content.
- Validate the project headlessly with `CompileAllBlueprints`.
- Cook and package a Win64 development artifact through `RunUAT BuildCookRun`.
- Export the generated Unreal source project for editing in the full editor.

The worker detects Unreal and Unity installations at runtime. Vercel remains the control plane and persisted portal; engine compilation must run on a separate Windows GPU worker because Vercel functions do not contain Unreal or Unity.

### Source-asset generation worker

The first production asset service lives in `workers/source-asset-worker`. It is a persistent, provider-neutral job worker, not a visual placeholder and not a Vercel function. Its default order is owned-first: self-hosted TRELLIS.2, then an optional Meshy fallback for burst capacity or resilience.

1. Accept the compiled Comic30 game specification, required asset list, and optional per-asset HTTPS/data-URI image references.
2. Select the first healthy configured provider in `COMIC30_ASSET_PROVIDER_ORDER`.
3. Submit image-conditioned PBR generation to a self-hosted TRELLIS.2 service. A text-only request is accepted only when that service also provides a prompt-to-image front end and advertises `promptOnly=true`.
4. Use Meshy only when it has been explicitly configured as a fallback.
5. Download each real binary GLB artifact.
6. Verify its SHA-256 checksum and inspect the GLB structure.
7. Require renderable vertices, normals, UVs, material assignments, PBR materials, and textures.
8. Return persisted artifact manifests to Comic30 for Unreal Interchange import.

The TRELLIS.2 adapter expects a private service contract: `GET /health`, `POST /v1/jobs`, and `GET /v1/jobs/:id`. The health response must report real readiness and capabilities; the completed job must expose a downloadable GLB URL. Comic30 does not claim that the TRELLIS.2 GPU runtime is installed merely because the adapter exists.

Copy `.env.example` to a local untracked `.env` and configure the owned provider:

```text
COMIC30_ASSET_WORKER_TOKEN=a-long-random-shared-token
COMIC30_ASSET_GENERATOR_URL=http://127.0.0.1:5190
COMIC30_ASSET_PROVIDER_ORDER=trellis2,meshy
COMIC30_TRELLIS2_URL=http://127.0.0.1:5200
COMIC30_TRELLIS2_TOKEN=a-private-trellis-service-token
# Optional only:
MESHY_API_KEY=
```

Start the asset worker and portal in separate terminals:

```bash
npm run dev:asset-worker
npm run dev:rig-worker
npm run dev:animation-worker
npm run dev:audio-worker
npm run dev
```

`GET http://127.0.0.1:5190/health` must return `"ready": true`. Comic30 performs that health check; merely setting `COMIC30_ASSET_GENERATOR_URL` never marks the stage ready. Provider secrets belong only on their worker hosts. For production, deploy the Comic30 source worker and the GPU-backed TRELLIS.2 service to long-running private infrastructure with persistent storage, then point Vercel's `COMIC30_ASSET_GENERATOR_URL` at the source worker's HTTPS address. A Vercel deployment cannot reach the workstation's `127.0.0.1`.

`GET http://127.0.0.1:5191/health` must also return `"ready": true` for games whose source assets require a rig. The rig worker consumes only source GLBs whose checksum, byte length, mesh, material, and texture evidence already passed the source gate. It has three explicit strategies:

- **Humanoid:** UniRig skeleton inference, skin weights, textured merge, semantic humanoid mapping; optional Meshy fallback only if configured.
- **Creature:** UniRig with a creature-specific skin configuration and quadruped semantic mapping. It never silently substitutes a humanoid rig.
- **Vehicle:** accept an already-authored chassis/four-wheel hierarchy or generate articulation through a configured Blender worker. A static inseparable vehicle mesh fails.

Every generated rig must pass topology/skinning checks plus deterministic synthetic-pose deformation sampling. When animation clips are supplied, they are inspected as additional evidence. Passing evidence is serialized into a checksum-protected Unreal rig handoff that declares the retarget root, semantic bones, IK chains, and Control Rig intent.

Use `COMIC30_ASSET_WORKER_HOST=0.0.0.0` inside a container or hosted worker. Keep the default `127.0.0.1` for local-only development. The portal independently rechecks the artifact byte count, SHA-256 digest, and GLB requirements after download before Unreal is allowed to import it.

Build the production worker container from the repository root and attach a persistent volume at `/data`:

```bash
docker build -f workers/source-asset-worker/Dockerfile -t comic30-source-assets .
docker run --rm -p 5190:5190 -v comic30-assets:/data \
  -e COMIC30_ASSET_PROVIDER_ORDER=trellis2,meshy \
  -e COMIC30_TRELLIS2_URL=https://private-trellis.example.com \
  -e COMIC30_TRELLIS2_TOKEN=... \
  -e COMIC30_ASSET_WORKER_TOKEN=... \
  comic30-source-assets
```

This Node container does not bundle TRELLIS.2 model weights or a GPU runtime; it calls the private TRELLIS.2 service URL. Deploy it to a long-running container host with HTTPS and persistent disk. In Vercel, add only its public `COMIC30_ASSET_GENERATOR_URL` and matching `COMIC30_ASSET_WORKER_TOKEN`.

Build the rig worker container from the repository root and give it a separate persistent volume:

```bash
docker build -f workers/rig-worker/Dockerfile -t comic30-rigs .
docker run --rm -p 5191:5191 -v comic30-rigs:/data \
  -e COMIC30_RIG_PROVIDER_ORDER=unirig,meshy \
  -e COMIC30_UNIRIG_ROOT=/opt/UniRig \
  -e COMIC30_UNIRIG_BASH=/bin/bash \
  -e COMIC30_RIG_WORKER_TOKEN=... \
  -e COMIC30_SOURCE_ASSET_WORKER_TOKEN=... \
  -e COMIC30_RIG_ALLOWED_SOURCE_ORIGINS=https://assets-worker.example.com \
  comic30-rigs
```

The basic rig image is the Comic30 contract/control layer only; it does not install UniRig, its checkpoints, CUDA/PyTorch, or Blender. For owned rig inference, derive a GPU image from UniRig's supported runtime, copy or mount the UniRig checkout and checkpoints at `COMIC30_UNIRIG_ROOT`, and keep the Comic30 worker as its authenticated job front end. Add Blender and set `COMIC30_BLENDER_EXECUTABLE` when vehicle articulation generation is required. The container health check requires `generationReady`, so an empty control image cannot advertise production readiness. Configure `COMIC30_RIG_WORKER_URL` and its matching token in the portal environment only after the required profile reports ready. Meshy remains optional and its key, if used, stays on the rig host.

After the handoff passes, the Windows engine worker imports the GLB/FBX through Unreal Interchange, persists skeletal assets, creates an IK Rig with the validated chains and retarget root, and requests an appropriate Control Rig. The Unreal automation fails closed if a mapping is missing or if the expected IK Rig/Control Rig assets were not produced.

### Animation generation and retarget worker

The next production gate lives in `workers/animation-worker`. It consumes only checksum-verified rig artifacts and their validated Unreal rig handoffs. It never treats a declared clip name, a static preview, or a rigging test pose as a generated game animation.

The worker has two owned provider boundaries:

- **MotionGPT-compatible service:** self-hosted text-to-motion generation for advertised rig profiles. The private service must expose `GET /health`, `POST /v1/generations`, and `GET /v1/generations/:id`, then return an animated GLB artifact. Its health response must explicitly advertise `capabilities.profiles`; the adapter does not assume that a humanoid checkpoint can animate creatures or vehicles.
- **Blender vehicle articulation:** a local Blender process generates keyed chassis and wheel animation directly against a validated vehicle hierarchy. This is a deterministic owned fallback for the vehicle profile, not a substitute for general character motion generation.

Before an animation can advance to Unreal, Comic30 independently verifies its checksum, animation samplers/channels, finite timestamps and transforms, quaternion validity, mapped-bone coverage, clip duration, profile-specific semantic chains, and deformation evidence. Humanoid, creature, and vehicle retarget profiles have different required bones and IK chains; a mismatched profile fails closed. Passing results are serialized into a checksum-protected Unreal animation handoff.

Unreal then imports assets in three explicit phases: base source meshes, rig/IK/Control Rig evidence, and animated GLBs into `/Game/Comic30/Animations`. The production worker requires a matching `AnimSequence` and validated handoff evidence before packaging. Animated GLBs are not mixed into the base mesh import batch, preventing duplicate skeletal meshes and ambiguous skeleton matching.

Local animation configuration:

```text
COMIC30_ANIMATION_WORKER_URL=http://127.0.0.1:5192
COMIC30_ANIMATION_WORKER_TOKEN=a-long-random-shared-token
COMIC30_ANIMATION_PROVIDER_ORDER=motiongpt,blender
COMIC30_MOTIONGPT_URL=http://127.0.0.1:5202
COMIC30_MOTIONGPT_TOKEN=a-private-motion-service-token
COMIC30_ANIMATION_ALLOWED_RIG_ORIGINS=http://127.0.0.1:5191
# Required for the owned vehicle provider on a host with Blender:
COMIC30_BLENDER_EXECUTABLE=C:\Program Files\Blender Foundation\Blender 4.3\blender.exe
```

`GET http://127.0.0.1:5192/health` must report `"ready": true` and the required profile before the portal submits animation work. Build the contract worker from the repository root:

```bash
docker build -f workers/animation-worker/Dockerfile -t comic30-animation .
docker run --rm -p 5192:5192 -v comic30-animation:/data \
  -e COMIC30_ANIMATION_PROVIDER_ORDER=motiongpt \
  -e COMIC30_MOTIONGPT_URL=https://private-motion.example.com \
  -e COMIC30_MOTIONGPT_TOKEN=... \
  -e COMIC30_ANIMATION_WORKER_TOKEN=... \
  -e COMIC30_RIG_WORKER_TOKEN=... \
  -e COMIC30_ANIMATION_ALLOWED_RIG_ORIGINS=https://rig-worker.example.com \
  comic30-animation
```

The basic animation image is the authenticated job, validation, and artifact control layer. It intentionally does not bundle MotionGPT weights, CUDA/PyTorch, or Blender. Deploy a licensed/self-hosted motion runtime separately, or derive a worker image that adds Blender for vehicle articulation. Configure the portal's `COMIC30_ANIMATION_WORKER_URL` only after the worker advertises the profile the build requires.

### Audio generation and acoustic-QA worker

The fourth production worker lives in `workers/audio-worker`. It turns the compiled game specification into music, ambience, sound-effect, and dialogue WAV artifacts through an owned AudioCraft-compatible inference service. It persists jobs and binary artifacts, verifies SHA-256 digests at both worker and portal boundaries, rejects missing or non-commercial licenses, and performs real RIFF/WAV acoustic inspection before Unreal import.

The audio gate requires PCM 16/24/32-bit or IEEE float32 WAV, mono or stereo channels, valid sample rate/duration, finite samples, non-silent RMS/peak signal, acceptable clipping and DC offset, and a loop-seam check for looping ambience/music. A filename or provider success flag never counts as evidence. Passing output is serialized into a checksum-protected `comic30.unreal-audio-handoff.v1` manifest.

The private AudioCraft-compatible service must expose `GET /health`, `POST /v1/generations`, and `GET /v1/generations/:id`. A completed generation returns a downloadable WAV URL plus explicit license and provenance fields. Local configuration:

```text
COMIC30_AUDIO_WORKER_URL=http://127.0.0.1:5193
COMIC30_AUDIO_WORKER_TOKEN=a-long-random-shared-token
COMIC30_AUDIOCRAFT_URL=http://127.0.0.1:5203
COMIC30_AUDIOCRAFT_TOKEN=a-private-audiocraft-service-token
```

`GET http://127.0.0.1:5193/health` must return `"ready": true` before Comic30 submits audio work. Build the contract worker from the repository root:

```bash
docker build -f workers/audio-worker/Dockerfile -t comic30-audio .
docker run --rm -p 5193:5193 -v comic30-audio:/data \
  -e COMIC30_AUDIOCRAFT_URL=https://private-audio.example.com \
  -e COMIC30_AUDIOCRAFT_TOKEN=... \
  -e COMIC30_AUDIO_WORKER_TOKEN=... \
  comic30-audio
```

The base image is the authenticated job, provenance, licensing, and acoustic-QA control layer; it does not bundle AudioCraft weights or a GPU runtime. The Windows engine worker stages validated WAV files under `Comic30Input/Audio`, imports them to `/Game/Comic30/Audio`, and requires durable `SoundWave` assets plus matching handoff evidence before packaging can pass.

Optional local engine configuration:

```text
COMIC30_UNREAL_ROOT=C:\Program Files\Epic Games\UE_5.6
COMIC30_UNITY_ROOT=C:\Program Files\Unity\Hub\Editor\6000.2.6f1
COMIC30_ENGINE_OUTPUT_DIR=C:\path\to\ignored\engine-builds
```

## Run Locally

```bash
node server.js
```

Then open:

```text
http://127.0.0.1:5173
```

Python 3.11+ is optional. When available, the internal creation stages run through `engine/comic30_engine/core.py`; otherwise the equivalent deterministic Node implementation is used. Set `PYTHON_BIN` when Python is installed outside `PATH`, or set `COMIC30_PYTHON_ENGINE=false` to explicitly use the Node engine.

Optional inference configuration:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openrouter/free
PUBLIC_APP_URL=https://comic30.com
```

## Production Hardening

This is a launchable MVP scaffold, not a final AAA app-store build pipeline. See `docs/production-hardening.md` and `docs/database-schema.sql` for the production checklist and managed database starter schema.

Useful checks:

```bash
npm run check
npm run test:assets
npm run test:rig
npm run test:animation
npm run test:audio
npm run test:backend
npm run test:docker
```

The smoke test creates a temporary account and project, executes all eight stages, runs inference, operations, QA, builds, exports, deployment, and then verifies that the project survives a backend reload.

Run `npm run test:docker` from a normal PowerShell window signed in as the Windows user `ignit`. The script uses an isolated temporary Docker CLI configuration, builds the source, rig, animation, and audio worker images, starts all four containers, and verifies their `/health` contracts without submitting a generation job. Codex sandbox processes intentionally do not inherit the interactive user's Docker Desktop named-pipe access and should not be added to `docker-users`.

## Vercel + Supabase deployment

1. Run `docs/database-schema.sql` in the Supabase SQL editor.
2. Add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET=comic30-exports`, `SUPABASE_ASSET_BUCKET=comic30-assets`, and `MAX_ASSET_UPLOAD_BYTES=262144000` to the Vercel project environment.
3. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side; never prefix it with `NEXT_PUBLIC_` or expose it in browser code.
4. Deploy the repository. Vercel serves `public/` statically and routes `/api/*` through `api/index.js`.

The private `comic30-assets` bucket is used for creator uploads. In production,
the API issues a short-lived signed upload URL so large files move directly from
the browser to Supabase Storage; the API then reads, validates, checksums, and
persists the asset metadata in the owning project. Local development uses
`data/uploads/` with the same authenticated project routes.

The API intentionally returns a configuration error in production when Supabase is missing. It never falls back to an ephemeral Vercel filesystem.

Preview a consented contact import:

```bash
node tools/import-consented-contacts.js --source contacts.csv
```

Commit only rows that include email, consent/opt-in, and source:

```bash
node tools/import-consented-contacts.js --source contacts.csv --commit
```
