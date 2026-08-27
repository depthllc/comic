"use strict";

require("../../engine/load-local-env")();

const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { inspectRiggedGlbBuffer } = require("../../engine/rig-inspector");
const { inspectAnimationGlbBuffer } = require("../../engine/animation-inspector");
const { validateUnrealRigHandoff } = require("../../engine/unreal-rig-handoff");
const { createUnrealAnimationHandoff } = require("../../engine/unreal-animation-handoff");
const { createMotionGptProvider } = require("./providers/motiongpt");
const { createProceduralProvider } = require("./providers/procedural");
const { normalizeProfiles, validateRetargetProfile } = require("./retarget-profiles");

const VERSION = "comic30.animation-worker.v1";
const PORT = Number(process.env.COMIC30_ANIMATION_WORKER_PORT || 5192);
const HOST = String(process.env.COMIC30_ANIMATION_WORKER_HOST || "127.0.0.1").trim();
const DATA_DIR = path.resolve(process.env.COMIC30_ANIMATION_WORKER_DATA_DIR || path.join(__dirname, "data"));
const JOB_DIR = path.join(DATA_DIR, "jobs");
const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");
const WORK_DIR = path.join(DATA_DIR, "work");
const ACCESS_TOKEN = String(process.env.COMIC30_ANIMATION_WORKER_TOKEN || "").trim();
const RIG_TOKEN = String(process.env.COMIC30_RIG_WORKER_TOKEN || "").trim();
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.COMIC30_ANIMATION_REQUEST_TIMEOUT_MS || 60000));
const MAX_ARTIFACT_BYTES = Math.max(1024 * 1024, Number(process.env.COMIC30_ANIMATION_MAX_ARTIFACT_BYTES || 500 * 1024 * 1024));
const ALLOWED_RIG_ORIGINS = new Set(String(process.env.COMIC30_ANIMATION_ALLOWED_RIG_ORIGINS || "http://127.0.0.1:5191,http://localhost:5191").split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean));
const motionGpt = createMotionGptProvider(process.env);
const procedural = createProceduralProvider(process.env);
let jobQueue = Promise.resolve();

function now() { return new Date().toISOString(); }
function identifier(prefix) { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }
function safeName(value, fallback = "asset") { return String(value || fallback).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || fallback; }
function json(res, status, payload) { const content = Buffer.from(JSON.stringify(payload)); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": content.length, "Cache-Control": "no-store" }); res.end(content); }
function authorized(req) { return !ACCESS_TOKEN || req.headers.authorization === `Bearer ${ACCESS_TOKEN}`; }

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error("Animation-worker request exceeds 4 MB."); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function writeJob(job) {
  await fsp.mkdir(JOB_DIR, { recursive: true });
  const target = path.join(JOB_DIR, `${job.id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, target);
}

async function readJob(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try { return JSON.parse(await fsp.readFile(path.join(JOB_DIR, `${id}.json`), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function download(url, label) {
  const parsed = new URL(url);
  if (!ALLOWED_RIG_ORIGINS.has(parsed.origin)) throw new Error(`${label} origin ${parsed.origin} is not allowed.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 5);
  try {
    const headers = {};
    if (RIG_TOKEN) headers.Authorization = `Bearer ${RIG_TOKEN}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} could not be downloaded: HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the artifact limit.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the artifact limit.`);
    return buffer;
  } finally { clearTimeout(timer); }
}

function verify(buffer, sha256, bytes, label) {
  if (buffer.length !== Number(bytes)) throw new Error(`${label} byte length does not match worker evidence.`);
  if (crypto.createHash("sha256").update(buffer).digest("hex") !== sha256) throw new Error(`${label} checksum does not match worker evidence.`);
}

async function loadSource(source) {
  const sourceBuffer = await download(source.url, `${source.name} rigged GLB`);
  verify(sourceBuffer, source.sha256, source.bytes, `${source.name} rigged GLB`);
  const rigValidation = inspectRiggedGlbBuffer(sourceBuffer, { profile: source.profile });
  if (!rigValidation.ok || rigValidation.deformationQa?.passed !== true) throw new Error(`${source.name} does not have a validated deforming rig: ${rigValidation.errors.join(" ")}`);
  const handoffBuffer = await download(source.handoffUrl, `${source.name} rig handoff`);
  verify(handoffBuffer, source.handoffSha256, source.handoffBytes, `${source.name} rig handoff`);
  let handoff;
  try { handoff = JSON.parse(handoffBuffer.toString("utf8")); } catch { throw new Error(`${source.name} rig handoff is not valid JSON.`); }
  const handoffValidation = validateUnrealRigHandoff(handoff);
  if (!handoffValidation.ok || handoff.assetId !== source.assetId) throw new Error(`${source.name} rig handoff failed validation: ${handoffValidation.errors.join(" ")}`);
  const retargetProfile = validateRetargetProfile(source.profile, handoff);
  if (!retargetProfile.ok) throw new Error(`${source.name} rig handoff cannot be retargeted: ${retargetProfile.errors.join(" ")}`);
  return { sourceBuffer, handoff, retargetProfile };
}

async function persistArtifact(job, assetId, suffix, buffer, format) {
  const directory = path.join(ARTIFACT_DIR, job.id);
  await fsp.mkdir(directory, { recursive: true });
  const filename = `${safeName(assetId)}-${safeName(suffix)}.${format}`;
  await fsp.writeFile(path.join(directory, filename), buffer);
  return { filename, url: `/v1/artifacts/${job.id}/${encodeURIComponent(filename)}`, bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), format };
}

async function chooseProvider(source) {
  const proceduralHealth = await procedural.probe();
  const proceduralProfiles = normalizeProfiles(proceduralHealth.capabilities || proceduralHealth, ["vehicle"]);
  if (proceduralHealth.ready && proceduralProfiles.includes(source.profile)) return procedural;
  const motionHealth = await motionGpt.probe();
  const motionProfiles = normalizeProfiles(motionHealth.capabilities, ["humanoid"]);
  if (motionHealth.ready && motionProfiles.includes(source.profile)) return motionGpt;
  throw new Error(`${source.name} has no animation provider that advertises ${source.profile} support. ${proceduralHealth.reason || ""} ${motionHealth.reason || ""}`.trim());
}

async function processSource(job, source) {
  const { sourceBuffer, handoff, retargetProfile } = await loadSource(source);
  const provider = await chooseProvider(source);
  const clips = [];
  for (const clip of source.requirements) {
    job.currentClip = { assetId: source.assetId, id: clip.id, name: clip.name };
    await writeJob(job);
    const workDir = path.join(WORK_DIR, job.id, safeName(source.assetId), safeName(clip.id));
    const generated = await provider.animate({ source, sourceBuffer, rigHandoff: handoff, clip, workDir });
    const validation = inspectAnimationGlbBuffer(generated.buffer, { profile: source.profile, expectedClip: clip.name });
    if (!validation.ok || validation.animationQa?.passed !== true || validation.deformationQa?.passed !== true) throw new Error(`${source.name} ${clip.name} failed retarget, animation, or deformation QA: ${validation.errors.join(" ")}`);
    const artifact = await persistArtifact(job, source.assetId, clip.id, generated.buffer, "glb");
    clips.push({ ...clip, provider: generated.provider, providerTasks: generated.providerTasks || {}, artifact, validation, generatedAt: now() });
  }
  const animationHandoff = createUnrealAnimationHandoff({ assetId: source.assetId, name: source.name, profile: source.profile, rigHandoff: handoff, clips });
  const handoffArtifact = await persistArtifact(job, source.assetId, "unreal-animation-handoff", Buffer.from(`${JSON.stringify(animationHandoff, null, 2)}\n`), "json");
  return { assetId: source.assetId, name: source.name, profile: source.profile, provider: provider.id, retargetProfile, clips, handoffArtifact, generatedAt: now() };
}

async function processJob(job) {
  job.status = "running"; job.startedAt = now(); job.updatedAt = job.startedAt; await writeJob(job);
  try {
    for (const source of job.sources) {
      job.currentAsset = { id: source.assetId, name: source.name, profile: source.profile };
      job.outputs.push(await processSource(job, source));
      job.progress = Math.round((job.outputs.length / job.sources.length) * 100);
      job.updatedAt = now(); await writeJob(job);
    }
    job.status = "completed"; job.progress = 100; job.completedAt = now(); job.currentAsset = null; job.currentClip = null;
  } catch (error) {
    job.status = "failed"; job.error = String(error.message || error).slice(0, 3000); job.failedAt = now(); job.currentAsset = null; job.currentClip = null;
  }
  job.updatedAt = now(); await writeJob(job);
}

async function createJob(payload) {
  const spec = payload?.spec;
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  if (!spec?.id || !spec?.request) throw new Error("A compiled Comic30 game specification is required.");
  if (!sources.length) throw new Error("At least one validated rig source is required.");
  for (const source of sources) {
    if (!source.assetId || !source.name || !source.url || !source.sha256 || !source.bytes || !source.handoffUrl || !source.handoffSha256 || !source.handoffBytes) throw new Error("Every animation source requires rigged-GLB and rig-handoff evidence.");
    source.profile = String(source.profile || "humanoid").toLowerCase();
    if (!["humanoid", "creature", "vehicle"].includes(source.profile)) throw new Error(`Unsupported animation profile ${source.profile}.`);
    if (!Array.isArray(source.requirements) || !source.requirements.length) throw new Error(`${source.name} has no animation requirements.`);
    for (const clip of source.requirements) if (!clip.id || !clip.name || !clip.prompt) throw new Error(`${source.name} has an incomplete animation requirement.`);
  }
  const createdAt = now();
  const job = { version: VERSION, id: identifier("animjob"), provider: "owned-first", status: "queued", progress: 0, spec, sources, requirements: sources[0].requirements, options: payload.options || {}, outputs: [], createdAt, updatedAt: createdAt };
  await writeJob(job);
  setImmediate(() => { jobQueue = jobQueue.then(() => processJob(job)).catch((error) => console.error("[animation-worker]", error)); });
  return job;
}

async function health() {
  const providers = { procedural: await procedural.probe(), motiongpt: await motionGpt.probe() };
  const ready = Object.values(providers).some((provider) => provider.ready);
  const motionProfiles = normalizeProfiles(providers.motiongpt.capabilities, ["humanoid"]);
  const proceduralProfiles = normalizeProfiles(providers.procedural.capabilities || providers.procedural, ["vehicle"]);
  const profiles = Object.fromEntries(["humanoid", "creature", "vehicle"].map((profile) => [profile,
    (providers.motiongpt.ready && motionProfiles.includes(profile)) || (providers.procedural.ready && proceduralProfiles.includes(profile))
  ]));
  return { service: "comic30-animation-worker", version: VERSION, ready, provider: "owned-first", reason: ready ? null : "No animation provider is configured.", providers, capabilities: { profiles, outputFormats: ["glb", "unreal-animation-handoff.json"], retargeting: true, animationQa: true, deformationQa: true, unrealInterchange: true, persistentJobs: true } };
}

async function initialize() {
  await Promise.all([fsp.mkdir(JOB_DIR, { recursive: true }), fsp.mkdir(ARTIFACT_DIR, { recursive: true }), fsp.mkdir(WORK_DIR, { recursive: true })]);
  for (const filename of await fsp.readdir(JOB_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const job = await readJob(filename.slice(0, -5));
    if (job && ["queued", "running"].includes(job.status)) { job.status = "failed"; job.error = "The animation worker restarted before this job completed. Submit a new job."; job.failedAt = now(); job.updatedAt = job.failedAt; await writeJob(job); }
  }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health" && req.method === "GET") return json(res, 200, await health());
  if (!authorized(req)) return json(res, 401, { error: "Invalid animation-worker token." });
  if (url.pathname === "/v1/jobs" && req.method === "POST") {
    if (!(await health()).ready) return json(res, 503, { error: "The animation worker has no configured provider." });
    return json(res, 202, { job: await createJob(await body(req)) });
  }
  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9_-]+)$/);
  if (jobMatch && req.method === "GET") { const job = await readJob(jobMatch[1]); return job ? json(res, 200, { job }) : json(res, 404, { error: "Animation job not found." }); }
  const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._%-]+)$/);
  if (artifactMatch && req.method === "GET") {
    const filename = path.basename(decodeURIComponent(artifactMatch[2]));
    const absolute = path.join(ARTIFACT_DIR, artifactMatch[1], filename);
    try { const stat = await fsp.stat(absolute); const mime = filename.endsWith(".json") ? "application/json; charset=utf-8" : "model/gltf-binary"; res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Cache-Control": "private, max-age=3600" }); return fs.createReadStream(absolute).pipe(res); }
    catch (error) { if (error.code === "ENOENT") return json(res, 404, { error: "Animation artifact not found." }); throw error; }
  }
  return json(res, 404, { error: "Animation-worker route not found." });
}

if (require.main === module) initialize().then(() => http.createServer((req, res) => handler(req, res).catch((error) => json(res, 500, { error: String(error.message || error).slice(0, 3000) }))).listen(PORT, HOST, () => console.log(`[Comic30 animation worker] http://${HOST}:${PORT}`))).catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { health, createJob, processJob, processSource, initialize };
