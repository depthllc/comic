"use strict";

require("../../engine/load-local-env")();

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { inspectWavBuffer } = require("../../engine/audio-inspector");
const { createUnrealAudioHandoff } = require("../../engine/unreal-audio-handoff");
const { createAudioCraftProvider } = require("./providers/audiocraft");

const VERSION = "comic30.audio-worker.v1";
const PORT = Number(process.env.COMIC30_AUDIO_WORKER_PORT || 5193);
const HOST = String(process.env.COMIC30_AUDIO_WORKER_HOST || "127.0.0.1").trim();
const DATA_DIR = path.resolve(process.env.COMIC30_AUDIO_WORKER_DATA_DIR || path.join(__dirname, "data"));
const JOB_DIR = path.join(DATA_DIR, "jobs");
const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");
const ACCESS_TOKEN = String(process.env.COMIC30_AUDIO_WORKER_TOKEN || "").trim();
const MAX_ARTIFACT_BYTES = Math.max(1024 * 1024, Number(process.env.COMIC30_AUDIO_MAX_ARTIFACT_BYTES || 250 * 1024 * 1024));
const provider = createAudioCraftProvider(process.env);
let jobQueue = Promise.resolve();

function now() { return new Date().toISOString(); }
function identifier(prefix) { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }
function safeName(value, fallback = "audio") { return String(value || fallback).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || fallback; }
function json(res, status, payload) { const content = Buffer.from(JSON.stringify(payload)); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": content.length, "Cache-Control": "no-store" }); res.end(content); }
function authorized(req) { return !ACCESS_TOKEN || req.headers.authorization === `Bearer ${ACCESS_TOKEN}`; }

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new Error("Audio-worker request exceeds 4 MB.");
    chunks.push(chunk);
  }
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
  try { return JSON.parse(await fsp.readFile(path.join(JOB_DIR, `${id}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function persistArtifact(job, clipId, buffer, format = "wav") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Audio provider returned an empty artifact.");
  if (buffer.length > MAX_ARTIFACT_BYTES) throw new Error(`Audio artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte worker ceiling.`);
  const directory = path.join(ARTIFACT_DIR, job.id);
  await fsp.mkdir(directory, { recursive: true });
  const filename = `${safeName(clipId)}.${format}`;
  await fsp.writeFile(path.join(directory, filename), buffer);
  return {
    filename,
    url: `/v1/artifacts/${job.id}/${encodeURIComponent(filename)}`,
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    format
  };
}

function normalizeRequirements(spec) {
  const requirements = Array.isArray(spec?.content?.audioRequirements) ? spec.content.audioRequirements : [];
  if (!requirements.length) throw new Error("The compiled game specification has no audio requirements.");
  const ids = new Set();
  return requirements.map((entry, index) => {
    const id = safeName(entry?.id || `audio-${index + 1}`);
    if (ids.has(id)) throw new Error(`Duplicate audio requirement ID ${id}.`);
    ids.add(id);
    const kind = String(entry?.kind || "sfx").trim().toLowerCase();
    if (!["music", "ambience", "ui", "sfx"].includes(kind)) throw new Error(`Unsupported audio kind ${kind}.`);
    const durationSeconds = Number(entry?.durationSeconds || (kind === "music" ? 15 : kind === "ambience" ? 10 : 1));
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0.25 || durationSeconds > 120) throw new Error(`${entry?.name || id} duration must be between 0.25 and 120 seconds.`);
    const prompt = String(entry?.prompt || "").trim();
    if (prompt.length < 8) throw new Error(`${entry?.name || id} needs a production audio prompt.`);
    return {
      id,
      name: String(entry?.name || `${kind} clip`).trim(),
      kind,
      prompt,
      durationSeconds,
      loop: entry?.loop === true,
      required: entry?.required !== false
    };
  });
}

async function processJob(job) {
  job.status = "running";
  job.startedAt = now();
  job.updatedAt = job.startedAt;
  await writeJob(job);
  try {
    for (const requirement of job.requirements) {
      job.currentClip = { id: requirement.id, name: requirement.name, kind: requirement.kind };
      await writeJob(job);
      const generated = await provider.generate(requirement, { productionRunId: job.productionRunId, spec: job.spec, projectId: job.projectId });
      const validation = inspectWavBuffer(generated.buffer, { expectedDurationSeconds: requirement.durationSeconds, loop: requirement.loop });
      if (!validation.ok || validation.audioQa?.passed !== true) throw new Error(`${requirement.name} failed acoustic QA: ${validation.errors.join(" ")}`);
      const license = generated.license || {};
      const provenance = generated.provenance || {};
      if (license.commercialUseAllowed !== true || !provenance.model) throw new Error(`${requirement.name} lacks commercial-use licensing or model provenance.`);
      const artifact = await persistArtifact(job, requirement.id, generated.buffer, "wav");
      job.outputs.push({
        ...requirement,
        provider: generated.provider || provider.id,
        providerTaskId: generated.providerTaskId || null,
        provenance,
        license,
        artifact,
        validation,
        generatedAt: now()
      });
      job.progress = Math.round((job.outputs.length / job.requirements.length) * 100);
      job.updatedAt = now();
      await writeJob(job);
    }
    const handoff = createUnrealAudioHandoff({ productionRunId: job.productionRunId || job.spec.id, clips: job.outputs });
    job.handoffArtifact = await persistArtifact(job, "unreal-audio-handoff", Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`), "json");
    job.status = "completed";
    job.progress = 100;
    job.completedAt = now();
    job.currentClip = null;
  } catch (error) {
    job.status = "failed";
    job.error = String(error.message || error).slice(0, 3000);
    job.failedAt = now();
    job.currentClip = null;
  }
  job.updatedAt = now();
  await writeJob(job);
}

async function createJob(payload) {
  const spec = payload?.spec;
  if (!spec?.id || !spec?.request) throw new Error("A compiled Comic30 game specification is required.");
  const requirements = normalizeRequirements(spec);
  const createdAt = now();
  const job = {
    version: VERSION,
    id: identifier("audiojob"),
    provider: provider.id,
    status: "queued",
    progress: 0,
    productionRunId: payload?.productionRunId || spec.id,
    projectId: payload?.projectId || null,
    spec,
    requirements,
    outputs: [],
    options: payload?.options || {},
    createdAt,
    updatedAt: createdAt
  };
  await writeJob(job);
  setImmediate(() => { jobQueue = jobQueue.then(() => processJob(job)).catch((error) => console.error("[audio-worker]", error)); });
  return job;
}

async function health() {
  const providerHealth = await provider.probe();
  return {
    service: "comic30-audio-worker",
    version: VERSION,
    ready: providerHealth.ready === true,
    provider: provider.id,
    reason: providerHealth.ready === true ? null : providerHealth.reason || "The owned audio provider is not ready.",
    providers: { audiocraft: providerHealth },
    capabilities: {
      kinds: ["music", "ambience", "ui", "sfx"],
      outputFormats: ["wav", "unreal-audio-handoff.json"],
      acousticQa: true,
      provenanceRequired: true,
      commercialUseLicenseRequired: true,
      unrealSoundWaveImport: true,
      persistentJobs: true
    }
  };
}

async function initialize() {
  await Promise.all([fsp.mkdir(JOB_DIR, { recursive: true }), fsp.mkdir(ARTIFACT_DIR, { recursive: true })]);
  for (const filename of await fsp.readdir(JOB_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const job = await readJob(filename.slice(0, -5));
    if (job && ["queued", "running"].includes(job.status)) {
      job.status = "failed";
      job.error = "The audio worker restarted before this job completed. Submit a new job.";
      job.failedAt = now();
      job.updatedAt = job.failedAt;
      await writeJob(job);
    }
  }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health" && req.method === "GET") return json(res, 200, await health());
  if (!authorized(req)) return json(res, 401, { error: "Invalid audio-worker token." });
  if (url.pathname === "/v1/jobs" && req.method === "POST") {
    if (!(await health()).ready) return json(res, 503, { error: "The audio worker has no ready owned provider." });
    return json(res, 202, { job: await createJob(await body(req)) });
  }
  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9_-]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = await readJob(jobMatch[1]);
    return job ? json(res, 200, { job }) : json(res, 404, { error: "Audio job not found." });
  }
  const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._%-]+)$/);
  if (artifactMatch && req.method === "GET") {
    const filename = path.basename(decodeURIComponent(artifactMatch[2]));
    const absolute = path.join(ARTIFACT_DIR, artifactMatch[1], filename);
    try {
      const stat = await fsp.stat(absolute);
      const mime = filename.endsWith(".json") ? "application/json; charset=utf-8" : "audio/wav";
      res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Cache-Control": "private, max-age=3600" });
      return fs.createReadStream(absolute).pipe(res);
    } catch (error) {
      if (error.code === "ENOENT") return json(res, 404, { error: "Audio artifact not found." });
      throw error;
    }
  }
  return json(res, 404, { error: "Audio-worker route not found." });
}

if (require.main === module) {
  initialize()
    .then(() => http.createServer((req, res) => handler(req, res).catch((error) => json(res, 500, { error: String(error.message || error).slice(0, 3000) }))).listen(PORT, HOST, () => console.log(`[Comic30 audio worker] http://${HOST}:${PORT}`)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { health, createJob, processJob, initialize, normalizeRequirements };
