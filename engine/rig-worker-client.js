"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sourceAssetWorker = require("./source-asset-worker-client");
const { inspectRiggedGlbBuffer } = require("./rig-inspector");
const { validateUnrealRigHandoff } = require("./unreal-rig-handoff");

function baseUrl(env = process.env) {
  return String(env.COMIC30_RIG_WORKER_URL || "").trim().replace(/\/+$/, "");
}

function headers(env = process.env) {
  const result = { Accept: "application/json" };
  const token = String(env.COMIC30_RIG_WORKER_TOKEN || "").trim();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function request(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Rig worker returned HTTP ${response.status}.`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) return { configured: false, available: false, mode: "unconfigured", endpoint: null, reason: "COMIC30_RIG_WORKER_URL is not configured." };
  try {
    const health = await request(`${endpoint}/health`, { headers: headers(env) }, Number(env.COMIC30_RIG_HEALTH_TIMEOUT_MS || 3000));
    return {
      configured: true,
      available: health.generationReady === true,
      gatewayAvailable: health.ready === true,
      mode: "remote",
      endpoint,
      provider: health.provider || null,
      version: health.version || null,
      capabilities: health.capabilities || {},
      reason: health.generationReady === true ? null : health.reason || "The rig gateway is reachable, but generated rigging is not ready."
    };
  } catch (error) {
    return { configured: true, available: false, mode: "unreachable", endpoint, reason: `Rig-worker health check failed: ${error.message}` };
  }
}

function requiredRigSources(spec, sourceJob, env = process.env) {
  const requirements = Array.isArray(spec?.content?.assetRequirements) ? spec.content.assetRequirements : [];
  const outputs = Array.isArray(sourceJob?.outputs) ? sourceJob.outputs : [];
  return requirements.filter((item) => item.rigRequired === true).map((requirement) => {
    const output = outputs.find((item) => item.assetId === requirement.id);
    if (!output?.artifact?.url || output.validation?.ok !== true) throw new Error(`Validated source output is missing for rig requirement ${requirement.name}.`);
    return {
      assetId: requirement.id,
      name: requirement.name,
      profile: requirement.rigProfile || "humanoid",
      heightMeters: Number(requirement.heightMeters || 1.8),
      url: sourceAssetWorker.resolveArtifactUrl(output.artifact.url, env),
      sha256: output.artifact.sha256,
      bytes: output.artifact.bytes,
      validation: output.validation
    };
  });
}

async function submit(spec, sourceJob, options = {}, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_RIG_WORKER_URL is not configured.");
  const sources = requiredRigSources(spec, sourceJob, env);
  if (!sources.length) throw new Error("The game specification has no assets that require rigging.");
  return request(`${endpoint}/v1/jobs`, {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({ spec: { id: spec.id, request: spec.request, family: spec.family, quality: spec.quality }, sources, options })
  }, Number(env.COMIC30_RIG_SUBMIT_TIMEOUT_MS || 15000));
}

async function getJob(jobId, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_RIG_WORKER_URL is not configured.");
  return request(`${endpoint}/v1/jobs/${encodeURIComponent(jobId)}`, { headers: headers(env) }, Number(env.COMIC30_RIG_STATUS_TIMEOUT_MS || 8000));
}

function validateCompletedJob(job, requirements = []) {
  const errors = [];
  const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
  if (job?.status !== "completed") errors.push(`Rig job is ${job?.status || "missing"}, not completed.`);
  for (const requirement of requirements.filter((item) => item.rigRequired === true)) {
    const output = outputs.find((item) => item.assetId === requirement.id);
    if (!output) {
      errors.push(`Required rig ${requirement.id} (${requirement.name}) has no worker output.`);
      continue;
    }
    if (!output.artifact?.url || !output.artifact?.sha256 || !output.artifact?.bytes) errors.push(`${requirement.name} has incomplete rigged-artifact evidence.`);
    if (output.validation?.ok !== true) errors.push(`${requirement.name} did not pass skeleton and skin-weight validation.`);
    if (output.validation?.deformationQa?.passed !== true) errors.push(`${requirement.name} did not pass deformation QA.`);
    if (!output.validation?.mapping || Object.keys(output.validation.mapping).length === 0) errors.push(`${requirement.name} has no validated skeleton mapping.`);
    if (!output.handoffArtifact?.url || !output.handoffArtifact?.sha256 || !output.handoffArtifact?.bytes) errors.push(`${requirement.name} has no Unreal rig-handoff evidence.`);
  }
  return { ok: errors.length === 0, errors, outputCount: outputs.length };
}

function resolveArtifactUrl(value, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_RIG_WORKER_URL is not configured.");
  return new URL(String(value || ""), `${endpoint}/`).toString();
}

async function materializeArtifactEntries(job, targetDir, env = process.env) {
  const validation = validateCompletedJob(job, job?.requirements || []);
  if (!validation.ok) throw new Error(validation.errors.join(" "));
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = [];
  for (const output of job.outputs || []) {
    const response = await fetch(resolveArtifactUrl(output.artifact.url, env), { headers: headers(env) });
    if (!response.ok) throw new Error(`Could not download rigged ${output.name}: HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (digest !== output.artifact.sha256) throw new Error(`${output.name} failed rig-artifact checksum verification.`);
    if (buffer.length !== Number(output.artifact.bytes)) throw new Error(`${output.name} rig-artifact byte length does not match worker evidence.`);
    const inspected = inspectRiggedGlbBuffer(buffer, { profile: output.profile || "humanoid" });
    if (!inspected.ok) throw new Error(`${output.name} failed portal-side rig validation: ${inspected.errors.join(" ")}`);
    const filename = String(output.artifact.filename || `${output.assetId}-rigged.glb`).replace(/[^A-Za-z0-9._-]/g, "_");
    const absolute = path.join(targetDir, filename);
    await fsp.writeFile(absolute, buffer);
    const handoffResponse = await fetch(resolveArtifactUrl(output.handoffArtifact.url, env), { headers: headers(env) });
    if (!handoffResponse.ok) throw new Error(`Could not download ${output.name} Unreal rig handoff: HTTP ${handoffResponse.status}.`);
    const handoffBuffer = Buffer.from(await handoffResponse.arrayBuffer());
    const handoffDigest = crypto.createHash("sha256").update(handoffBuffer).digest("hex");
    if (handoffDigest !== output.handoffArtifact.sha256 || handoffBuffer.length !== Number(output.handoffArtifact.bytes)) throw new Error(`${output.name} Unreal rig handoff failed evidence verification.`);
    let handoff;
    try { handoff = JSON.parse(handoffBuffer.toString("utf8")); }
    catch { throw new Error(`${output.name} Unreal rig handoff is not valid JSON.`); }
    const handoffValidation = validateUnrealRigHandoff(handoff);
    if (!handoffValidation.ok) throw new Error(`${output.name} Unreal rig handoff failed validation: ${handoffValidation.errors.join(" ")}`);
    const handoffFilename = String(output.handoffArtifact.filename || `${output.assetId}-unreal-rig-handoff.json`).replace(/[^A-Za-z0-9._-]/g, "_");
    const handoffFile = path.join(targetDir, handoffFilename);
    await fsp.writeFile(handoffFile, handoffBuffer);
    const animationFiles = [];
    for (const [clip, artifact] of Object.entries(output.animationArtifacts || {})) {
      const clipResponse = await fetch(resolveArtifactUrl(artifact.url, env), { headers: headers(env) });
      if (!clipResponse.ok) throw new Error(`Could not download ${output.name} ${clip} deformation clip: HTTP ${clipResponse.status}.`);
      const clipBuffer = Buffer.from(await clipResponse.arrayBuffer());
      const clipDigest = crypto.createHash("sha256").update(clipBuffer).digest("hex");
      if (clipDigest !== artifact.sha256 || clipBuffer.length !== Number(artifact.bytes)) throw new Error(`${output.name} ${clip} clip failed evidence verification.`);
      const clipValidation = inspectRiggedGlbBuffer(clipBuffer, { profile: output.profile || "humanoid", requireAnimation: true });
      if (!clipValidation.ok) throw new Error(`${output.name} ${clip} clip failed portal-side deformation QA: ${clipValidation.errors.join(" ")}`);
      const clipFilename = String(artifact.filename || `${output.assetId}-${clip}.glb`).replace(/[^A-Za-z0-9._-]/g, "_");
      const clipAbsolute = path.join(targetDir, clipFilename);
      await fsp.writeFile(clipAbsolute, clipBuffer);
      animationFiles.push({ clip, file: clipAbsolute, artifact, validation: clipValidation });
    }
    entries.push({ assetId: output.assetId, name: output.name, file: absolute, handoffFile, handoff, animationFiles, output });
  }
  return entries;
}

async function materializeArtifacts(job, targetDir, env = process.env) {
  return (await materializeArtifactEntries(job, targetDir, env)).flatMap((entry) => [entry.file, ...entry.animationFiles.map((clip) => clip.file)]);
}

module.exports = { probe, submit, getJob, validateCompletedJob, requiredRigSources, resolveArtifactUrl, materializeArtifactEntries, materializeArtifacts };
