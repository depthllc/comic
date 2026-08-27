"use strict";

const fsp = require("fs/promises");
const path = require("path");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function createMotionGptProvider(env = process.env) {
  const root = String(env.COMIC30_MOTIONGPT_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.COMIC30_MOTIONGPT_TOKEN || "").trim();
  const pollMs = Math.max(1000, Number(env.COMIC30_MOTIONGPT_POLL_MS || 3000));
  const maxWaitMs = Math.max(30000, Number(env.COMIC30_MOTIONGPT_MAX_WAIT_MS || 20 * 60 * 1000));
  const timeoutMs = Math.max(5000, Number(env.COMIC30_MOTIONGPT_REQUEST_TIMEOUT_MS || 60000));

  async function request(endpoint, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: "application/json", ...(options.headers || {}) };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${root}${endpoint}`, { ...options, headers, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.message || `MotionGPT worker returned HTTP ${response.status}.`);
      return payload;
    } finally { clearTimeout(timer); }
  }

  async function download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs * 5);
    try {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(new URL(url, `${root}/`), { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`MotionGPT artifact returned HTTP ${response.status}.`);
      return Buffer.from(await response.arrayBuffer());
    } finally { clearTimeout(timer); }
  }

  async function probe() {
    if (!root) return { ready: false, configured: false, reason: "COMIC30_MOTIONGPT_URL is not configured." };
    try {
      const health = await request("/health", { method: "GET" });
      return { ready: health.ready === true, configured: true, endpoint: root, version: health.version || null, capabilities: health.capabilities || {}, reason: health.ready === true ? null : health.reason || "MotionGPT is reachable but not ready." };
    } catch (error) {
      return { ready: false, configured: true, endpoint: root, reason: `MotionGPT health check failed: ${error.message}` };
    }
  }

  async function animate({ source, sourceBuffer, rigHandoff, clip, workDir }) {
    if (!root) throw new Error("COMIC30_MOTIONGPT_URL is not configured.");
    await fsp.mkdir(workDir, { recursive: true });
    const form = new FormData();
    form.append("source", new Blob([sourceBuffer], { type: "model/gltf-binary" }), `${source.assetId}-rigged.glb`);
    form.append("assetId", source.assetId);
    form.append("profile", source.profile);
    form.append("prompt", clip.prompt);
    form.append("clipId", clip.id);
    form.append("clipName", clip.name);
    form.append("durationSeconds", String(clip.durationSeconds || 2));
    form.append("rigHandoff", JSON.stringify(rigHandoff));
    const submitted = await request("/v1/generations", { method: "POST", body: form });
    let task = submitted.job || submitted;
    const taskId = task.id || task.jobId;
    if (!taskId) throw new Error("MotionGPT worker did not return a generation ID.");
    const started = Date.now();
    while (!["completed", "succeeded"].includes(String(task.status || "").toLowerCase())) {
      if (["failed", "canceled", "cancelled", "expired"].includes(String(task.status || "").toLowerCase())) {
        throw new Error(`MotionGPT task ${taskId} failed: ${task.error || "provider failure"}`);
      }
      if (Date.now() - started > maxWaitMs) throw new Error(`MotionGPT task ${taskId} exceeded the worker deadline.`);
      await sleep(pollMs);
      const status = await request(`/v1/generations/${encodeURIComponent(taskId)}`, { method: "GET" });
      task = status.job || status;
    }
    const artifactUrl = task.artifact?.url || task.output?.url || task.result?.url;
    if (!artifactUrl) throw new Error(`MotionGPT task ${taskId} completed without an animated GLB artifact.`);
    const buffer = await download(artifactUrl);
    await fsp.writeFile(path.join(workDir, `${clip.id}.glb`), buffer);
    return { provider: "motiongpt-self-hosted", buffer, providerTasks: { motion: taskId } };
  }

  return { id: "motiongpt-self-hosted", probe, animate };
}

module.exports = { createMotionGptProvider };
