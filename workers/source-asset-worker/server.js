"use strict";

require("../../engine/load-local-env")();
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { inspectGlbBuffer } = require("../../engine/glb-inspector");
const { createProviderRegistry, providerOrder } = require("./providers");

const VERSION = "comic30.source-asset-worker.v2";
const PORT = Number(process.env.COMIC30_ASSET_WORKER_PORT || 5190);
const HOST = String(process.env.COMIC30_ASSET_WORKER_HOST || "127.0.0.1").trim();
const DATA_DIR = path.resolve(process.env.COMIC30_ASSET_WORKER_DATA_DIR || path.join(__dirname, "data"));
const JOB_DIR = path.join(DATA_DIR, "jobs");
const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");
const ACCESS_TOKEN = String(process.env.COMIC30_ASSET_WORKER_TOKEN || "").trim();
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.COMIC30_PROVIDER_REQUEST_TIMEOUT_MS || 60000));
const MAX_ARTIFACT_BYTES = Math.max(1024 * 1024, Number(process.env.COMIC30_MAX_ARTIFACT_BYTES || 500 * 1024 * 1024));
const providers = createProviderRegistry(process.env);
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
    if (bytes > 2 * 1024 * 1024) throw new Error("Worker request exceeds 2 MB.");
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
async function downloadModel(url, label) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${label} uses unsupported protocol ${parsed.protocol}.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 5);
  try {
    const response = await fetch(parsed, { signal: controller.signal });
    if (!response.ok) throw new Error(`${label} could not be downloaded: HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the artifact limit.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the artifact limit.`);
    return buffer;
  } finally { clearTimeout(timer); }
}
function referenceImage(job, requirement) {
  const entries = Array.isArray(job.options?.referenceImages) ? job.options.referenceImages : [];
  const match = entries.find((item) => item?.assetId === requirement.id || String(item?.name || "").toLowerCase() === String(requirement.name || "").toLowerCase());
  const url = String(match?.url || match?.dataUri || "").trim();
  if (!url) return null;
  if (!/^https:\/\//i.test(url) && !/^data:image\/(?:png|jpe?g);base64,/i.test(url)) throw new Error(`Reference image for ${requirement.name} must be an HTTPS URL or PNG/JPEG data URI.`);
  return url;
}
function assetPrompt(spec, requirement) {
  const pose = requirement.rigProfile === "humanoid"
    ? " Standard humanoid biped in a neutral A-pose, unambiguous anatomy, facing +Z, suitable for skeleton generation and skinning."
    : requirement.rigProfile === "creature"
      ? " Neutral anatomical pose with separated limbs and clean limb-to-torso topology suitable for creature skeleton generation."
      : requirement.rigProfile === "vehicle"
        ? " Distinct chassis and four wheel components with centered wheel pivots, suitable for rigid vehicle articulation."
        : "";
  return `${requirement.name}. ${spec.request}. ${spec.quality?.artDirection || "high-fidelity cinematic realism"}. Production game asset, coherent proportions, authored details, isolated asset, clean silhouette, physically based materials.${pose}`.slice(0, 800);
}
async function persistGeneratedAsset(job, requirement, generated) {
  const buffer = await downloadModel(generated.modelUrl, `Generated GLB for ${requirement.name}`);
  const validation = inspectGlbBuffer(buffer);
  if (!validation.ok) throw new Error(`${requirement.name} failed independent GLB validation: ${validation.errors.join(" ")}`);
  const directory = path.join(ARTIFACT_DIR, job.id);
  await fsp.mkdir(directory, { recursive: true });
  const filename = `${safeName(requirement.id)}-${safeName(requirement.name, "model")}.glb`;
  await fsp.writeFile(path.join(directory, filename), buffer);
  return {
    assetId: requirement.id,
    name: requirement.name,
    provider: generated.provider,
    providerTasks: generated.providerTasks || {},
    input: generated.input || { mode: "prompt" },
    artifact: { filename, url: `/v1/artifacts/${job.id}/${encodeURIComponent(filename)}`, bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), format: "glb" },
    validation,
    thumbnailUrl: generated.thumbnailUrl || null,
    generatedAt: now()
  };
}
async function processJob(job) {
  job.status = "running";
  job.startedAt = now();
  job.updatedAt = job.startedAt;
  await writeJob(job);
  try {
    for (const requirement of job.requirements) {
      job.currentAsset = { id: requirement.id, name: requirement.name };
      job.updatedAt = now();
      await writeJob(job);
      const generated = await providers.generate({ job, requirement, prompt: assetPrompt(job.spec, requirement), imageUrl: referenceImage(job, requirement) });
      job.outputs.push(await persistGeneratedAsset(job, requirement, generated));
      job.progress = Math.round((job.outputs.length / job.requirements.length) * 100);
      job.updatedAt = now();
      await writeJob(job);
    }
    job.status = "completed";
    job.progress = 100;
    job.completedAt = now();
    job.currentAsset = null;
  } catch (error) {
    job.status = "failed";
    job.error = String(error.message || error).slice(0, 1800);
    job.failedAt = now();
    job.currentAsset = null;
  }
  job.updatedAt = now();
  await writeJob(job);
}
async function createJob(payload) {
  const spec = payload?.spec;
  if (!spec?.id || !spec?.request) throw new Error("A compiled Comic30 game specification is required.");
  const requirements = (Array.isArray(spec.content?.assetRequirements) ? spec.content.assetRequirements : []).filter((item) => item.required !== false);
  if (!requirements.length) throw new Error("The game specification contains no required source assets.");
  const createdAt = now();
  const job = { version: VERSION, id: identifier("assetjob"), providers: providerOrder(process.env), status: "queued", progress: 0, spec, requirements, options: payload.options || {}, outputs: [], createdAt, updatedAt: createdAt };
  await writeJob(job);
  setImmediate(() => { jobQueue = jobQueue.then(() => processJob(job)).catch((error) => console.error("[asset-worker]", error)); });
  return job;
}
async function initialize() {
  await fsp.mkdir(JOB_DIR, { recursive: true });
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  for (const filename of await fsp.readdir(JOB_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const job = await readJob(filename.slice(0, -5));
    if (job && ["queued", "running"].includes(job.status)) {
      job.status = "failed";
      job.error = "The worker restarted before this job completed. Submit a new job.";
      job.failedAt = now();
      job.updatedAt = job.failedAt;
      await writeJob(job);
    }
  }
}
async function healthPayload() {
  const health = await providers.health();
  const ready = health.some((item) => item.ready === true);
  return {
    service: "comic30-source-asset-worker",
    version: VERSION,
    ready,
    provider: health.find((item) => item.ready)?.id || null,
    providerOrder: providerOrder(process.env),
    providers: health,
    unknownProviders: providers.unknown,
    reason: ready ? null : health.map((item) => `${item.id}: ${item.reason}`).join(" ") || "No known source-asset provider is configured.",
    capabilities: { inputs: ["text", "image-reference"], outputFormats: ["glb"], pbr: true, structuralValidation: true, checksumEvidence: true, persistentJobs: true }
  };
}
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health" && req.method === "GET") return json(res, 200, await healthPayload());
  if (!authorized(req)) return json(res, 401, { error: "Invalid source-asset worker token." });
  if (url.pathname === "/v1/jobs" && req.method === "POST") {
    const health = await healthPayload();
    if (!health.ready) return json(res, 503, { error: health.reason });
    return json(res, 202, { job: await createJob(await body(req)) });
  }
  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9_-]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = await readJob(jobMatch[1]);
    return job ? json(res, 200, { job }) : json(res, 404, { error: "Asset job not found." });
  }
  const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._%-]+)$/);
  if (artifactMatch && req.method === "GET") {
    const filename = path.basename(decodeURIComponent(artifactMatch[2]));
    const absolute = path.join(ARTIFACT_DIR, artifactMatch[1], filename);
    try {
      const stat = await fsp.stat(absolute);
      res.writeHead(200, { "Content-Type": "model/gltf-binary", "Content-Length": stat.size, "Cache-Control": "private, max-age=3600" });
      return fs.createReadStream(absolute).pipe(res);
    } catch (error) { if (error.code === "ENOENT") return json(res, 404, { error: "Asset artifact not found." }); throw error; }
  }
  return json(res, 404, { error: "Source-asset worker route not found." });
}
initialize().then(() => {
  http.createServer((req, res) => handler(req, res).catch((error) => json(res, 500, { error: String(error.message || error).slice(0, 1800) })))
    .listen(PORT, HOST, () => console.log(`[Comic30 source-asset worker] http://${HOST}:${PORT} providers=${providerOrder(process.env).join(",")}`));
}).catch((error) => { console.error(error); process.exitCode = 1; });
