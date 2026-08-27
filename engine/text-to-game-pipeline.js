const crypto = require("crypto");

const SPEC_VERSION = "comic30.game-spec.v1";
const RUN_VERSION = "comic30.production-graph.v1";

const FAMILY_RULES = [
  {
    id: "endless-racer",
    label: "Endless racing",
    test: /\b(endless|infinite)\b[\s\S]*\b(race|racer|racing|car|vehicle|driv)/i,
    template: "racing",
    camera: "third-person chase",
    controls: ["steer", "accelerate", "brake", "touch steering"],
    systems: ["vehicle handling", "traffic spawning", "distance scoring", "difficulty ramp", "restart loop"],
    assets: ["hero vehicle", "traffic vehicle set", "modular track", "roadside environment", "HUD"],
    animations: ["wheel rotation", "suspension response", "vehicle impacts"],
    requiresCharacterRig: false
  },
  {
    id: "racing",
    label: "Racing",
    test: /\b(race|racer|racing|car|vehicle|driv)/i,
    template: "racing",
    camera: "third-person chase",
    controls: ["steer", "accelerate", "brake", "reset vehicle"],
    systems: ["vehicle handling", "lap or route rules", "opponents", "checkpoints", "results"],
    assets: ["hero vehicle", "opponent vehicle set", "track kit", "environment kit", "HUD"],
    animations: ["wheel rotation", "suspension response", "vehicle impacts"],
    requiresCharacterRig: false
  },
  {
    id: "platformer",
    label: "Platformer",
    test: /\b(platform|runner|jump|obstacle course|parkour)/i,
    template: "thirdPerson",
    camera: "third-person follow",
    controls: ["move", "jump", "dash", "touch movement"],
    systems: ["character movement", "platform traversal", "hazards", "checkpoints", "collectibles"],
    assets: ["hero character", "platform kit", "hazard set", "environment kit", "HUD"],
    animations: ["idle", "walk", "run", "jump", "fall", "land", "dash"],
    requiresCharacterRig: true
  },
  {
    id: "shooter",
    label: "Action shooter",
    test: /\b(shoot|shooter|gun|weapon|combat|battle)/i,
    template: "thirdPerson",
    camera: "third-person aim",
    controls: ["move", "aim", "fire", "reload", "ability"],
    systems: ["character movement", "weapon system", "damage", "enemy AI", "encounters"],
    assets: ["hero character", "enemy set", "weapon set", "environment kit", "VFX", "HUD"],
    animations: ["idle", "locomotion", "aim offsets", "fire", "reload", "hit reactions", "death"],
    requiresCharacterRig: true
  },
  {
    id: "puzzle",
    label: "Puzzle adventure",
    test: /\b(puzzle|logic|match|escape room|mystery)/i,
    template: "thirdPerson",
    camera: "contextual third-person",
    controls: ["move", "interact", "inspect", "inventory"],
    systems: ["interaction graph", "puzzle state", "inventory", "hints", "progression"],
    assets: ["player character", "interactive prop kit", "environment kit", "VFX", "HUD"],
    animations: ["idle", "locomotion", "interact", "inspect", "pickup"],
    requiresCharacterRig: true
  },
  {
    id: "third-person-action",
    label: "Third-person action adventure",
    test: /.*/,
    template: "thirdPerson",
    camera: "third-person follow",
    controls: ["move", "look", "jump", "interact", "ability"],
    systems: ["character movement", "interaction", "objectives", "enemy AI", "progression"],
    assets: ["hero character", "supporting character set", "environment kit", "props", "VFX", "HUD"],
    animations: ["idle", "walk", "run", "jump", "interact", "ability", "hit reaction"],
    requiresCharacterRig: true
  }
];

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function text(value, fallback = "") {
  return String(value || fallback).trim();
}

function classifyPrompt(prompt) {
  return FAMILY_RULES.find((rule) => rule.test.test(prompt)) || FAMILY_RULES[FAMILY_RULES.length - 1];
}

function assetProductionProfile(name) {
  const value = String(name || "").toLowerCase();
  if (/character|hero|player|enemy|support/.test(value)) return { kind: "character", rigRequired: true, rigProfile: "humanoid", heightMeters: 1.8 };
  if (/vehicle|car|truck|shuttle/.test(value)) return { kind: "vehicle", rigRequired: true, rigProfile: "vehicle", rigMode: "validate-authored" };
  return { kind: /environment|track|road|platform/.test(value) ? "environment" : "prop", rigRequired: false, rigProfile: null };
}

function audioProductionRequirements(request, family) {
  const direction = `${family.label} game based on: ${request}`;
  return [
    {
      id: "audio-music",
      name: "Main gameplay music loop",
      kind: "music",
      prompt: `Create an original, commercially usable instrumental gameplay score for a ${direction}. Seamless loop, no vocals, clear gameplay mix, and no imitation of a named artist or copyrighted composition.`,
      durationSeconds: 15,
      loop: true,
      required: true
    },
    {
      id: "audio-ambience",
      name: "Environment ambience loop",
      kind: "ambience",
      prompt: `Create original environmental ambience for a ${direction}. Seamless loop, spatially clean, without music or dialogue, suitable beneath gameplay effects.`,
      durationSeconds: 10,
      loop: true,
      required: true
    },
    {
      id: "audio-ui-confirm",
      name: "UI confirmation",
      kind: "ui",
      prompt: `Create a short original game UI confirmation sound for a ${family.label} interface. Crisp transient, no speech, no copyrighted source audio.`,
      durationSeconds: 0.75,
      loop: false,
      required: true
    },
    {
      id: "audio-gameplay-impact",
      name: "Gameplay impact",
      kind: "sfx",
      prompt: `Create an original core gameplay impact sound appropriate for a ${direction}. Layered but clean, immediate feedback, no speech, no copyrighted source audio.`,
      durationSeconds: 1,
      loop: false,
      required: true
    }
  ];
}

function workerRegistry(capabilities = {}, env = process.env) {
  const unreal = capabilities.unreal || {};
  const unity = capabilities.unity || {};
  const sourceAssets = capabilities.sourceAssets || {};
  const rigging = capabilities.rigging || {};
  const animation = capabilities.animation || {};
  const audio = capabilities.audio || {};
  const unrealTemplates = Array.isArray(unreal.templates)
    ? unreal.templates
    : Object.entries(unreal.templates || {}).filter(([, enabled]) => enabled).map(([name]) => name);
  return {
    specification: { id: "comic30-spec-compiler", label: "Game specification compiler", available: true, mode: "internal" },
    design: { id: "comic30-design-agents", label: "Design agent stack", available: true, mode: "internal" },
    sourceAssets: {
      id: "source-asset-worker",
      label: "High-fidelity source asset generator",
      configured: sourceAssets.configured === true,
      available: sourceAssets.available === true,
      mode: sourceAssets.mode || (env.COMIC30_ASSET_GENERATOR_URL ? "unverified" : "unconfigured"),
      endpoint: sourceAssets.endpoint || null,
      provider: sourceAssets.provider || null,
      reason: sourceAssets.reason || (env.COMIC30_ASSET_GENERATOR_URL ? "The configured worker has not passed a health check." : "COMIC30_ASSET_GENERATOR_URL is not configured."),
      requiredEnvironment: "COMIC30_ASSET_GENERATOR_URL"
    },
    rigging: {
      id: "character-rig-worker",
      label: "Character rigging worker",
      configured: rigging.configured === true,
      available: rigging.available === true,
      mode: rigging.mode || (env.COMIC30_RIG_WORKER_URL ? "unverified" : "unconfigured"),
      endpoint: rigging.endpoint || null,
      reason: rigging.reason || (env.COMIC30_RIG_WORKER_URL ? "The configured rig worker has not passed a health check." : "COMIC30_RIG_WORKER_URL is not configured."),
      requiredEnvironment: "COMIC30_RIG_WORKER_URL"
    },
    animation: {
      id: "animation-worker",
      label: "Animation generation worker",
      configured: animation.configured === true,
      available: animation.available === true,
      mode: animation.mode || (env.COMIC30_ANIMATION_WORKER_URL ? "unverified" : "unconfigured"),
      endpoint: animation.endpoint || null,
      reason: animation.reason || (env.COMIC30_ANIMATION_WORKER_URL ? "The configured animation worker has not passed a health check." : "COMIC30_ANIMATION_WORKER_URL is not configured."),
      requiredEnvironment: "COMIC30_ANIMATION_WORKER_URL"
    },
    audio: {
      id: "audio-worker",
      label: "Music, ambience, and SFX worker",
      configured: audio.configured === true,
      available: audio.available === true,
      mode: audio.mode || (env.COMIC30_AUDIO_WORKER_URL ? "unverified" : "unconfigured"),
      endpoint: audio.endpoint || null,
      reason: audio.reason || (env.COMIC30_AUDIO_WORKER_URL ? "The configured audio worker has not passed a health check." : "COMIC30_AUDIO_WORKER_URL is not configured."),
      requiredEnvironment: "COMIC30_AUDIO_WORKER_URL"
    },
    unreal: {
      id: "unreal-worker",
      label: "Unreal production worker",
      available: Boolean(unreal.available || env.UNREAL_BUILDER_URL),
      mode: unreal.available ? "local" : env.UNREAL_BUILDER_URL ? "remote" : "unconfigured",
      templates: unrealTemplates
    },
    unity: {
      id: "unity-worker",
      label: "Unity mobile worker",
      available: Boolean(unity.available || env.UNITY_BUILDER_URL),
      mode: unity.available ? "local" : env.UNITY_BUILDER_URL ? "remote" : "unconfigured",
      modules: Array.isArray(unity.modules) ? unity.modules : []
    }
  };
}

function compileGameSpec(project, prompt, options = {}) {
  const request = text(prompt, "Create a third-person action game");
  const family = classifyPrompt(request);
  const targets = Array.isArray(options.targets) && options.targets.length
    ? options.targets.map(String)
    : ["Win64", "Android", "iOS"];
  const title = text(options.title, project?.title || family.label);
  const artDirection = text(options.artDirection, project?.design?.artStyle || "high-fidelity cinematic realism");
  return {
    version: SPEC_VERSION,
    id: id("gamespec"),
    request,
    title,
    family: { id: family.id, label: family.label },
    quality: {
      tier: text(options.qualityTier, "production"),
      artDirection,
      geometry: "production meshes with authored topology, UVs, PBR materials, collision, and LODs",
      characters: family.requiresCharacterRig ? "skinned skeletal meshes with validated retargetable rigs" : "not required for the primary playable loop"
    },
    experience: {
      playerPromise: text(project?.design?.playerPromise, `A polished ${family.label.toLowerCase()} experience generated from the creator brief.`),
      coreLoop: family.systems,
      camera: family.camera,
      controls: family.controls,
      sessionMinutes: Number(project?.gameplay?.sessionMinutes || 8)
    },
    content: {
      assetRequirements: family.assets.map((name, index) => ({ id: `asset-${index + 1}`, name, novel: true, required: true, ...assetProductionProfile(name) })),
      animationRequirements: family.animations.map((name, index) => ({ id: `animation-${index + 1}`, name, required: true })),
      levelRequirements: ["playable start", "core-loop encounter", "progression beat", "failure and restart", "completion or endless score loop"],
      audioRequirements: audioProductionRequirements(request, family)
    },
    engine: {
      primary: "unreal-5.6",
      template: family.template,
      targets,
      rendering: ["Lumen", "Nanite where compatible", "Virtual Shadow Maps", "PBR materials"],
      mobileProfile: targets.some((target) => /android|ios/i.test(target)) ? "scalable mobile device profile required" : null
    },
    generatedAt: now()
  };
}

function node(nodeId, label, worker, dependencies = [], options = {}) {
  const available = options.available !== false;
  return {
    id: nodeId,
    label,
    worker,
    dependencies,
    required: options.required !== false,
    status: options.completed ? "completed" : available ? "ready" : "blocked",
    blocker: available ? null : options.blocker,
    evidence: options.evidence || [],
    attempts: [],
    updatedAt: now()
  };
}

function createProductionGraph(spec, workers) {
  const templates = workers.unreal.templates || [];
  const templateSupported = workers.unreal.available && templates.includes(spec.engine.template);
  const needsRig = spec.content.assetRequirements.some((item) => item.rigRequired === true);
  const graph = [
    node("spec", "Compile typed game specification", "specification", [], { completed: true, evidence: [{ type: "inline-spec", id: spec.id }] }),
    node("gameplay-design", "Resolve gameplay systems and controls", "design", ["spec"], { completed: true, evidence: [{ type: "game-spec", path: "experience.coreLoop" }] }),
    node("level-design", "Resolve level and encounter graph", "design", ["spec"], { completed: true, evidence: [{ type: "game-spec", path: "content.levelRequirements" }] }),
    node("asset-generation", "Generate production source meshes and PBR materials", "sourceAssets", ["spec"], {
      available: workers.sourceAssets.available,
      blocker: `${workers.sourceAssets.reason || `Connect a high-fidelity asset worker with ${workers.sourceAssets.requiredEnvironment}.`} Catalog assets can support prototypes but do not satisfy novel production asset requirements.`
    }),
    node("character-rig", "Create and validate skeletal rigs", "rigging", ["asset-generation"], needsRig ? {
      available: workers.rigging.available,
      blocker: workers.rigging.reason || `Connect a rigging worker with ${workers.rigging.requiredEnvironment}.`
    } : { completed: true, required: false, evidence: [{ type: "not-required", reason: "Primary loop does not require a humanoid character rig." }] }),
    node("animation", "Generate and validate animation sets", "animation", needsRig ? ["character-rig"] : ["asset-generation"], {
      available: workers.animation.available,
      blocker: workers.animation.reason || `Connect an animation worker with ${workers.animation.requiredEnvironment}.`
    }),
    node("audio", "Generate music, ambience, and gameplay SFX", "audio", ["spec"], {
      available: workers.audio.available,
      blocker: workers.audio.reason || `Connect an audio worker with ${workers.audio.requiredEnvironment}.`
    }),
    node("engine-project", `Generate ${spec.engine.primary} project`, "unreal", ["gameplay-design", "level-design"], {
      available: templateSupported,
      blocker: workers.unreal.available
        ? `The installed Unreal worker does not provide the required ${spec.engine.template} template. Available templates: ${templates.join(", ") || "none"}.`
        : "No local or remote Unreal production worker is configured."
    }),
    node("engine-import", "Import generated source assets, validated rigs, retargeted animation, and validated audio into Unreal", "unreal", ["engine-project", "asset-generation", "character-rig", "animation", "audio"]),
    node("engine-validation", "Validate maps, Blueprints, imported assets, rigs, and animation", "unreal", ["engine-import"]),
    node("cook", "Cook target content", "unreal", ["engine-validation", "audio"]),
    node("package", "Package target builds", "unreal", ["cook"]),
    node("artifact-qa", "Run artifact and playability QA", "unreal", ["package"])
  ];
  return graph;
}

function dependencyComplete(graph, item) {
  return item.dependencies.every((dependency) => graph.find((nodeItem) => nodeItem.id === dependency)?.status === "completed");
}

function graphSummary(graph) {
  const required = graph.filter((item) => item.required);
  const completed = required.filter((item) => item.status === "completed");
  const blocked = required.filter((item) => item.status === "blocked");
  const failed = required.filter((item) => item.status === "failed");
  const verifiedPercent = required.length ? Math.round((completed.length / required.length) * 100) : 0;
  const prototypeIds = new Set(["spec", "gameplay-design", "level-design", "engine-project", "engine-validation"]);
  const prototypeNodes = required.filter((item) => prototypeIds.has(item.id));
  return {
    status: completed.length === required.length ? "production-verified" : failed.length ? "failed" : blocked.length ? "blocked" : "in-progress",
    verifiedPercent,
    completed: completed.length,
    required: required.length,
    blockers: [...blocked, ...failed].map((item) => ({ nodeId: item.id, label: item.label, detail: item.blocker || item.error || "Worker output failed validation." })),
    prototypeReady: prototypeNodes.length > 0 && prototypeNodes.every((item) => item.status === "completed")
  };
}

function createProductionRun(project, prompt, capabilities, options = {}, env = process.env) {
  const workers = workerRegistry(capabilities, env);
  const spec = compileGameSpec(project, prompt, options);
  const graph = createProductionGraph(spec, workers);
  const createdAt = now();
  const run = {
    version: RUN_VERSION,
    id: id("t2g"),
    projectId: project.id,
    prompt: spec.request,
    status: "planned",
    spec,
    workers,
    graph,
    summary: graphSummary(graph),
    sourceAssetJob: null,
    rigJob: null,
    animationJob: null,
    audioJob: null,
    engineJobId: null,
    orchestrationJobId: null,
    createdAt,
    updatedAt: createdAt
  };
  project.textToGameRuns = Array.isArray(project.textToGameRuns) ? project.textToGameRuns : [];
  project.textToGameRuns.unshift(run);
  return run;
}

function completeGraphNode(run, nodeId, evidence) {
  const item = run.graph.find((entry) => entry.id === nodeId);
  if (!item) return;
  item.status = "completed";
  item.blocker = null;
  item.error = null;
  item.evidence = Array.isArray(evidence) ? evidence : evidence ? [evidence] : item.evidence;
  item.updatedAt = now();
}

function failGraphNode(run, nodeId, error) {
  const item = run.graph.find((entry) => entry.id === nodeId);
  if (!item) return;
  item.status = "failed";
  item.error = text(error, "Worker output failed validation.").slice(0, 500);
  item.updatedAt = now();
}

function attachSourceAssetJob(run, job) {
  if (!run || !job?.id) throw new Error("A production run and source-asset job are required.");
  const item = run.graph.find((entry) => entry.id === "asset-generation");
  if (!item) throw new Error("This production graph does not contain an asset-generation stage.");
  run.sourceAssetJob = {
    ...job,
    requirements: Array.isArray(job.requirements) ? job.requirements : run.spec?.content?.assetRequirements || []
  };
  item.status = ["queued", "running"].includes(job.status) ? job.status : "pending";
  item.blocker = null;
  item.error = null;
  item.attempts.unshift({ jobId: job.id, provider: job.provider || "unknown", status: job.status || "queued", createdAt: now() });
  item.updatedAt = now();
  run.status = "in-progress";
  run.summary = graphSummary(run.graph);
  run.updatedAt = now();
  return run;
}

function syncSourceAssetJob(run, job, validation) {
  if (!run || !job?.id) throw new Error("A production run and source-asset job are required.");
  const item = run.graph.find((entry) => entry.id === "asset-generation");
  run.sourceAssetJob = { ...job, requirements: Array.isArray(job.requirements) ? job.requirements : run.sourceAssetJob?.requirements || [] };
  if (job.status === "completed" && validation?.ok) {
    completeGraphNode(run, "asset-generation", (job.outputs || []).map((output) => ({
      type: "validated-source-asset",
      assetId: output.assetId,
      name: output.name,
      provider: output.provider,
      url: output.artifact?.url,
      sha256: output.artifact?.sha256,
      bytes: output.artifact?.bytes,
      validation: output.validation?.metrics || {}
    })));
  } else if (job.status === "failed") {
    failGraphNode(run, "asset-generation", job.error || "The source-asset worker failed.");
  } else if (job.status === "completed") {
    failGraphNode(run, "asset-generation", validation?.errors?.join(" ") || "Source-asset evidence was incomplete.");
  } else if (item) {
    item.status = job.status === "running" ? "running" : "queued";
    item.blocker = null;
    item.updatedAt = now();
  }
  run.summary = graphSummary(run.graph);
  run.status = run.summary.status;
  run.updatedAt = now();
  return run;
}

function attachRigJob(run, job) {
  if (!run || !job?.id) throw new Error("A production run and rig job are required.");
  const item = run.graph.find((entry) => entry.id === "character-rig");
  if (!item) throw new Error("This production graph does not contain a character-rig stage.");
  run.rigJob = { ...job, requirements: Array.isArray(job.requirements) ? job.requirements : run.spec?.content?.assetRequirements?.filter((entry) => entry.rigRequired === true) || [] };
  item.status = ["queued", "running"].includes(job.status) ? job.status : "pending";
  item.blocker = null;
  item.error = null;
  item.attempts.unshift({ jobId: job.id, provider: job.provider || "unknown", status: job.status || "queued", createdAt: now() });
  item.updatedAt = now();
  run.status = "in-progress";
  run.summary = graphSummary(run.graph);
  run.updatedAt = now();
  return run;
}

function syncRigJob(run, job, validation) {
  if (!run || !job?.id) throw new Error("A production run and rig job are required.");
  const item = run.graph.find((entry) => entry.id === "character-rig");
  run.rigJob = { ...job, requirements: Array.isArray(job.requirements) ? job.requirements : run.rigJob?.requirements || [] };
  if (job.status === "completed" && validation?.ok) {
    completeGraphNode(run, "character-rig", (job.outputs || []).map((output) => ({
      type: "validated-rig",
      assetId: output.assetId,
      name: output.name,
      profile: output.profile,
      provider: output.provider,
      url: output.artifact?.url,
      sha256: output.artifact?.sha256,
      bytes: output.artifact?.bytes,
      mapping: output.validation?.mapping || {},
      deformationQa: output.validation?.deformationQa || {},
      metrics: output.validation?.metrics || {}
    })));
  } else if (job.status === "failed") {
    failGraphNode(run, "character-rig", job.error || "The rig worker failed.");
  } else if (job.status === "completed") {
    failGraphNode(run, "character-rig", validation?.errors?.join(" ") || "Rig evidence was incomplete.");
  } else if (item) {
    item.status = job.status === "running" ? "running" : "queued";
    item.blocker = null;
    item.updatedAt = now();
  }
  run.summary = graphSummary(run.graph);
  run.status = run.summary.status;
  run.updatedAt = now();
  return run;
}

function attachAnimationJob(run, job) {
  if (!run || !job?.id) throw new Error("A production run and animation job are required.");
  const item = run.graph.find((entry) => entry.id === "animation");
  if (!item) throw new Error("This production graph does not contain an animation stage.");
  run.animationJob = { ...job, requirements: Array.isArray(job.requirements) ? job.requirements : run.spec?.content?.animationRequirements || [] };
  item.status = ["queued", "running"].includes(job.status) ? job.status : "pending";
  item.blocker = null;
  item.error = null;
  item.attempts.unshift({ jobId: job.id, provider: job.provider || "unknown", status: job.status || "queued", createdAt: now() });
  item.updatedAt = now();
  run.status = "in-progress";
  run.summary = graphSummary(run.graph);
  run.updatedAt = now();
  return run;
}

function syncAnimationJob(run, job, validation) {
  if (!run || !job?.id) throw new Error("A production run and animation job are required.");
  const item = run.graph.find((entry) => entry.id === "animation");
  run.animationJob = { ...job, requirements: Array.isArray(job.requirements) ? job.requirements : run.animationJob?.requirements || [] };
  if (job.status === "completed" && validation?.ok) {
    completeGraphNode(run, "animation", (job.outputs || []).flatMap((output) => (output.clips || []).map((clip) => ({
      type: "validated-animation",
      assetId: output.assetId,
      name: clip.name,
      profile: output.profile,
      provider: clip.provider || output.provider,
      url: clip.artifact?.url,
      sha256: clip.artifact?.sha256,
      bytes: clip.artifact?.bytes,
      animationQa: clip.validation?.animationQa || {},
      deformationQa: clip.validation?.deformationQa || {}
    }))));
  } else if (job.status === "failed") {
    failGraphNode(run, "animation", job.error || "The animation worker failed.");
  } else if (job.status === "completed") {
    failGraphNode(run, "animation", validation?.errors?.join(" ") || "Animation evidence was incomplete.");
  } else if (item) {
    item.status = job.status === "running" ? "running" : "queued";
    item.blocker = null;
    item.updatedAt = now();
  }
  run.summary = graphSummary(run.graph);
  run.status = run.summary.status;
  run.updatedAt = now();
  return run;
}

function attachAudioJob(run, job) {
  if (!run || !job?.id) throw new Error("A production run and audio job are required.");
  const item = run.graph.find((entry) => entry.id === "audio");
  if (!item) throw new Error("This production graph does not contain an audio stage.");
  run.audioJob = { ...job, requirements: Array.isArray(job.requirements) ? job.requirements : run.spec?.content?.audioRequirements || [] };
  item.status = ["queued", "running"].includes(job.status) ? job.status : "pending";
  item.blocker = null;
  item.error = null;
  item.attempts.unshift({ jobId: job.id, provider: job.provider || "unknown", status: job.status || "queued", createdAt: now() });
  item.updatedAt = now();
  run.status = "in-progress";
  run.summary = graphSummary(run.graph);
  run.updatedAt = now();
  return run;
}

function syncAudioJob(run, job, validation) {
  if (!run || !job?.id) throw new Error("A production run and audio job are required.");
  const item = run.graph.find((entry) => entry.id === "audio");
  run.audioJob = { ...job, requirements: Array.isArray(job.requirements) ? job.requirements : run.audioJob?.requirements || [] };
  if (job.status === "completed" && validation?.ok) {
    completeGraphNode(run, "audio", (job.outputs || []).map((clip) => ({
      type: "validated-audio",
      clipId: clip.id,
      name: clip.name,
      kind: clip.kind,
      provider: clip.provider,
      url: clip.artifact?.url,
      sha256: clip.artifact?.sha256,
      bytes: clip.artifact?.bytes,
      provenance: clip.provenance || {},
      license: clip.license || {},
      metrics: clip.validation?.metrics || {},
      audioQa: clip.validation?.audioQa || {}
    })));
  } else if (job.status === "failed") {
    failGraphNode(run, "audio", job.error || "The audio worker failed.");
  } else if (job.status === "completed") {
    failGraphNode(run, "audio", validation?.errors?.join(" ") || "Audio evidence was incomplete.");
  } else if (item) {
    item.status = job.status === "running" ? "running" : "queued";
    item.blocker = null;
    item.updatedAt = now();
  }
  run.summary = graphSummary(run.graph);
  run.status = run.summary.status;
  run.updatedAt = now();
  return run;
}

function syncProductionRun(project, runId, capabilities, env = process.env) {
  project.textToGameRuns = Array.isArray(project.textToGameRuns) ? project.textToGameRuns : [];
  const run = project.textToGameRuns.find((item) => item.id === runId) || project.textToGameRuns[0];
  if (!run) throw new Error("Create a text-to-game production plan before syncing worker output.");
  run.workers = workerRegistry(capabilities, env);
  const orchestration = project.orchestrationJobs?.find((item) => item.id === run.orchestrationJobId) || project.orchestrationJobs?.[0];
  if (orchestration) {
    run.orchestrationJobId = orchestration.id;
    if (orchestration.status === "blueprint-generated") {
      completeGraphNode(run, "gameplay-design", { type: "orchestration", id: orchestration.id });
      completeGraphNode(run, "level-design", { type: "orchestration", id: orchestration.id });
    }
  }
  const job = project.engineBuildJobs?.find((item) => item.id === run.engineJobId) || project.engineBuildJobs?.[0];
  if (job) {
    run.engineJobId = job.id;
    const stage = (stageId) => job.stages?.find((item) => item.id === stageId);
    if (stage("project")?.status === "completed") completeGraphNode(run, "engine-project", { type: "unreal-project", id: job.id, path: job.projectFile || null });
    if (stage("import")?.status === "completed") {
      completeGraphNode(run, "engine-import", {
        type: "unreal-interchange-import",
        id: job.id,
        importedCount: job.import?.importedCount || 0,
        skeletalMeshCount: job.import?.skeletalMeshCount || 0,
        skeletonCount: job.import?.skeletonCount || 0,
        animationCount: job.import?.animationCount || 0,
        soundWaveCount: job.import?.soundWaveCount || 0
      });
      // Catalog assets are evidence for a template prototype only. They never satisfy novel production-asset generation.
    } else if (stage("import")?.status === "failed") failGraphNode(run, "engine-import", job.import?.error);
    if (stage("validate")?.status === "completed" && job.validation?.ok) completeGraphNode(run, "engine-validation", { type: "unreal-validation", id: job.id });
    else if (stage("validate")?.status === "failed") failGraphNode(run, "engine-validation", job.validation?.error);
    if (stage("cook")?.status === "completed") completeGraphNode(run, "cook", { type: "unreal-cook", id: job.id });
    if (stage("package")?.status === "completed" && job.package?.ok) completeGraphNode(run, "package", { type: "unreal-package", id: job.id, archiveDir: job.package.archiveDir || null });
    else if (stage("package")?.status === "failed") failGraphNode(run, "package", job.package?.error);
    if (stage("qa")?.status === "completed" && job.package?.qa?.ok) completeGraphNode(run, "artifact-qa", { type: "artifact-qa", id: job.id, fileCount: job.package.qa.fileCount || 0 });
    else if (stage("qa")?.status === "failed") failGraphNode(run, "artifact-qa", job.package?.qa?.error);
  }
  run.graph.forEach((item) => {
    if (item.status === "ready" && !dependencyComplete(run.graph, item)) item.status = "pending";
    else if (item.status === "pending" && dependencyComplete(run.graph, item)) item.status = "ready";
  });
  run.summary = graphSummary(run.graph);
  run.status = run.summary.status;
  run.updatedAt = now();
  return run;
}

module.exports = {
  SPEC_VERSION,
  RUN_VERSION,
  classifyPrompt,
  workerRegistry,
  compileGameSpec,
  createProductionRun,
  attachSourceAssetJob,
  syncSourceAssetJob,
  attachRigJob,
  syncRigJob,
  attachAnimationJob,
  syncAnimationJob,
  attachAudioJob,
  syncAudioJob,
  syncProductionRun,
  graphSummary
};
