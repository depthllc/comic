"use strict";

require("../../engine/load-local-env")();

const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { inspectGlbBuffer } = require("../../engine/glb-inspector");
const { inspectRiggedGlbBuffer } = require("../../engine/rig-inspector");
const { createUnrealRigHandoff } = require("../../engine/unreal-rig-handoff");
const { createUniRigProvider } = require("./providers/unirig");
const { createHumanoidStrategy } = require("./strategies/humanoid");
const { createCreatureStrategy } = require("./strategies/creature");
const { createVehicleStrategy } = require("./strategies/vehicle");

const VERSION = "comic30.rig-worker.v2";
const PORT = Number(process.env.COMIC30_RIG_WORKER_PORT || 5191);
const HOST = String(process.env.COMIC30_RIG_WORKER_HOST || "127.0.0.1").trim();
const DATA_DIR = path.resolve(process.env.COMIC30_RIG_WORKER_DATA_DIR || path.join(__dirname, "data"));
const JOB_DIR = path.join(DATA_DIR, "jobs");
const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");
const WORK_DIR = path.join(DATA_DIR, "work");
const ACCESS_TOKEN = String(process.env.COMIC30_RIG_WORKER_TOKEN || "").trim();
const SOURCE_TOKEN = String(process.env.COMIC30_SOURCE_ASSET_WORKER_TOKEN || process.env.COMIC30_ASSET_WORKER_TOKEN || "").trim();
const MESHY_API_KEY = String(process.env.MESHY_API_KEY || "").trim();
const MESHY_ROOT = String(process.env.MESHY_API_ROOT || "https://api.meshy.ai").replace(/\/+$/, "");
const PROVIDER_ORDER = String(process.env.COMIC30_RIG_PROVIDER_ORDER || "unirig,meshy")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
const POLL_MS = Math.max(2000, Number(process.env.COMIC30_RIG_POLL_MS || 5000));
const MAX_WAIT_MS = Math.max(60000, Number(process.env.COMIC30_RIG_MAX_WAIT_MS || 30 * 60 * 1000));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.COMIC30_RIG_REQUEST_TIMEOUT_MS || 60000));
const MAX_ARTIFACT_BYTES = Math.max(1024 * 1024, Number(process.env.COMIC30_RIG_MAX_ARTIFACT_BYTES || 500 * 1024 * 1024));
const ALLOWED_SOURCE_ORIGINS = new Set(String(process.env.COMIC30_RIG_ALLOWED_SOURCE_ORIGINS || "http://127.0.0.1:5190,http://localhost:5190")
  .split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean));
const uniRig = createUniRigProvider(process.env);
const humanoidStrategy = createHumanoidStrategy({
  providerOrder: PROVIDER_ORDER,
  uniRig,
  meshifyFallback: meshifyHumanoid,
  fallbackConfigured: Boolean(MESHY_API_KEY)
});
const creatureStrategy = createCreatureStrategy({ providerOrder: PROVIDER_ORDER, uniRig });
const vehicleStrategy = createVehicleStrategy(process.env);
const strategies = { humanoid: humanoidStrategy, creature: creatureStrategy, vehicle: vehicleStrategy };
let jobQueue = Promise.resolve();

function now() { return new Date().toISOString(); }
function identifier(prefix) { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }
function safeName(value, fallback = "asset") { return String(value || fallback).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || fallback; }

function json(res, status, payload) {
  const content = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": content.length, "Cache-Control": "no-store" });
  res.end(content);
}

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("Rig-worker request exceeds 2 MB.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function authorized(req) { return !ACCESS_TOKEN || req.headers.authorization === `Bearer ${ACCESS_TOKEN}`; }

async function writeJob(job) {
  await fsp.mkdir(JOB_DIR, { recursive: true });
  const target = path.join(JOB_DIR, `${job.id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, target);
}

async function readJob(jobId) {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) return null;
  try { return JSON.parse(await fsp.readFile(path.join(JOB_DIR, `${jobId}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function providerRequest(endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${MESHY_ROOT}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${MESHY_API_KEY}`, "Content-Type": "application/json", Accept: "application/json", ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `Meshy returned HTTP ${response.status}.`);
    return payload;
  } finally { clearTimeout(timer); }
}

async function download(url, label, options = {}) {
  const parsed = new URL(url);
  if (options.source === true && !ALLOWED_SOURCE_ORIGINS.has(parsed.origin)) throw new Error(`${label} origin ${parsed.origin} is not in COMIC30_RIG_ALLOWED_SOURCE_ORIGINS.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 5);
  try {
    const requestHeaders = {};
    if (options.source === true && SOURCE_TOKEN) requestHeaders.Authorization = `Bearer ${SOURCE_TOKEN}`;
    const response = await fetch(url, { signal: controller.signal, headers: requestHeaders });
    if (!response.ok) throw new Error(`${label} could not be downloaded: HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the artifact limit.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the artifact limit.`);
    return buffer;
  } finally { clearTimeout(timer); }
}

async function pollMeshyRigging(taskId) {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const task = await providerRequest(`/openapi/v1/rigging/${encodeURIComponent(taskId)}`, { method: "GET" });
    if (task.status === "SUCCEEDED") return task;
    if (["FAILED", "CANCELED", "EXPIRED"].includes(task.status)) throw new Error(`Meshy rigging task ${taskId} ${String(task.status).toLowerCase()}: ${task.task_error?.message || task.error || "provider failure"}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Meshy rigging task ${taskId} exceeded the worker deadline.`);
}

function evidence(buffer, filename, format, url) {
  return { filename, url, bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), format };
}

async function persistArtifact(job, assetId, suffix, buffer, format) {
  const directory = path.join(ARTIFACT_DIR, job.id);
  await fsp.mkdir(directory, { recursive: true });
  const filename = `${safeName(assetId)}-${safeName(suffix)}.${format}`;
  await fsp.writeFile(path.join(directory, filename), buffer);
  return evidence(buffer, filename, format, `/v1/artifacts/${job.id}/${encodeURIComponent(filename)}`);
}

async function loadValidatedSource(source) {
  const buffer = await download(source.url, `Source GLB for ${source.name}`, { source: true });
  if (buffer.length !== Number(source.bytes)) throw new Error(`${source.name} source byte length does not match its evidence.`);
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  if (digest !== source.sha256) throw new Error(`${source.name} source checksum does not match its evidence.`);
  const structural = inspectGlbBuffer(buffer);
  if (!structural.ok) throw new Error(`${source.name} source GLB failed structural validation: ${structural.errors.join(" ")}`);
  return buffer;
}

async function meshifyHumanoid(source, sourceBuffer) {
  if (!MESHY_API_KEY) throw new Error("Meshy fallback is not configured (MESHY_API_KEY missing).");
  if (source.profile !== "humanoid") throw new Error("Meshy fallback only supports the humanoid strategy.");
  const created = await providerRequest("/openapi/v1/rigging", {
    method: "POST",
    body: JSON.stringify({ model_url: `data:model/gltf-binary;base64,${sourceBuffer.toString("base64")}`, height_meters: Math.max(0.3, Math.min(3, Number(source.heightMeters || 1.8))) })
  });
  const taskId = created.result || created.id;
  if (!taskId) throw new Error("Meshy did not return a rigging task ID.");
  const completed = await pollMeshyRigging(taskId);
  const result = completed.result || {};
  if (!result.rigged_character_glb_url) throw new Error("The completed Meshy task did not provide a rigged GLB URL.");
  const animationBuffers = {};
  for (const clip of ["walking", "running"]) {
    const url = result.basic_animations?.[`${clip}_glb_url`];
    if (!url) throw new Error(`Meshy rig result did not include the ${clip} deformation-test clip.`);
    animationBuffers[clip] = await download(url, `${clip} animation GLB for ${source.name}`);
  }
  return {
    provider: "meshy-fallback",
    riggedBuffer: await download(result.rigged_character_glb_url, `Rigged GLB for ${source.name}`),
    fbxBuffer: result.rigged_character_fbx_url ? await download(result.rigged_character_fbx_url, `Rigged FBX for ${source.name}`) : null,
    animationBuffers,
    providerTasks: { rigging: taskId }
  };
}

async function executeStrategy(source, sourceBuffer, workDir) {
  const strategy = strategies[source.profile];
  if (!strategy) throw new Error(`Unsupported rig strategy ${source.profile}.`);
  return strategy.rig({ source, sourceBuffer, workDir });
}

async function finalizeOutput(job, source, result) {
  const validation = result.validation || inspectRiggedGlbBuffer(result.riggedBuffer, { profile: source.profile });
  if (!validation.ok || validation.deformationQa?.passed !== true) throw new Error(`${source.name} failed skeleton, skin-weight, or static deformation QA: ${validation.errors.join(" ")}`);
  const animationArtifacts = {};
  const clipEvidence = [];
  for (const [clip, buffer] of Object.entries(result.animationBuffers || {})) {
    const clipValidation = inspectRiggedGlbBuffer(buffer, { profile: source.profile, requireAnimation: true });
    if (!clipValidation.ok || clipValidation.deformationQa?.passed !== true) throw new Error(`${source.name} ${clip} deformation QA failed: ${clipValidation.errors.join(" ")}`);
    animationArtifacts[clip] = await persistArtifact(job, source.assetId, clip, buffer, "glb");
    clipEvidence.push({ name: clip, animationCount: clipValidation.metrics.animationCount });
  }
  if (clipEvidence.length) validation.deformationQa = { ...validation.deformationQa, passed: true, mode: "animated-clip", clips: clipEvidence };
  const handoff = createUnrealRigHandoff({ assetId: source.assetId, name: source.name, profile: source.profile, mapping: validation.mapping, deformationQa: validation.deformationQa });
  const handoffArtifact = await persistArtifact(job, source.assetId, "unreal-rig-handoff", Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`), "json");
  return {
    assetId: source.assetId,
    name: source.name,
    profile: source.profile,
    provider: result.provider,
    providerTasks: result.providerTasks || {},
    artifact: await persistArtifact(job, source.assetId, "rigged", result.riggedBuffer, "glb"),
    fbxArtifact: result.fbxBuffer ? await persistArtifact(job, source.assetId, "rigged", result.fbxBuffer, "fbx") : null,
    animationArtifacts,
    handoffArtifact,
    validation,
    generatedAt: now()
  };
}

async function processJob(job) {
  job.status = "running";
  job.startedAt = now();
  job.updatedAt = job.startedAt;
  await writeJob(job);
  try {
    for (const source of job.sources) {
      job.currentAsset = { id: source.assetId, name: source.name, profile: source.profile };
      await writeJob(job);
      const sourceBuffer = await loadValidatedSource(source);
      const workDir = path.join(WORK_DIR, job.id, safeName(source.assetId));
      const result = await executeStrategy(source, sourceBuffer, workDir);
      job.outputs.push(await finalizeOutput(job, source, result));
      job.progress = Math.round((job.outputs.length / job.sources.length) * 100);
      job.updatedAt = now();
      await writeJob(job);
    }
    job.status = "completed";
    job.progress = 100;
    job.completedAt = now();
    job.currentAsset = null;
  } catch (error) {
    job.status = "failed";
    job.error = String(error.message || error).slice(0, 3000);
    job.failedAt = now();
    job.currentAsset = null;
  }
  job.updatedAt = now();
  await writeJob(job);
}

async function createJob(payload) {
  const spec = payload?.spec;
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  if (!spec?.id || !spec?.request) throw new Error("A compiled Comic30 game specification is required.");
  if (!sources.length) throw new Error("At least one validated source GLB is required.");
  for (const source of sources) {
    if (!source.assetId || !source.name || !source.url || !source.sha256 || !source.bytes) throw new Error("Every rig source requires assetId, name, URL, checksum, and byte evidence.");
    source.profile = String(source.profile || "humanoid").toLowerCase();
    if (!["humanoid", "creature", "vehicle"].includes(source.profile)) throw new Error(`Unsupported rig profile ${source.profile}.`);
    const strategyHealth = strategies[source.profile].probe();
    if (source.profile !== "vehicle" && strategyHealth.ready !== true) {
      throw new Error(`${source.profile} rig generation is not configured: ${strategyHealth.owned?.reason || strategyHealth.reason || "no healthy provider"}`);
    }
  }
  const createdAt = now();
  const job = {
    version: VERSION,
    id: identifier("rigjob"),
    provider: "owned-first",
    providerOrder: PROVIDER_ORDER,
    status: "queued",
    progress: 0,
    spec,
    sources,
    requirements: sources.map((source) => ({ id: source.assetId, name: source.name, rigRequired: true, rigProfile: source.profile })),
    options: payload.options || {},
    outputs: [],
    createdAt,
    updatedAt: createdAt
  };
  await writeJob(job);
  setImmediate(() => { jobQueue = jobQueue.then(() => processJob(job)).catch((error) => console.error("[rig-worker]", error)); });
  return job;
}

async function initialize() {
  await fsp.mkdir(JOB_DIR, { recursive: true });
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  await fsp.mkdir(WORK_DIR, { recursive: true });
  for (const filename of await fsp.readdir(JOB_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const job = await readJob(filename.slice(0, -5));
    if (job && ["queued", "running"].includes(job.status)) {
      job.status = "failed";
      job.error = "The rig worker restarted before this job completed. Submit a new job.";
      job.failedAt = now();
      job.updatedAt = job.failedAt;
      await writeJob(job);
    }
  }
}

function health() {
  const unirig = uniRig.probe();
  const vehicle = vehicleStrategy.probe();
  const meshy = { ready: Boolean(MESHY_API_KEY), reason: MESHY_API_KEY ? null : "MESHY_API_KEY is not configured (optional fallback)." };
  const humanoid = humanoidStrategy.probe();
  const creature = creatureStrategy.probe();
  const profiles = {
    humanoid: { ready: humanoid.ready, generationReady: humanoid.owned.ready, strategies: humanoid.providers },
    creature: { ready: creature.ready, generationReady: creature.owned.ready, strategies: creature.providers },
    vehicle: { ready: true, generationReady: vehicle.ready, acceptsAuthoredRig: true, strategies: ["authored-hierarchy", "blender-articulation"] }
  };
  const ready = Object.values(profiles).some((profile) => profile.ready);
  const generationReady = Object.values(profiles).some((profile) => profile.generationReady);
  return {
    service: "comic30-rig-worker",
    version: VERSION,
    ready,
    provider: "owned-first",
    providerOrder: PROVIDER_ORDER,
    generationReady,
    reason: generationReady ? null : "The rig gateway is running, but no generated-rig strategy is ready. Authored rigs can still be validated.",
    providers: { unirig, vehicle, meshy },
    capabilities: { profiles, outputFormats: ["glb", "fbx", "unreal-rig-handoff.json"], skeletonMapping: true, skinWeightValidation: true, deformationQa: true, unrealControlRigMapping: true, persistentJobs: true }
  };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health" && req.method === "GET") return json(res, 200, health());
  if (!authorized(req)) return json(res, 401, { error: "Invalid rig-worker token." });
  if (url.pathname === "/v1/jobs" && req.method === "POST") {
    if (!health().ready) return json(res, 503, { error: "The rig worker has no configured strategy." });
    return json(res, 202, { job: await createJob(await body(req)) });
  }
  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9_-]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = await readJob(jobMatch[1]);
    return job ? json(res, 200, { job }) : json(res, 404, { error: "Rig job not found." });
  }
  const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._%-]+)$/);
  if (artifactMatch && req.method === "GET") {
    const filename = path.basename(decodeURIComponent(artifactMatch[2]));
    const absolute = path.join(ARTIFACT_DIR, artifactMatch[1], filename);
    try {
      const stat = await fsp.stat(absolute);
      const mime = filename.toLowerCase().endsWith(".json") ? "application/json; charset=utf-8" : filename.toLowerCase().endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Cache-Control": "private, max-age=3600" });
      return fs.createReadStream(absolute).pipe(res);
    } catch (error) { if (error.code === "ENOENT") return json(res, 404, { error: "Rig artifact not found." }); throw error; }
  }
  return json(res, 404, { error: "Rig-worker route not found." });
}

if (require.main === module) {
  initialize().then(() => {
    http.createServer((req, res) => handler(req, res).catch((error) => json(res, 500, { error: String(error.message || error).slice(0, 3000) })))
      .listen(PORT, HOST, () => console.log(`[Comic30 rig worker] http://${HOST}:${PORT} owned-first=${PROVIDER_ORDER.join(",")}`));
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { health, createJob, processJob, finalizeOutput, executeStrategy, initialize };
