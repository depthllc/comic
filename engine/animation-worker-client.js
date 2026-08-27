"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const rigWorker = require("./rig-worker-client");
const { inspectAnimationGlbBuffer } = require("./animation-inspector");
const { validateUnrealAnimationHandoff } = require("./unreal-animation-handoff");

function baseUrl(env = process.env) { return String(env.COMIC30_ANIMATION_WORKER_URL || "").trim().replace(/\/+$/, ""); }
function headers(env = process.env) {
  const result = { Accept: "application/json" };
  const token = String(env.COMIC30_ANIMATION_WORKER_TOKEN || "").trim();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function request(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Animation worker returned HTTP ${response.status}.`);
    return payload;
  } finally { clearTimeout(timer); }
}

async function probe(env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) return { configured: false, available: false, mode: "unconfigured", endpoint: null, reason: "COMIC30_ANIMATION_WORKER_URL is not configured." };
  try {
    const health = await request(`${endpoint}/health`, { headers: headers(env) }, Number(env.COMIC30_ANIMATION_HEALTH_TIMEOUT_MS || 3000));
    return { configured: true, available: health.ready === true, mode: "remote", endpoint, provider: health.provider || null, version: health.version || null, capabilities: health.capabilities || {}, reason: health.ready === true ? null : health.reason || "The animation worker is reachable but not ready." };
  } catch (error) {
    return { configured: true, available: false, mode: "unreachable", endpoint, reason: `Animation-worker health check failed: ${error.message}` };
  }
}

function requiredAnimationSources(spec, rigJob, env = process.env) {
  const outputs = Array.isArray(rigJob?.outputs) ? rigJob.outputs : [];
  const requirements = Array.isArray(spec?.content?.animationRequirements) ? spec.content.animationRequirements : [];
  if (!requirements.length) throw new Error("The compiled game specification has no animation requirements.");
  return outputs.map((output) => {
    if (!output?.artifact?.url || output.validation?.ok !== true || !output?.handoffArtifact?.url) throw new Error(`Validated rig output is incomplete for ${output?.name || output?.assetId || "an asset"}.`);
    return {
      assetId: output.assetId,
      name: output.name,
      profile: output.profile,
      url: rigWorker.resolveArtifactUrl(output.artifact.url, env),
      sha256: output.artifact.sha256,
      bytes: output.artifact.bytes,
      handoffUrl: rigWorker.resolveArtifactUrl(output.handoffArtifact.url, env),
      handoffSha256: output.handoffArtifact.sha256,
      handoffBytes: output.handoffArtifact.bytes,
      requirements: requirements.map((requirement) => ({
        id: requirement.id,
        name: requirement.name,
        prompt: requirement.prompt || `${requirement.name} animation for ${spec.request}`,
        durationSeconds: Number(requirement.durationSeconds || 2),
        required: requirement.required !== false
      }))
    };
  });
}

async function submit(spec, rigJob, options = {}, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_ANIMATION_WORKER_URL is not configured.");
  const sources = requiredAnimationSources(spec, rigJob, env);
  if (!sources.length) throw new Error("The rig job has no validated outputs to animate.");
  return request(`${endpoint}/v1/jobs`, {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({ spec: { id: spec.id, request: spec.request, family: spec.family, quality: spec.quality }, sources, options })
  }, Number(env.COMIC30_ANIMATION_SUBMIT_TIMEOUT_MS || 15000));
}

async function getJob(jobId, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_ANIMATION_WORKER_URL is not configured.");
  return request(`${endpoint}/v1/jobs/${encodeURIComponent(jobId)}`, { headers: headers(env) }, Number(env.COMIC30_ANIMATION_STATUS_TIMEOUT_MS || 8000));
}

function validateCompletedJob(job, requirements = []) {
  const errors = [];
  const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
  if (job?.status !== "completed") errors.push(`Animation job is ${job?.status || "missing"}, not completed.`);
  if (!outputs.length) errors.push("Animation job contains no outputs.");
  for (const output of outputs) {
    if (!output.handoffArtifact?.url || !output.handoffArtifact?.sha256 || !output.handoffArtifact?.bytes) errors.push(`${output.name} has no Unreal animation handoff evidence.`);
    for (const requirement of requirements.filter((item) => item.required !== false)) {
      const clip = (output.clips || []).find((item) => item.id === requirement.id);
      if (!clip) { errors.push(`${output.name} is missing required clip ${requirement.name}.`); continue; }
      if (!clip.artifact?.url || !clip.artifact?.sha256 || !clip.artifact?.bytes) errors.push(`${output.name} ${requirement.name} has incomplete artifact evidence.`);
      if (clip.validation?.animationQa?.passed !== true || clip.validation?.deformationQa?.passed !== true) errors.push(`${output.name} ${requirement.name} did not pass animation and deformation QA.`);
    }
  }
  return { ok: errors.length === 0, errors, outputCount: outputs.length };
}

function resolveArtifactUrl(value, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_ANIMATION_WORKER_URL is not configured.");
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
  const entries = [];
  for (const output of job.outputs || []) {
    const handoffBuffer = await verifiedDownload(output.handoffArtifact, `${output.name} animation handoff`, env);
    let handoff;
    try { handoff = JSON.parse(handoffBuffer.toString("utf8")); } catch { throw new Error(`${output.name} animation handoff is not valid JSON.`); }
    const handoffValidation = validateUnrealAnimationHandoff(handoff);
    if (!handoffValidation.ok) throw new Error(`${output.name} animation handoff failed validation: ${handoffValidation.errors.join(" ")}`);
    const handoffFilename = String(output.handoffArtifact.filename || `${output.assetId}-unreal-animation-handoff.json`).replace(/[^A-Za-z0-9._-]/g, "_");
    const handoffFile = path.join(targetDir, handoffFilename);
    await fsp.writeFile(handoffFile, handoffBuffer);
    const clips = [];
    for (const clip of output.clips || []) {
      const buffer = await verifiedDownload(clip.artifact, `${output.name} ${clip.name}`, env);
      const inspected = inspectAnimationGlbBuffer(buffer, { profile: output.profile, expectedClip: clip.name });
      if (!inspected.ok) throw new Error(`${output.name} ${clip.name} failed portal-side animation QA: ${inspected.errors.join(" ")}`);
      const filename = String(clip.artifact.filename || `${output.assetId}-${clip.id}.glb`).replace(/[^A-Za-z0-9._-]/g, "_");
      const file = path.join(targetDir, filename);
      await fsp.writeFile(file, buffer);
      clips.push({ ...clip, file, validation: inspected });
    }
    entries.push({ assetId: output.assetId, name: output.name, profile: output.profile, clips, handoffFile, handoff, output });
  }
  return entries;
}

module.exports = { probe, submit, getJob, validateCompletedJob, requiredAnimationSources, resolveArtifactUrl, materializeArtifactEntries };
