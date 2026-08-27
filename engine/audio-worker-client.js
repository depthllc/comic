"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { inspectWavBuffer } = require("./audio-inspector");
const { validateUnrealAudioHandoff } = require("./unreal-audio-handoff");

function baseUrl(env = process.env) { return String(env.COMIC30_AUDIO_WORKER_URL || "").trim().replace(/\/+$/, ""); }
function headers(env = process.env) {
  const result = { Accept: "application/json" };
  const token = String(env.COMIC30_AUDIO_WORKER_TOKEN || "").trim();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function request(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Audio worker returned HTTP ${response.status}.`);
    return payload;
  } finally { clearTimeout(timer); }
}

async function probe(env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) return { configured: false, available: false, mode: "unconfigured", endpoint: null, reason: "COMIC30_AUDIO_WORKER_URL is not configured." };
  try {
    const health = await request(`${endpoint}/health`, { headers: headers(env) }, Number(env.COMIC30_AUDIO_HEALTH_TIMEOUT_MS || 3000));
    return { configured: true, available: health.ready === true, mode: "remote", endpoint, provider: health.provider || null, version: health.version || null, capabilities: health.capabilities || {}, reason: health.ready === true ? null : health.reason || "The audio worker is reachable but not ready." };
  } catch (error) {
    return { configured: true, available: false, mode: "unreachable", endpoint, reason: `Audio-worker health check failed: ${error.message}` };
  }
}

async function submit(spec, options = {}, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_AUDIO_WORKER_URL is not configured.");
  return request(`${endpoint}/v1/jobs`, {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      spec,
      productionRunId: options.productionRunId || spec.id,
      projectId: options.projectId || null,
      options
    })
  }, Number(env.COMIC30_AUDIO_SUBMIT_TIMEOUT_MS || 15000));
}

async function getJob(jobId, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_AUDIO_WORKER_URL is not configured.");
  return request(`${endpoint}/v1/jobs/${encodeURIComponent(jobId)}`, { headers: headers(env) }, Number(env.COMIC30_AUDIO_STATUS_TIMEOUT_MS || 8000));
}

function validateCompletedJob(job, requirements = []) {
  const errors = [];
  const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
  if (job?.status !== "completed") errors.push(`Audio job is ${job?.status || "missing"}, not completed.`);
  if (!outputs.length) errors.push("Audio job contains no clips.");
  if (!job?.handoffArtifact?.url || !job?.handoffArtifact?.sha256 || !job?.handoffArtifact?.bytes) errors.push("Audio job has no Unreal audio handoff evidence.");
  for (const requirement of requirements.filter((item) => item.required !== false)) {
    const clip = outputs.find((item) => item.id === requirement.id);
    if (!clip) { errors.push(`Audio job is missing required clip ${requirement.name}.`); continue; }
    if (!clip.artifact?.url || !clip.artifact?.sha256 || !clip.artifact?.bytes || clip.artifact?.format !== "wav") errors.push(`${requirement.name} has incomplete WAV evidence.`);
    if (clip.validation?.audioQa?.passed !== true) errors.push(`${requirement.name} did not pass acoustic QA.`);
    if (clip.license?.commercialUseAllowed !== true || !clip.provenance?.model) errors.push(`${requirement.name} lacks commercial-use licensing or model provenance.`);
  }
  return { ok: errors.length === 0, errors, outputCount: outputs.length };
}

function resolveArtifactUrl(value, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_AUDIO_WORKER_URL is not configured.");
  return new URL(String(value || ""), `${endpoint}/`).toString();
}

async function verifiedDownload(artifact, label, env) {
  const response = await fetch(resolveArtifactUrl(artifact.url, env), { headers: headers(env) });
  if (!response.ok) throw new Error(`Could not download ${label}: HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  if (digest !== artifact.sha256 || buffer.length !== Number(artifact.bytes)) throw new Error(`${label} failed checksum or byte-length verification.`);
  return buffer;
}

async function materializeArtifactEntries(job, targetDir, env = process.env) {
  const requirements = Array.isArray(job?.requirements) ? job.requirements : [];
  const validation = validateCompletedJob(job, requirements);
  if (!validation.ok) throw new Error(validation.errors.join(" "));
  await fsp.mkdir(targetDir, { recursive: true });
  const clips = [];
  for (const output of job.outputs || []) {
    const buffer = await verifiedDownload(output.artifact, output.name, env);
    const inspected = inspectWavBuffer(buffer, { expectedDurationSeconds: output.durationSeconds, loop: output.loop === true });
    if (!inspected.ok || inspected.audioQa?.passed !== true) throw new Error(`${output.name} failed portal-side acoustic QA: ${inspected.errors.join(" ")}`);
    const filename = String(output.artifact.filename || `${output.id}.wav`).replace(/[^A-Za-z0-9._-]/g, "_");
    const file = path.join(targetDir, filename);
    await fsp.writeFile(file, buffer);
    clips.push({ ...output, file, validation: inspected });
  }
  const handoffBuffer = await verifiedDownload(job.handoffArtifact, "Unreal audio handoff", env);
  let handoff;
  try { handoff = JSON.parse(handoffBuffer.toString("utf8")); }
  catch { throw new Error("Unreal audio handoff is not valid JSON."); }
  const handoffValidation = validateUnrealAudioHandoff(handoff);
  if (!handoffValidation.ok) throw new Error(`Unreal audio handoff failed validation: ${handoffValidation.errors.join(" ")}`);
  const handoffFilename = String(job.handoffArtifact.filename || "unreal-audio-handoff.json").replace(/[^A-Za-z0-9._-]/g, "_");
  const handoffFile = path.join(targetDir, handoffFilename);
  await fsp.writeFile(handoffFile, handoffBuffer);
  return { clips, handoffFile, handoff };
}

module.exports = { probe, submit, getJob, validateCompletedJob, resolveArtifactUrl, materializeArtifactEntries };
