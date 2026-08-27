"use strict";

const { requestJson, sleep, artifactUrl } = require("./http");

function root(env) {
  return String(env.COMIC30_TRELLIS2_URL || "").trim().replace(/\/+$/, "");
}

function headers(env) {
  const result = { Accept: "application/json", "Content-Type": "application/json" };
  const token = String(env.COMIC30_TRELLIS2_TOKEN || "").trim();
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

function statusOf(payload) {
  return String(payload?.job?.status || payload?.status || "").trim().toLowerCase();
}

function jobIdOf(payload) {
  return String(payload?.job?.id || payload?.job_id || payload?.id || "").trim() || null;
}

function createTrellis2Provider(env = process.env) {
  const endpoint = root(env);
  const requestTimeout = Number(env.COMIC30_PROVIDER_REQUEST_TIMEOUT_MS || 60000);
  const pollMs = Math.max(1000, Number(env.COMIC30_ASSET_POLL_MS || 5000));
  const maxWaitMs = Math.max(60000, Number(env.COMIC30_ASSET_MAX_WAIT_MS || 30 * 60 * 1000));

  return {
    id: "trellis2",
    label: "Self-hosted TRELLIS.2",
    configured: Boolean(endpoint),
    async probe() {
      if (!endpoint) return { ready: false, reason: "COMIC30_TRELLIS2_URL is not configured." };
      try {
        const health = await requestJson(`${endpoint}/health`, { headers: headers(env) }, Math.min(requestTimeout, 5000));
        const capabilities = health.capabilities || {};
        return {
          ready: health.ready === true,
          reason: health.ready === true ? null : health.reason || "The TRELLIS.2 service is reachable but not ready.",
          capabilities: {
            imageReference: capabilities.imageReference !== false,
            promptOnly: capabilities.promptOnly === true,
            pbr: capabilities.pbr !== false,
            formats: capabilities.formats || ["glb"]
          },
          version: health.version || null
        };
      } catch (error) {
        return { ready: false, reason: `TRELLIS.2 health check failed: ${error.message}` };
      }
    },
    async generate({ job, requirement, prompt, imageUrl }) {
      if (!endpoint) throw new Error("TRELLIS.2 is not configured.");
      const health = await this.probe();
      if (!health.ready) throw new Error(health.reason);
      if (!imageUrl && health.capabilities?.promptOnly !== true) {
        throw new Error("TRELLIS.2 is image-to-3D. Supply a reference image or configure its service with a prompt-to-image front end that advertises promptOnly=true.");
      }
      const payload = await requestJson(`${endpoint}/v1/jobs`, {
        method: "POST",
        headers: headers(env),
        body: JSON.stringify({
          requestId: `${job.id}:${requirement.id}`,
          prompt,
          image: imageUrl || null,
          output: { format: "glb", pbr: true, textureResolution: env.COMIC30_TRELLIS2_TEXTURE_RESOLUTION || "2048" },
          asset: { id: requirement.id, name: requirement.name, rigProfile: requirement.rigProfile || null }
        })
      }, requestTimeout);

      let current = payload.job || payload;
      const taskId = jobIdOf(payload);
      const started = Date.now();
      while (!artifactUrl(current)) {
        const status = statusOf(current);
        if (["failed", "canceled", "cancelled", "expired"].includes(status)) {
          throw new Error(current.error || current.message || `TRELLIS.2 job ${taskId || "unknown"} failed.`);
        }
        if (!taskId) throw new Error("TRELLIS.2 did not return an artifact or persistent job ID.");
        if (Date.now() - started >= maxWaitMs) throw new Error(`TRELLIS.2 job ${taskId} exceeded the worker deadline.`);
        await sleep(pollMs);
        const polled = await requestJson(`${endpoint}/v1/jobs/${encodeURIComponent(taskId)}`, { headers: headers(env) }, requestTimeout);
        current = polled.job || polled;
      }
      return {
        provider: "trellis2",
        providerTasks: { generation: taskId },
        modelUrl: artifactUrl(current),
        thumbnailUrl: current.thumbnail_url || current.thumbnailUrl || null,
        input: { mode: imageUrl ? "image-reference" : "prompt-with-upstream-image-generation" }
      };
    }
  };
}

module.exports = { createTrellis2Provider };
