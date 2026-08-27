"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { validateUnrealRigHandoff } = require("./unreal-rig-handoff");
const { validateUnrealAnimationHandoff } = require("./unreal-animation-handoff");
const { validateUnrealAudioHandoff } = require("./unreal-audio-handoff");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_UNREAL_ROOT = "C:\\Program Files\\Epic Games\\UE_5.6";
const DEFAULT_UNITY_ROOT = "C:\\Program Files\\Unity\\Hub\\Editor\\6000.2.6f1";

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function safeName(value, fallback = "Comic30Game") {
  const words = String(value || fallback).match(/[A-Za-z0-9]+/g) || [];
  const joined = words.map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join("").slice(0, 48);
  return /^[A-Za-z]/.test(joined) ? joined : fallback;
}

function unrealPaths() {
  const root = path.resolve(process.env.COMIC30_UNREAL_ROOT || DEFAULT_UNREAL_ROOT);
  return {
    root,
    editor: path.join(root, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe"),
    interactiveEditor: path.join(root, "Engine", "Binaries", "Win64", "UnrealEditor.exe"),
    automation: path.join(root, "Engine", "Build", "BatchFiles", "RunUAT.bat"),
    vehicleTemplate: path.join(root, "Templates", "TP_VehicleAdvBP"),
    thirdPersonTemplate: path.join(root, "Templates", "TP_ThirdPersonBP")
  };
}

function findPackagedExecutable(archiveDir) {
  if (!archiveDir || !exists(archiveDir)) return null;
  const candidates = [];
  const visit = (current, depth = 0) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 6) visit(absolute, depth + 1);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
        const normalized = absolute.toLowerCase();
        if (!normalized.includes("crashreportclient") && !normalized.includes("prereq")) {
          candidates.push({ absolute, depth });
        }
      }
    }
  };
  visit(path.resolve(archiveDir));
  candidates.sort((left, right) => left.depth - right.depth || left.absolute.length - right.absolute.length);
  return candidates[0]?.absolute || null;
}

function launchDetached(executable, args = [], options = {}) {
  if (!exists(executable)) throw new Error(`Launch target was not found: ${executable}`);
  const child = spawn(executable, args, {
    cwd: options.cwd || path.dirname(executable),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: false,
    env: { ...process.env, ...(options.env || {}) }
  });
  child.unref();
  return { pid: child.pid, executable };
}

function launchPackagedGame(archiveDir) {
  const executable = findPackagedExecutable(archiveDir);
  if (!executable) throw new Error("No packaged Comic30 executable was found. Package the Win64 build first.");
  // Force a normal desktop window. Unreal templates may otherwise inherit a
  // borderless/fullscreen preference, which makes a successfully running game
  // look like a background process when it is launched from the portal worker.
  return launchDetached(executable, [
    "-windowed",
    "-ResX=1280",
    "-ResY=720",
    "-WinX=120",
    "-WinY=90",
    "-ForceRes"
  ]);
}

function openUnrealProject(projectFile) {
  const unreal = unrealPaths();
  if (!exists(projectFile)) throw new Error("The generated Unreal project was not found on this worker.");
  if (!exists(unreal.interactiveEditor)) throw new Error("The interactive Unreal Editor is not installed on this worker.");
  return launchDetached(unreal.interactiveEditor, [projectFile], { cwd: path.dirname(projectFile) });
}

function unityPaths() {
  const root = path.resolve(process.env.COMIC30_UNITY_ROOT || DEFAULT_UNITY_ROOT);
  const playback = path.join(root, "Editor", "Data", "PlaybackEngines");
  return {
    root,
    editor: path.join(root, "Editor", "Unity.exe"),
    playback,
    modules: {
      android: exists(path.join(playback, "AndroidPlayer")),
      ios: exists(path.join(playback, "iOSSupport")),
      webgl: exists(path.join(playback, "WebGLSupport")),
      windows: exists(path.join(playback, "windowsstandalonesupport"))
    }
  };
}

function capabilities() {
  const unreal = unrealPaths();
  const unity = unityPaths();
  return {
    mode: process.env.VERCEL ? "remote-runner-required" : "local-workers",
    unreal: {
      id: "unreal-5.6",
      label: "Unreal Engine 5.6",
      available: exists(unreal.editor) && exists(unreal.automation),
      editor: exists(unreal.editor) ? unreal.editor : null,
      automation: exists(unreal.automation) ? unreal.automation : null,
      templates: {
        racing: exists(unreal.vehicleTemplate),
        thirdPerson: exists(unreal.thirdPersonTemplate)
      },
      pipeline: ["prompt-spec", "engine-project", "asset-import", "cook", "package", "qa"],
      rendering: ["Lumen", "Virtual Shadow Maps", "Nanite-compatible assets", "DX12", "Vulkan", "Metal"]
    },
    unity: {
      id: "unity-6000.2.6f1",
      label: "Unity 6.2",
      available: exists(unity.editor),
      editor: exists(unity.editor) ? unity.editor : null,
      modules: unity.modules,
      role: "mobile packaging and compatibility worker"
    },
    preview: {
      id: "browser-preview",
      label: "Browser interaction sketch",
      available: true,
      shippingBuild: false,
      note: "Three.js/WebGL is a preview surface only; it is not the production game engine or asset generator."
    }
  };
}

function chooseUnrealTemplate(prompt, project) {
  const value = `${prompt || ""} ${project.genre || ""} ${project.premise || ""}`.toLowerCase();
  return /\b(race|racer|racing|car|vehicle|driv|traffic)\b/.test(value) ? "racing" : "third-person";
}

function generatedImportScript() {
  return `"""Comic30 unattended Unreal asset import pass.

Run with UnrealEditor-Cmd.exe <project> -ExecutePythonScript=<this file>.
The engine's Interchange importer handles supported GLB/GLTF/FBX/USD inputs.
"""
import json
import os
import re
import unreal

source_dir = os.path.join(unreal.Paths.project_dir(), "Comic30Input", "Assets")
animation_dir = os.path.join(unreal.Paths.project_dir(), "Comic30Input", "Animations")
audio_dir = os.path.join(unreal.Paths.project_dir(), "Comic30Input", "Audio")
handoff_dir = os.path.join(unreal.Paths.project_dir(), "Comic30Input", "RigHandoffs")
animation_handoff_dir = os.path.join(unreal.Paths.project_dir(), "Comic30Input", "AnimationHandoffs")
audio_handoff_dir = os.path.join(unreal.Paths.project_dir(), "Comic30Input", "AudioHandoffs")
destination = "/Game/Comic30/Imported"
rig_destination = "/Game/Comic30/Rigs"
audio_destination = "/Game/Comic30/Audio"
extensions = {".glb", ".gltf", ".fbx", ".usd", ".usda", ".usdc"}

tasks = []
if os.path.isdir(source_dir):
    for filename in sorted(os.listdir(source_dir)):
        source = os.path.join(source_dir, filename)
        if os.path.isfile(source) and os.path.splitext(filename)[1].lower() in extensions:
            task = unreal.AssetImportTask()
            task.filename = source
            task.destination_path = destination
            task.automated = True
            task.replace_existing = True
            task.save = True
            tasks.append(task)

if tasks:
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)
    unreal.EditorAssetLibrary.save_directory(destination, only_if_is_dirty=False, recursive=True)

imported = []
for task in tasks:
    imported.extend(list(task.imported_object_paths or []))

registry = unreal.AssetRegistryHelpers.get_asset_registry()
registry.scan_paths_synchronous([destination], force_rescan=True)
asset_data = registry.get_assets_by_path(destination, recursive=True)

def comic30_asset_class(item):
    try:
        return str(item.asset_class_path.asset_name)
    except Exception:
        try:
            return str(item.asset_class)
        except Exception:
            return ""

classes = [comic30_asset_class(item) for item in asset_data]
skeletal_meshes = len([name for name in classes if name == "SkeletalMesh"])
skeletons = len([name for name in classes if name == "Skeleton"])
animations = len([name for name in classes if name == "AnimSequence"])

handoffs = []
if os.path.isdir(handoff_dir):
    for filename in sorted(os.listdir(handoff_dir)):
        source = os.path.join(handoff_dir, filename)
        if os.path.isfile(source) and filename.lower().endswith(".json"):
            with open(source, "r", encoding="utf-8") as handle:
                handoff = json.load(handle)
            if handoff.get("schema") != "comic30.unreal-rig-handoff.v1":
                raise RuntimeError("Comic30 rig handoff has an unsupported schema: {}".format(filename))
            if not handoff.get("assetId") or not handoff.get("retargetRoot") or not handoff.get("chains"):
                raise RuntimeError("Comic30 rig handoff is incomplete: {}".format(filename))
            if handoff.get("validation", {}).get("deformationQa", {}).get("passed") is not True:
                raise RuntimeError("Comic30 rig handoff lacks passing deformation QA: {}".format(filename))
            handoffs.append(handoff)

animation_handoffs = []
expected_animation_clips = 0
if os.path.isdir(animation_handoff_dir):
    for filename in sorted(os.listdir(animation_handoff_dir)):
        source = os.path.join(animation_handoff_dir, filename)
        if os.path.isfile(source) and filename.lower().endswith(".json"):
            with open(source, "r", encoding="utf-8") as handle:
                handoff = json.load(handle)
            if handoff.get("schema") != "comic30.unreal-animation-handoff.v1":
                raise RuntimeError("Comic30 animation handoff has an unsupported schema: {}".format(filename))
            if not handoff.get("assetId") or not handoff.get("targetSkeleton", {}).get("retargetRoot"):
                raise RuntimeError("Comic30 animation handoff is incomplete: {}".format(filename))
            clips = handoff.get("clips") or []
            if not clips:
                raise RuntimeError("Comic30 animation handoff contains no clips: {}".format(filename))
            for clip in clips:
                if not clip.get("id") or not clip.get("artifact", {}).get("sha256") or clip.get("qa", {}).get("passed") is not True:
                    raise RuntimeError("Comic30 animation handoff has incomplete or failed clip evidence: {}".format(filename))
            expected_animation_clips += len(clips)
            animation_handoffs.append(handoff)

audio_handoffs = []
expected_audio_clips = 0
if os.path.isdir(audio_handoff_dir):
    for filename in sorted(os.listdir(audio_handoff_dir)):
        source = os.path.join(audio_handoff_dir, filename)
        if os.path.isfile(source) and filename.lower().endswith(".json"):
            with open(source, "r", encoding="utf-8") as handle:
                handoff = json.load(handle)
            if handoff.get("schema") != "comic30.unreal-audio-handoff.v1":
                raise RuntimeError("Comic30 audio handoff has an unsupported schema: {}".format(filename))
            clips = handoff.get("clips") or []
            if not handoff.get("productionRunId") or not clips:
                raise RuntimeError("Comic30 audio handoff is incomplete: {}".format(filename))
            for clip in clips:
                if not clip.get("id") or not clip.get("artifact", {}).get("sha256") or clip.get("qa", {}).get("passed") is not True:
                    raise RuntimeError("Comic30 audio handoff has incomplete or failed clip evidence: {}".format(filename))
                if clip.get("license", {}).get("commercialUseAllowed") is not True or not clip.get("provenance", {}).get("model"):
                    raise RuntimeError("Comic30 audio handoff lacks commercial-use licensing or provenance: {}".format(filename))
            expected_audio_clips += len(clips)
            audio_handoffs.append(handoff)

def comic30_normalize_name(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())

skeletal_asset_data = [item for item in asset_data if comic30_asset_class(item) == "SkeletalMesh"]
skeletal_assets = [item.get_asset() for item in skeletal_asset_data]
used_mesh_paths = set()
ik_rigs = 0
control_rigs = 0

for handoff in handoffs:
    wanted = comic30_normalize_name(handoff.get("assetId"))
    matching = []
    for mesh in skeletal_assets:
        mesh_path = mesh.get_path_name()
        if mesh_path in used_mesh_paths:
            continue
        mesh_name = comic30_normalize_name(mesh.get_name())
        if wanted and (wanted in mesh_name or mesh_name in wanted):
            matching.append(mesh)
    if not matching:
        matching = [mesh for mesh in skeletal_assets if mesh.get_path_name() not in used_mesh_paths]
    if len(matching) != 1:
        raise RuntimeError(
            "Comic30 could not uniquely match rig handoff {} to an imported SkeletalMesh ({} candidates).".format(
                handoff.get("assetId"), len(matching)
            )
        )
    mesh = matching[0]
    used_mesh_paths.add(mesh.get_path_name())
    safe_asset_id = re.sub(r"[^A-Za-z0-9_]", "_", str(handoff.get("assetId")))[:48]
    ik_asset_path = "{}/IK_{}".format(rig_destination, safe_asset_id)
    if unreal.EditorAssetLibrary.does_asset_exist(ik_asset_path):
        unreal.EditorAssetLibrary.delete_asset(ik_asset_path)
    ik_rig = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
        asset_name="IK_{}".format(safe_asset_id),
        package_path=rig_destination,
        asset_class=unreal.IKRigDefinition,
        factory=unreal.IKRigDefinitionFactory()
    )
    if not ik_rig:
        raise RuntimeError("Comic30 failed to create IK Rig for {}.".format(handoff.get("assetId")))
    ik_controller = unreal.IKRigController.get_controller(ik_rig)
    ik_controller.set_skeletal_mesh(mesh)
    ik_controller.set_retarget_root(str(handoff.get("retargetRoot")))
    for chain in handoff.get("chains", []):
        ik_controller.add_retarget_chain(
            str(chain.get("name")),
            str(chain.get("startBone")),
            str(chain.get("endBone")),
            ""
        )
    unreal.EditorAssetLibrary.save_loaded_asset(ik_rig, only_if_is_dirty=False)
    ik_rigs += 1

    if handoff.get("controlRig", {}).get("requested") is True:
        unreal.load_module("ControlRigDeveloper")
        control_rig = unreal.ControlRigBlueprintFactory.create_control_rig_from_skeletal_mesh_or_skeleton(
            selected_object=mesh
        )
        if not control_rig:
            raise RuntimeError("Comic30 failed to create a Control Rig for {}.".format(handoff.get("assetId")))
        unreal.BlueprintEditorLibrary.compile_blueprint(control_rig)
        unreal.EditorAssetLibrary.save_loaded_asset(control_rig, only_if_is_dirty=False)
        control_rigs += 1

if handoffs:
    unreal.EditorAssetLibrary.save_directory(rig_destination, only_if_is_dirty=False, recursive=True)

animation_tasks = []
if os.path.isdir(animation_dir):
    for filename in sorted(os.listdir(animation_dir)):
        source = os.path.join(animation_dir, filename)
        if os.path.isfile(source) and os.path.splitext(filename)[1].lower() in extensions:
            task = unreal.AssetImportTask()
            task.filename = source
            task.destination_path = "/Game/Comic30/Animations"
            task.automated = True
            task.replace_existing = True
            task.save = True
            animation_tasks.append(task)

if animation_tasks:
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(animation_tasks)
    unreal.EditorAssetLibrary.save_directory("/Game/Comic30/Animations", only_if_is_dirty=False, recursive=True)
    for task in animation_tasks:
        imported.extend(list(task.imported_object_paths or []))
    registry.scan_paths_synchronous(["/Game/Comic30/Animations"], force_rescan=True)
    animation_asset_data = registry.get_assets_by_path("/Game/Comic30/Animations", recursive=True)
    animations = len([item for item in animation_asset_data if comic30_asset_class(item) == "AnimSequence"])

if expected_animation_clips and animations < expected_animation_clips:
    raise RuntimeError(
        "Comic30 imported {} AnimSequence assets but {} validated clips were required.".format(
            animations, expected_animation_clips
        )
    )

audio_tasks = []
if os.path.isdir(audio_dir):
    for filename in sorted(os.listdir(audio_dir)):
        source = os.path.join(audio_dir, filename)
        if os.path.isfile(source) and filename.lower().endswith(".wav"):
            task = unreal.AssetImportTask()
            task.filename = source
            task.destination_path = audio_destination
            task.automated = True
            task.replace_existing = True
            task.save = True
            audio_tasks.append(task)

if audio_tasks:
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(audio_tasks)
    unreal.EditorAssetLibrary.save_directory(audio_destination, only_if_is_dirty=False, recursive=True)
    for task in audio_tasks:
        imported.extend(list(task.imported_object_paths or []))
    registry.scan_paths_synchronous([audio_destination], force_rescan=True)
    audio_asset_data = registry.get_assets_by_path(audio_destination, recursive=True)
    sound_waves = len([item for item in audio_asset_data if comic30_asset_class(item) == "SoundWave"])
else:
    sound_waves = 0

if expected_audio_clips and sound_waves < expected_audio_clips:
    raise RuntimeError(
        "Comic30 imported {} SoundWave assets but {} validated clips were required.".format(
            sound_waves, expected_audio_clips
        )
    )

unreal.log(
    "COMIC30_IMPORT_COMPLETE tasks={} imported={} skeletal_meshes={} skeletons={} animations={} ik_rigs={} control_rigs={} handoffs={} animation_handoffs={} expected_animation_clips={} sound_waves={} audio_handoffs={} expected_audio_clips={}".format(
        len(tasks) + len(animation_tasks) + len(audio_tasks), len(imported), skeletal_meshes, skeletons, animations, ik_rigs, control_rigs, len(handoffs), len(animation_handoffs), expected_animation_clips, sound_waves, len(audio_handoffs), expected_audio_clips
    )
)
`;
}

async function copyInputAssets(targetDir, generatedSources = [], options = {}) {
  const supported = new Set([".glb", ".gltf", ".fbx", ".usd", ".usda", ".usdc"]);
  const provided = (Array.isArray(generatedSources) ? generatedSources : [])
    .map((source) => path.resolve(String(source)))
    .filter((source) => exists(source) && supported.has(path.extname(source).toLowerCase()));
  const sources = provided.length ? provided : options.fallback === false ? [] : [
      path.join(REPO_ROOT, "public", "assets", "models", "generated", "five-wheeler.glb"),
      path.join(REPO_ROOT, "public", "assets", "models", "generated", "e45-aircraft-clean.glb"),
      path.join(REPO_ROOT, "public", "assets", "models", "generated", "transport-shuttle.glb"),
      path.join(REPO_ROOT, "public", "assets", "models", "generated", "nathan-walking.glb")
    ].filter(exists);
  await fsp.mkdir(targetDir, { recursive: true });
  for (const source of sources) {
    await fsp.copyFile(source, path.join(targetDir, path.basename(source)));
  }
  return sources.map((source) => path.basename(source));
}

async function copyRigHandoffs(targetDir, generatedSources = []) {
  const provided = (Array.isArray(generatedSources) ? generatedSources : [])
    .map((source) => path.resolve(String(source)))
    .filter((source) => exists(source) && path.extname(source).toLowerCase() === ".json");
  await fsp.mkdir(targetDir, { recursive: true });
  const staged = [];
  const assetIds = new Set();
  for (const source of provided) {
    let handoff;
    try {
      handoff = JSON.parse(await fsp.readFile(source, "utf8"));
    } catch {
      throw new Error(`Unreal rig handoff is not valid JSON: ${path.basename(source)}`);
    }
    const validation = validateUnrealRigHandoff(handoff);
    if (!validation.ok) throw new Error(`${handoff?.name || path.basename(source)} rig handoff is invalid: ${validation.errors.join(" ")}`);
    if (assetIds.has(handoff.assetId)) throw new Error(`Duplicate Unreal rig handoff for asset ${handoff.assetId}.`);
    assetIds.add(handoff.assetId);
    const filename = `${String(handoff.assetId).replace(/[^A-Za-z0-9._-]/g, "_")}-rig-handoff.json`;
    await fsp.copyFile(source, path.join(targetDir, filename));
    staged.push({
      assetId: handoff.assetId,
      filename,
      profile: handoff.profile,
      retargetRoot: handoff.retargetRoot,
      chains: handoff.chains.length,
      controlRig: handoff.controlRig?.requested === true
    });
  }
  return staged;
}

async function copyAnimationHandoffs(targetDir, generatedSources = []) {
  const provided = (Array.isArray(generatedSources) ? generatedSources : [])
    .map((source) => path.resolve(String(source)))
    .filter((source) => exists(source) && path.extname(source).toLowerCase() === ".json");
  await fsp.mkdir(targetDir, { recursive: true });
  const staged = [];
  const assetIds = new Set();
  for (const source of provided) {
    let handoff;
    try {
      handoff = JSON.parse(await fsp.readFile(source, "utf8"));
    } catch {
      throw new Error(`Unreal animation handoff is not valid JSON: ${path.basename(source)}`);
    }
    const validation = validateUnrealAnimationHandoff(handoff);
    if (!validation.ok) throw new Error(`${handoff?.name || path.basename(source)} animation handoff is invalid: ${validation.errors.join(" ")}`);
    if (assetIds.has(handoff.assetId)) throw new Error(`Duplicate Unreal animation handoff for asset ${handoff.assetId}.`);
    assetIds.add(handoff.assetId);
    const filename = `${String(handoff.assetId).replace(/[^A-Za-z0-9._-]/g, "_")}-animation-handoff.json`;
    await fsp.copyFile(source, path.join(targetDir, filename));
    staged.push({
      assetId: handoff.assetId,
      filename,
      profile: handoff.profile,
      clips: handoff.clips.length,
      retargetRoot: handoff.targetSkeleton.retargetRoot,
      importAnimations: handoff.unreal?.importAnimations === true
    });
  }
  return staged;
}

async function copyAudioAssets(targetDir, generatedSources = []) {
  const provided = (Array.isArray(generatedSources) ? generatedSources : [])
    .map((source) => path.resolve(String(source)))
    .filter((source) => exists(source) && path.extname(source).toLowerCase() === ".wav");
  await fsp.mkdir(targetDir, { recursive: true });
  const staged = [];
  for (const source of provided) {
    const filename = path.basename(source);
    await fsp.copyFile(source, path.join(targetDir, filename));
    staged.push(filename);
  }
  return staged;
}

async function copyAudioHandoffs(targetDir, generatedSources = []) {
  const provided = (Array.isArray(generatedSources) ? generatedSources : [])
    .map((source) => path.resolve(String(source)))
    .filter((source) => exists(source) && path.extname(source).toLowerCase() === ".json");
  await fsp.mkdir(targetDir, { recursive: true });
  const staged = [];
  for (const source of provided) {
    let handoff;
    try {
      handoff = JSON.parse(await fsp.readFile(source, "utf8"));
    } catch {
      throw new Error(`Unreal audio handoff is not valid JSON: ${path.basename(source)}`);
    }
    const validation = validateUnrealAudioHandoff(handoff);
    if (!validation.ok) throw new Error(`Unreal audio handoff is invalid: ${validation.errors.join(" ")}`);
    const filename = `${String(handoff.productionRunId).replace(/[^A-Za-z0-9._-]/g, "_")}-audio-handoff.json`;
    await fsp.copyFile(source, path.join(targetDir, filename));
    staged.push({ productionRunId: handoff.productionRunId, filename, clips: handoff.clips.length });
  }
  return staged;
}

async function generateUnrealProject(project, options = {}) {
  const unreal = unrealPaths();
  if (!exists(unreal.editor)) throw new Error("Unreal Engine 5.6 local worker is unavailable.");
  const templateKind = chooseUnrealTemplate(options.prompt, project);
  const sourceTemplate = templateKind === "racing" ? unreal.vehicleTemplate : unreal.thirdPersonTemplate;
  if (!exists(sourceTemplate)) throw new Error(`Unreal ${templateKind} template is unavailable.`);

  const jobId = options.jobId || `engine_${crypto.randomBytes(8).toString("hex")}`;
  const projectName = safeName(project.title);
  const outputRoot = path.resolve(process.env.COMIC30_ENGINE_OUTPUT_DIR || path.join(os.tmpdir(), "c30-engine"));
  const projectSlug = String(project.slug || projectName).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "game";
  const shortJobId = String(jobId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || `job_${crypto.randomBytes(4).toString("hex")}`;
  const projectDir = path.join(outputRoot, projectSlug, shortJobId, "UnrealProject");
  await fsp.mkdir(path.dirname(projectDir), { recursive: true });
  await fsp.cp(sourceTemplate, projectDir, { recursive: true, force: true });

  const sourceProject = path.join(projectDir, templateKind === "racing" ? "TP_VehicleAdvBP.uproject" : "TP_ThirdPersonBP.uproject");
  const projectFile = path.join(projectDir, `${projectName}.uproject`);
  const descriptor = JSON.parse(await fsp.readFile(sourceProject, "utf8"));
  descriptor.EngineAssociation = "5.6";
  descriptor.Category = "Comic30 Generated Game";
  descriptor.Description = String(options.prompt || project.premise || "Comic30 generated game").slice(0, 240);
  const plugins = new Map((descriptor.Plugins || []).map((plugin) => [plugin.Name, plugin]));
  ["Interchange", "InterchangeEditor", "PythonScriptPlugin", "IKRig", "ControlRig"].forEach((name) => {
    if (!plugins.has(name)) plugins.set(name, { Name: name, Enabled: true });
  });
  descriptor.Plugins = Array.from(plugins.values());
  await fsp.writeFile(projectFile, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  if (sourceProject !== projectFile) await fsp.rm(sourceProject, { force: true });

  const inputDir = path.join(projectDir, "Comic30Input");
  const assets = await copyInputAssets(path.join(inputDir, "Assets"), options.sourceAssets);
  const animations = await copyInputAssets(path.join(inputDir, "Animations"), options.animationAssets || [], { fallback: false });
  const audio = await copyAudioAssets(path.join(inputDir, "Audio"), options.audioAssets || []);
  const rigHandoffs = await copyRigHandoffs(path.join(inputDir, "RigHandoffs"), options.rigHandoffs);
  const animationHandoffs = await copyAnimationHandoffs(path.join(inputDir, "AnimationHandoffs"), options.animationHandoffs);
  const audioHandoffs = await copyAudioHandoffs(path.join(inputDir, "AudioHandoffs"), options.audioHandoffs);
  const spec = {
    schema: "comic30.engine-build.v1",
    projectId: project.id,
    projectName,
    prompt: String(options.prompt || project.premise || ""),
    genre: project.genre,
    audience: project.audience,
    artDirection: project.design?.artStyle || "high-fidelity Unreal",
    engine: "Unreal Engine 5.6",
    template: templateKind,
    rendering: templateKind === "racing" ? ["Lumen", "Virtual Shadow Maps", "DX12 SM6", "Chaos Vehicles"] : ["Lumen", "Virtual Shadow Maps", "DX12 SM6"],
    gameplay: project.gameplay || {},
    story: project.story || [],
    scenes: project.scenes || [],
    levels: project.levels || [],
    characters: project.characters || [],
    worlds: project.worlds || [],
    terrain: project.terrain || [],
    stagedAssets: assets,
    stagedAnimations: animations,
    stagedAudio: audio,
    stagedRigHandoffs: rigHandoffs,
    stagedAnimationHandoffs: animationHandoffs,
    stagedAudioHandoffs: audioHandoffs,
    targets: options.targets || ["Win64", "Android", "iOS"],
    generatedAt: new Date().toISOString()
  };
  await fsp.mkdir(path.join(projectDir, "Content", "Python"), { recursive: true });
  await fsp.writeFile(path.join(inputDir, "comic30-project.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  const importScript = path.join(projectDir, "Content", "Python", "import_comic30_assets.py");
  await fsp.writeFile(importScript, generatedImportScript(), "utf8");
  await fsp.writeFile(path.join(projectDir, "COMIC30_BUILD.md"), `# ${project.title}\n\nThis is a real Unreal Engine 5.6 project generated by Comic30 from the creator prompt.\n\n- Template: ${templateKind}\n- Rendering: ${spec.rendering.join(", ")}\n- Staged source assets: ${assets.length}\n- Staged animation clips: ${animations.length}\n- Staged audio clips: ${audio.length}\n- Validated rig handoffs: ${rigHandoffs.length}\n- Validated animation handoffs: ${animationHandoffs.length}\n- Validated audio handoffs: ${audioHandoffs.length}\n- Required animation clips: ${animationHandoffs.reduce((total, handoff) => total + handoff.clips, 0)}\n- Required audio clips: ${audioHandoffs.reduce((total, handoff) => total + handoff.clips, 0)}\n- Project descriptor: ${path.basename(projectFile)}\n\nUse Comic30's validation and package jobs before calling the output playable or deployable.\n`, "utf8");

  return {
    jobId,
    engine: "unreal-5.6",
    template: templateKind,
    projectName,
    projectDir,
    projectFile,
    importScript,
    stagedAssets: assets,
    stagedAnimations: animations,
    stagedAudio: audio,
    stagedRigHandoffs: rigHandoffs,
    stagedAnimationHandoffs: animationHandoffs,
    stagedAudioHandoffs: audioHandoffs,
    rendering: spec.rendering,
    status: "engine-project-generated"
  };
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = [];
    const stderr = [];
    let settled = false;
    let child;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd || REPO_ROOT,
        windowsHide: true,
        shell: Boolean(options.shell),
        env: { ...process.env, ...(options.env || {}) }
      });
    } catch (error) {
      resolve({ ok: false, code: null, error: error.message, stdout: "", stderr: "", durationMs: Date.now() - startedAt });
      return;
    }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString("utf8").slice(-16000),
        stderr: Buffer.concat(stderr).toString("utf8").slice(-16000),
        durationMs: Date.now() - startedAt
      });
    };
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => finish({ ok: false, code: null, error: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, code, error: code === 0 ? null : `Process exited with code ${code}.` }));
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, error: `Engine validation exceeded ${options.timeoutMs || 240000}ms.` });
    }, options.timeoutMs || 240000);
  });
}

async function validateUnrealProject(projectFile, options = {}) {
  const unreal = unrealPaths();
  if (!exists(projectFile)) throw new Error("Generated Unreal project was not found.");
  const localCache = path.join(os.tmpdir(), "comic30-unreal-ddc");
  await fsp.mkdir(localCache, { recursive: true });
  const result = await runProcess(unreal.editor, [
    projectFile,
    "-unattended",
    "-nop4",
    "-nosplash",
    "-nullrhi",
    "-NoSound",
    "-ddc=InstalledNoZenLocalFallback",
    `-LocalDataCachePath=${localCache}`,
    "-run=CompileAllBlueprints"
  ], {
    cwd: path.dirname(projectFile),
    timeoutMs: options.timeoutMs || 240000,
    env: { "UE-LocalDataCachePath": localCache }
  });
  return { ...result, status: result.ok ? "engine-validated" : "validation-failed" };
}

async function importUnrealAssets(projectFile, importScript, options = {}) {
  const unreal = unrealPaths();
  if (!exists(projectFile)) throw new Error("Generated Unreal project was not found.");
  if (!exists(importScript)) throw new Error("Comic30 Unreal asset import script was not found.");
  const projectDir = path.dirname(projectFile);
  const importedRoot = path.join(projectDir, "Content", "Comic30", "Imported");
  const rigRoot = path.join(projectDir, "Content", "Comic30", "Rigs");
  const audioRoot = path.join(projectDir, "Content", "Comic30", "Audio");
  const sourceRoot = path.join(projectDir, "Comic30Input", "Assets");
  const animationRoot = path.join(projectDir, "Comic30Input", "Animations");
  const audioInputRoot = path.join(projectDir, "Comic30Input", "Audio");
  const handoffInputRoot = path.join(projectDir, "Comic30Input", "RigHandoffs");
  const animationHandoffInputRoot = path.join(projectDir, "Comic30Input", "AnimationHandoffs");
  const audioHandoffInputRoot = path.join(projectDir, "Comic30Input", "AudioHandoffs");
  const existingImports = exists(importedRoot)
    ? (await listRelativeFiles(importedRoot)).filter((file) => file.toLowerCase().endsWith(".uasset"))
    : [];
  const inputHandoffFiles = exists(handoffInputRoot)
    ? (await listRelativeFiles(handoffInputRoot)).filter((file) => file.toLowerCase().endsWith(".json"))
    : [];
  const inputAnimationHandoffFiles = exists(animationHandoffInputRoot)
    ? (await listRelativeFiles(animationHandoffInputRoot)).filter((file) => file.toLowerCase().endsWith(".json"))
    : [];
  const inputAudioHandoffFiles = exists(audioHandoffInputRoot)
    ? (await listRelativeFiles(audioHandoffInputRoot)).filter((file) => file.toLowerCase().endsWith(".json"))
    : [];
  let expectedAnimationClips = 0;
  for (const relative of inputAnimationHandoffFiles) {
    try {
      const handoff = JSON.parse(await fsp.readFile(path.join(animationHandoffInputRoot, relative), "utf8"));
      const validation = validateUnrealAnimationHandoff(handoff);
      if (!validation.ok) throw new Error(validation.errors.join(" "));
      expectedAnimationClips += handoff.clips.length;
    } catch (error) {
      throw new Error(`Comic30 could not validate staged animation handoff ${relative}: ${error.message}`);
    }
  }
  let expectedAudioClips = 0;
  for (const relative of inputAudioHandoffFiles) {
    try {
      const handoff = JSON.parse(await fsp.readFile(path.join(audioHandoffInputRoot, relative), "utf8"));
      const validation = validateUnrealAudioHandoff(handoff);
      if (!validation.ok) throw new Error(validation.errors.join(" "));
      expectedAudioClips += handoff.clips.length;
    } catch (error) {
      throw new Error(`Comic30 could not validate staged audio handoff ${relative}: ${error.message}`);
    }
  }
  const existingRigAssets = exists(rigRoot)
    ? (await listRelativeFiles(rigRoot)).filter((file) => file.toLowerCase().endsWith(".uasset"))
    : [];
  const reusableRigAssets = inputHandoffFiles.length === 0 || existingRigAssets.length >= inputHandoffFiles.length * 2;
  const existingAudioAssets = exists(audioRoot)
    ? (await listRelativeFiles(audioRoot)).filter((file) => file.toLowerCase().endsWith(".uasset"))
    : [];
  const reusableAudioAssets = inputAudioHandoffFiles.length === 0 || existingAudioAssets.length >= expectedAudioClips;
  if (existingImports.length && reusableRigAssets && reusableAudioAssets && inputAnimationHandoffFiles.length === 0 && inputAudioHandoffFiles.length === 0 && options.force !== true) {
    const sourceFiles = [
      ...(exists(sourceRoot) ? await listRelativeFiles(sourceRoot) : []),
      ...(exists(animationRoot) ? await listRelativeFiles(animationRoot) : [])
    ];
    return {
      ok: true,
      code: 0,
      stdout: "COMIC30_IMPORT_REUSED",
      stderr: "",
      durationMs: 0,
      taskCount: sourceFiles.length,
      importedCount: existingImports.length,
      ikRigCount: inputHandoffFiles.length,
      controlRigCount: inputHandoffFiles.length,
      handoffCount: inputHandoffFiles.length,
      expectedHandoffs: inputHandoffFiles.length,
      animationHandoffCount: 0,
      expectedAnimationHandoffs: 0,
      expectedAnimationClips: 0,
      soundWaveCount: existingAudioAssets.length,
      audioHandoffCount: 0,
      expectedAudioHandoffs: 0,
      expectedAudioClips: 0,
      error: null,
      status: "assets-imported"
    };
  }
  const localCache = path.join(os.tmpdir(), "comic30-unreal-ddc");
  const shaderWorkingDir = path.join(os.tmpdir(), "comic30-unreal-shaders");
  await fsp.mkdir(localCache, { recursive: true });
  await fsp.mkdir(shaderWorkingDir, { recursive: true });
  const result = await runProcess(unreal.editor, [
    projectFile,
    "-stdout",
    "-FullStdOutLogOutput",
    "-unattended",
    "-nop4",
    "-nosplash",
    "-NoSound",
    "-AllowCommandletRendering",
    `-shaderworkingdir=${shaderWorkingDir}`,
    "-ddc=InstalledNoZenLocalFallback",
    `-LocalDataCachePath=${localCache}`,
    `-ExecutePythonScript=${importScript}`
  ], {
    cwd: path.dirname(projectFile),
    timeoutMs: options.timeoutMs || 12 * 60 * 1000,
    env: { "UE-LocalDataCachePath": localCache }
  });
  const combinedLog = `${result.stdout}\n${result.stderr}`;
  const evidenceMarker = combinedLog.match(/COMIC30_IMPORT_COMPLETE tasks=(\d+) imported=(\d+) skeletal_meshes=(\d+) skeletons=(\d+) animations=(\d+)(?: ik_rigs=(\d+) control_rigs=(\d+) handoffs=(\d+) animation_handoffs=(\d+) expected_animation_clips=(\d+) sound_waves=(\d+) audio_handoffs=(\d+) expected_audio_clips=(\d+))?/);
  const marker = evidenceMarker || combinedLog.match(/COMIC30_IMPORT_COMPLETE tasks=(\d+) imported=(\d+)/);
  const legacyMarker = combinedLog.match(/COMIC30_IMPORT_COMPLETE assets=(\d+)/);
  const importedFiles = exists(importedRoot)
    ? (await listRelativeFiles(importedRoot)).filter((file) => file.toLowerCase().endsWith(".uasset"))
    : [];
  const importedAudioFiles = exists(audioRoot)
    ? (await listRelativeFiles(audioRoot)).filter((file) => file.toLowerCase().endsWith(".uasset"))
    : [];
  const audioSourceFiles = exists(audioInputRoot)
    ? (await listRelativeFiles(audioInputRoot)).filter((file) => file.toLowerCase().endsWith(".wav"))
    : [];
  const sourceFiles = [
    ...(exists(sourceRoot) ? await listRelativeFiles(sourceRoot) : []),
    ...(exists(animationRoot) ? await listRelativeFiles(animationRoot) : [])
  ].filter((file) => /\.(glb|gltf|fbx|obj)$/i.test(file));
  const importedCount = marker ? Number(marker[2]) : importedFiles.length;
  const taskCount = marker ? Number(marker[1]) : (legacyMarker ? Number(legacyMarker[1]) : sourceFiles.length + audioSourceFiles.length);
  const skeletalMeshCount = evidenceMarker ? Number(evidenceMarker[3]) : 0;
  const skeletonCount = evidenceMarker ? Number(evidenceMarker[4]) : 0;
  const animationCount = evidenceMarker ? Number(evidenceMarker[5]) : 0;
  const ikRigCount = evidenceMarker ? Number(evidenceMarker[6] || 0) : 0;
  const controlRigCount = evidenceMarker ? Number(evidenceMarker[7] || 0) : 0;
  const handoffCount = evidenceMarker ? Number(evidenceMarker[8] || 0) : 0;
  const animationHandoffCount = evidenceMarker ? Number(evidenceMarker[9] || 0) : 0;
  const reportedExpectedAnimationClips = evidenceMarker ? Number(evidenceMarker[10] || 0) : 0;
  const soundWaveCount = evidenceMarker ? Number(evidenceMarker[11] || 0) : importedAudioFiles.length;
  const audioHandoffCount = evidenceMarker ? Number(evidenceMarker[12] || 0) : 0;
  const reportedExpectedAudioClips = evidenceMarker ? Number(evidenceMarker[13] || 0) : 0;
  const expectedHandoffs = inputHandoffFiles.length;
  // Unreal's stdout can be very large. The process runner intentionally keeps a
  // bounded tail, so the Python completion marker may no longer be present even
  // though Unreal saved the imported packages successfully. Durable .uasset
  // output is the source of truth; do not turn a completed import into a false
  // failure merely because the marker scrolled out of the captured log tail.
  const durableImportCompleted = sourceFiles.length > 0 && importedFiles.length > 0;
  const rigHandoffsCompleted = expectedHandoffs === 0 || (
    handoffCount === expectedHandoffs
    && ikRigCount === expectedHandoffs
    && controlRigCount === expectedHandoffs
  );
  const animationHandoffsCompleted = inputAnimationHandoffFiles.length === 0 || (
    animationHandoffCount === inputAnimationHandoffFiles.length
    && reportedExpectedAnimationClips === expectedAnimationClips
    && animationCount >= expectedAnimationClips
  );
  const audioHandoffsCompleted = inputAudioHandoffFiles.length === 0 || (
    (audioHandoffCount === inputAudioHandoffFiles.length
      && reportedExpectedAudioClips === expectedAudioClips
      && soundWaveCount >= expectedAudioClips)
    || importedAudioFiles.length >= expectedAudioClips
  );
  const ok = Boolean(taskCount > 0 && importedCount > 0 && rigHandoffsCompleted && animationHandoffsCompleted && audioHandoffsCompleted && (result.ok || marker || legacyMarker || durableImportCompleted));
  return {
    ...result,
    ok,
    taskCount,
    importedCount,
    skeletalMeshCount,
    skeletonCount,
    animationCount,
    ikRigCount,
    controlRigCount,
    handoffCount,
    expectedHandoffs,
    animationHandoffCount,
    expectedAnimationHandoffs: inputAnimationHandoffFiles.length,
    expectedAnimationClips,
    soundWaveCount,
    audioHandoffCount,
    expectedAudioHandoffs: inputAudioHandoffFiles.length,
    expectedAudioClips,
    error: ok ? null : (result.error || (!rigHandoffsCompleted
      ? "Unreal did not create all required IK Rig and Control Rig assets."
      : !animationHandoffsCompleted
        ? "Unreal did not import every validated animation handoff as an AnimSequence."
        : !audioHandoffsCompleted
          ? "Unreal did not import every validated audio handoff as a SoundWave."
          : "Unreal finished without confirming imported assets.")),
    status: ok ? "assets-imported" : "asset-import-failed"
  };
}

async function listRelativeFiles(root, current = root, files = []) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await listRelativeFiles(root, absolute, files);
    else if (entry.isFile()) files.push(path.relative(root, absolute).replace(/\\/g, "/"));
  }
  return files;
}

async function linkEngineEntries(sourceDir, targetDir, excluded = new Set()) {
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (excluded.has(entry.name.toLowerCase())) continue;
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (exists(target)) continue;
    if (entry.isDirectory()) await fsp.symlink(source, target, "junction");
    else if (entry.isFile()) await fsp.copyFile(source, target);
  }
}

async function prepareWritableUnrealRoot(sourceRoot, writableRoot) {
  const sourceEngine = path.join(sourceRoot, "Engine");
  const writableEngine = path.join(writableRoot, "Engine");
  await linkEngineEntries(sourceRoot, writableRoot, new Set(["engine"]));
  await linkEngineEntries(sourceEngine, writableEngine, new Set(["intermediate"]));

  const sourceIntermediate = path.join(sourceEngine, "Intermediate");
  const writableIntermediate = path.join(writableEngine, "Intermediate");
  await linkEngineEntries(sourceIntermediate, writableIntermediate, new Set(["build"]));

  const sourceBuild = path.join(sourceIntermediate, "Build");
  const writableBuild = path.join(writableIntermediate, "Build");
  await linkEngineEntries(sourceBuild, writableBuild, new Set(["buildcookrun"]));
  await fsp.mkdir(path.join(writableBuild, "BuildCookRun"), { recursive: true });
  return writableRoot;
}

function unrealPackageCommand(projectFile, target = "Win64", options = {}) {
  const unreal = unrealPaths();
  const archiveDir = path.join(path.dirname(projectFile), "Comic30Build", target);
  const localCache = options.localCache || path.join(os.tmpdir(), "comic30-unreal-ddc");
  const shaderWorkingDir = options.shaderWorkingDir || path.join(os.tmpdir(), "comic30-unreal-shaders");
  const automationAppData = options.automationAppData || path.join(os.tmpdir(), "comic30-unreal-appdata");
  const automationLocalAppData = options.automationLocalAppData || path.join(os.tmpdir(), "comic30-unreal-localappdata");
  const writableRoot = options.writableRoot || path.join(automationLocalAppData, "UnrealRoot");
  const automationArgs = [
      "BuildCookRun",
      `-rootdirectory=${writableRoot}`,
      `-project=${projectFile}`,
      "-noP4",
      `-platform=${target}`,
      "-clientconfig=Development",
      "-build",
      "-ubtargs=-NoUBA",
      "-cook",
      "-allmaps",
      "-stage",
      "-pak",
      "-archive",
      `-archivedirectory=${archiveDir}`,
      `-AdditionalCookerOptions=-shaderworkingdir=${shaderWorkingDir} -ddc=InstalledNoZenLocalFallback -LocalDataCachePath=${localCache}`
    ];
  const executable = process.platform === "win32" ? (process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe") : unreal.automation;
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "call", unreal.automation, ...automationArgs]
    : automationArgs;
  return {
    executable,
    args,
    archiveDir,
    localCache,
    shaderWorkingDir,
    automationAppData,
    automationLocalAppData,
    writableRoot
  };
}

async function packageUnrealProject(projectFile, target = "Win64", options = {}) {
  const command = unrealPackageCommand(projectFile, target, options);
  await fsp.mkdir(command.archiveDir, { recursive: true });
  await fsp.mkdir(command.localCache, { recursive: true });
  await fsp.mkdir(command.shaderWorkingDir, { recursive: true });
  await fsp.mkdir(command.automationAppData, { recursive: true });
  await fsp.mkdir(command.automationLocalAppData, { recursive: true });
  await prepareWritableUnrealRoot(unrealPaths().root, command.writableRoot);
  const automationSaved = path.join(command.automationLocalAppData, "AutomationTool", "Saved");
  await fsp.mkdir(automationSaved, { recursive: true });
  const result = await runProcess(command.executable, command.args, {
    cwd: path.dirname(projectFile),
    timeoutMs: options.timeoutMs || 45 * 60 * 1000,
    env: {
      "UE-LocalDataCachePath": command.localCache,
      uebp_EngineSavedFolder: automationSaved,
      uebp_LogFolder: path.join(command.automationLocalAppData, "AutomationTool", "Logs"),
      uebp_FinalLogFolder: path.join(command.automationLocalAppData, "AutomationTool", "FinalLogs"),
      APPDATA: command.automationAppData,
      LOCALAPPDATA: command.automationLocalAppData
    }
  });
  return {
    ...result,
    archiveDir: command.archiveDir,
    target,
    status: result.ok ? "packaged" : "package-failed"
  };
}

async function validatePackagedArtifact(archiveDir) {
  if (!archiveDir || !exists(archiveDir)) {
    return { ok: false, executable: null, files: 0, totalBytes: 0, evidence: [], error: "Packaged archive directory was not found." };
  }
  const relativeFiles = await listRelativeFiles(archiveDir);
  const evidence = relativeFiles.filter((file) => /\.(exe|pak|ucas|utoc)$/i.test(file));
  let totalBytes = 0;
  for (const relative of relativeFiles) {
    const stat = await fsp.stat(path.join(archiveDir, ...relative.split("/")));
    totalBytes += stat.size;
  }
  const executable = findPackagedExecutable(archiveDir);
  const hasContentContainer = evidence.some((file) => /\.(pak|ucas|utoc)$/i.test(file));
  const ok = Boolean(executable && hasContentContainer && totalBytes > 1024 * 1024);
  return {
    ok,
    executable,
    files: relativeFiles.length,
    totalBytes,
    evidence: evidence.slice(0, 24),
    error: ok ? null : "The archive did not contain both a launchable executable and packaged Unreal content."
  };
}

module.exports = {
  capabilities,
  findPackagedExecutable,
  launchPackagedGame,
  openUnrealProject,
  generateUnrealProject,
  importUnrealAssets,
  validateUnrealProject,
  unrealPackageCommand,
  packageUnrealProject,
  validatePackagedArtifact
};
