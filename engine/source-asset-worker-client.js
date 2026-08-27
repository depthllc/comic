"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { inspectGlbBuffer } = require("./glb-inspector");

function baseUrl(env = process.env) {
  return String(env.COMIC30_ASSET_GENERATOR_URL || "").trim().replace(/\/+$/, "");
}

function headers(env = process.env) {
  const result = { Accept: "application/json" };
  const token = String(env.COMIC30_ASSET_WORKER_TOKEN || "").trim();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function request(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Asset worker returned HTTP ${response.status}.`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) {
    return {
      configured: false,
      available: false,
      mode: "unconfigured",
      endpoint: null,
      reason: "COMIC30_ASSET_GENERATOR_URL is not configured."
    };
  }
  try {
    const health = await request(`${endpoint}/health`, { headers: headers(env) }, Number(env.COMIC30_ASSET_HEALTH_TIMEOUT_MS || 3000));
    return {
      configured: true,
      available: health.ready === true,
      mode: "remote",
      endpoint,
      provider: health.provider || null,
      version: health.version || null,
      capabilities: health.capabilities || {},
      reason: health.ready === true ? null : health.reason || "The source-asset worker is reachable but not ready."
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      mode: "unreachable",
      endpoint,
      reason: `Source-asset health check failed: ${error.message}`
    };
  }
}

async function submit(spec, options = {}, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_ASSET_GENERATOR_URL is not configured.");
  return request(`${endpoint}/v1/jobs`, {
    method: "POST",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({ spec, options })
  }, Number(env.COMIC30_ASSET_SUBMIT_TIMEOUT_MS || 15000));
}

async function getJob(jobId, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_ASSET_GENERATOR_URL is not configured.");
  return request(`${endpoint}/v1/jobs/${encodeURIComponent(jobId)}`, { headers: headers(env) }, Number(env.COMIC30_ASSET_STATUS_TIMEOUT_MS || 8000));
}

function validateCompletedJob(job, requirements = []) {
  const errors = [];
  const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
  if (job?.status !== "completed") errors.push(`Asset job is ${job?.status || "missing"}, not completed.`);
  for (const requirement of requirements.filter((item) => item.required !== false)) {
    const output = outputs.find((item) => item.assetId === requirement.id);
    if (!output) {
      errors.push(`Required asset ${requirement.id} (${requirement.name}) has no worker output.`);
      continue;
    }
    if (!output.artifact?.url || !output.artifact?.sha256 || !output.artifact?.bytes) errors.push(`${requirement.name} has incomplete artifact evidence.`);
    if (output.validation?.ok !== true) errors.push(`${requirement.name} did not pass structural GLB validation.`);
  }
  return { ok: errors.length === 0, errors, outputCount: outputs.length };
}

function resolveArtifactUrl(value, env = process.env) {
  const endpoint = baseUrl(env);
  if (!endpoint) throw new Error("COMIC30_ASSET_GENERATOR_URL is not configured.");
  return new URL(String(value || ""), `${endpoint}/`).toString();
}

async function materializeArtifactEntries(job, targetDir, env = process.env) {
  const validation = validateCompletedJob(job, job?.requirements || []);
  if (!validation.ok) throw new Error(validation.errors.join(" "));
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = [];
  for (const output of job.outputs || []) {
    const url = resolveArtifactUrl(output.artifact.url, env);
    const response = await fetch(url, { headers: headers(env) });
    if (!response.ok) throw new Error(`Could not download ${output.name}: HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (digest !== output.artifact.sha256) throw new Error(`${output.name} failed checksum verification after download.`);
    if (buffer.length !== Number(output.artifact.bytes)) throw new Error(`${output.name} byte length does not match the worker evidence.`);
    const structural = inspectGlbBuffer(buffer);
    if (!structural.ok) throw new Error(`${output.name} failed portal-side GLB validation: ${structural.errors.join(" ")}`);
    const filename = String(output.artifact.filename || `${output.assetId}.glb`).replace(/[^A-Za-z0-9._-]/g, "_");
    const absolute = path.join(targetDir, filename);
    await fsp.writeFile(absolute, buffer);
    entries.push({ assetId: output.assetId, name: output.name, file: absolute, output });
  }
  return entries;
}

async function materializeArtifacts(job, targetDir, env = process.env) {
  return (await materializeArtifactEntries(job, targetDir, env)).map((entry) => entry.file);
}

module.exports = { probe, submit, getJob, validateCompletedJob, resolveArtifactUrl, materializeArtifactEntries, materializeArtifacts };
