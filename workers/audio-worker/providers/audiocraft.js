"use strict";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function createAudioCraftProvider(env = process.env) {
  const root = String(env.COMIC30_AUDIOCRAFT_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.COMIC30_AUDIOCRAFT_TOKEN || "").trim();
  const pollMs = Math.max(500, Number(env.COMIC30_AUDIOCRAFT_POLL_MS || 3000));
  const maxWaitMs = Math.max(30000, Number(env.COMIC30_AUDIOCRAFT_MAX_WAIT_MS || 20 * 60 * 1000));
  const timeoutMs = Math.max(5000, Number(env.COMIC30_AUDIOCRAFT_REQUEST_TIMEOUT_MS || 60000));

  async function request(endpoint, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: "application/json", ...(options.headers || {}) };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${root}${endpoint}`, { ...options, headers, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.message || `AudioCraft service returned HTTP ${response.status}.`);
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
      if (!response.ok) throw new Error(`AudioCraft artifact returned HTTP ${response.status}.`);
      return Buffer.from(await response.arrayBuffer());
    } finally { clearTimeout(timer); }
  }

  async function probe() {
    if (!root) return { ready: false, configured: false, reason: "COMIC30_AUDIOCRAFT_URL is not configured." };
    try {
      const health = await request("/health", { method: "GET" });
      const capabilities = health.capabilities || {};
      const kinds = Array.isArray(capabilities.kinds) ? capabilities.kinds : [];
      const license = health.license || capabilities.license || {};
      const ready = health.ready === true && ["music", "ambience", "ui", "sfx"].every((kind) => kinds.includes(kind)) && license.commercialUseAllowed === true;
      return { ready, configured: true, endpoint: root, version: health.version || null, capabilities, license, reason: ready ? null : health.reason || "The self-hosted audio provider must advertise all Comic30 clip kinds and commercial-use permission." };
    } catch (error) {
      return { ready: false, configured: true, endpoint: root, reason: `AudioCraft health check failed: ${error.message}` };
    }
  }

  async function generate(requirement, context = {}) {
    if (!root) throw new Error("COMIC30_AUDIOCRAFT_URL is not configured.");
    const submitted = await request("/v1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: requirement.prompt,
        kind: requirement.kind,
        durationSeconds: requirement.durationSeconds,
        loop: requirement.loop === true,
        sampleRate: 48000,
        channels: requirement.kind === "music" || requirement.kind === "ambience" ? 2 : 1,
        context
      })
    });
    let task = submitted.job || submitted;
    const taskId = task.id || task.jobId;
    if (!taskId) throw new Error("Audio provider did not return a generation ID.");
    const started = Date.now();
    while (!["completed", "succeeded"].includes(String(task.status || "").toLowerCase())) {
      if (["failed", "canceled", "cancelled", "expired"].includes(String(task.status || "").toLowerCase())) throw new Error(`Audio generation ${taskId} failed: ${task.error || "provider failure"}`);
      if (Date.now() - started > maxWaitMs) throw new Error(`Audio generation ${taskId} exceeded the worker deadline.`);
      await sleep(pollMs);
      const response = await request(`/v1/generations/${encodeURIComponent(taskId)}`, { method: "GET" });
      task = response.job || response;
    }
    const artifactUrl = task.artifact?.url || task.output?.url || task.result?.url;
    if (!artifactUrl) throw new Error(`Audio generation ${taskId} completed without a WAV artifact.`);
    const provenance = task.provenance || {};
    const license = task.license || {};
    if (!provenance.model || license.commercialUseAllowed !== true) throw new Error(`Audio generation ${taskId} omitted required model provenance or commercial-use licensing.`);
    return { provider: "audiocraft-self-hosted", providerTaskId: taskId, buffer: await download(artifactUrl), provenance, license };
  }

  return { id: "audiocraft-self-hosted", probe, generate };
}

module.exports = { createAudioCraftProvider };
