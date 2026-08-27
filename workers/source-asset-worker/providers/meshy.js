"use strict";

const { requestJson, sleep, artifactUrl } = require("./http");

function createMeshyProvider(env = process.env) {
  const apiKey = String(env.MESHY_API_KEY || "").trim();
  const root = String(env.MESHY_API_ROOT || "https://api.meshy.ai").replace(/\/+$/, "");
  const requestTimeout = Number(env.COMIC30_PROVIDER_REQUEST_TIMEOUT_MS || 60000);
  const pollMs = Math.max(2000, Number(env.COMIC30_ASSET_POLL_MS || 5000));
  const maxWaitMs = Math.max(60000, Number(env.COMIC30_ASSET_MAX_WAIT_MS || 30 * 60 * 1000));
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };

  async function request(endpoint, options = {}) {
    try {
      return await requestJson(`${root}${endpoint}`, { ...options, headers: { ...headers, ...(options.headers || {}) } }, requestTimeout);
    } catch (error) {
      throw new Error(`Meshy: ${error.message}`);
    }
  }

  async function poll(taskId, stage, endpoint) {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const task = await request(`${endpoint}/${encodeURIComponent(taskId)}`, { method: "GET" });
      if (String(task.status).toUpperCase() === "SUCCEEDED") return task;
      if (["FAILED", "CANCELED", "EXPIRED"].includes(String(task.status).toUpperCase())) {
        throw new Error(`${stage} task ${taskId} failed: ${task.task_error?.message || task.error || "provider failure"}`);
      }
      await sleep(pollMs);
    }
    throw new Error(`${stage} task ${taskId} exceeded the worker deadline.`);
  }

  return {
    id: "meshy",
    label: "Meshy fallback",
    configured: Boolean(apiKey),
    async probe() {
      return {
        ready: Boolean(apiKey),
        reason: apiKey ? null : "MESHY_API_KEY is not configured on the source-asset worker.",
        capabilities: { imageReference: true, promptOnly: true, pbr: true, formats: ["glb"] }
      };
    },
    async generate({ requirement, prompt, imageUrl }) {
      if (!apiKey) throw new Error("Meshy fallback is not configured.");
      if (imageUrl) {
        const created = await request("/openapi/v1/image-to-3d", {
          method: "POST",
          body: JSON.stringify({
            image_url: imageUrl,
            ai_model: env.MESHY_MODEL || "latest",
            model_type: "standard",
            should_texture: true,
            enable_pbr: true,
            should_remesh: false,
            pose_mode: requirement.rigProfile === "humanoid" ? "a-pose" : "",
            target_formats: ["glb"]
          })
        });
        const taskId = created.result || created.id;
        if (!taskId) throw new Error("Meshy did not return an image-to-3D task ID.");
        const completed = await poll(taskId, "image-to-3D", "/openapi/v1/image-to-3d");
        const modelUrl = artifactUrl(completed);
        if (!modelUrl) throw new Error("Meshy image-to-3D did not provide a GLB URL.");
        return { provider: "meshy", providerTasks: { imageTo3d: taskId }, modelUrl, thumbnailUrl: completed.thumbnail_url || null, input: { mode: "image-reference" } };
      }

      const preview = await request("/openapi/v2/text-to-3d", {
        method: "POST",
        body: JSON.stringify({
          mode: "preview",
          prompt,
          ai_model: env.MESHY_MODEL || "latest",
          model_type: "standard",
          topology: "quad",
          target_polycount: Number(env.MESHY_TARGET_POLYCOUNT || 100000),
          pose_mode: requirement.rigProfile === "humanoid" ? "a-pose" : "",
          target_formats: ["glb"]
        })
      });
      const previewId = preview.result || preview.id;
      if (!previewId) throw new Error("Meshy did not return a preview task ID.");
      await poll(previewId, "preview", "/openapi/v2/text-to-3d");
      const refine = await request("/openapi/v2/text-to-3d", {
        method: "POST",
        body: JSON.stringify({ mode: "refine", preview_task_id: previewId, enable_pbr: true, texture_resolution: env.MESHY_TEXTURE_RESOLUTION || "4k", target_formats: ["glb"] })
      });
      const refineId = refine.result || refine.id;
      if (!refineId) throw new Error("Meshy did not return a refine task ID.");
      const completed = await poll(refineId, "refine", "/openapi/v2/text-to-3d");
      const modelUrl = artifactUrl(completed);
      if (!modelUrl) throw new Error("Meshy refine did not provide a GLB URL.");
      return { provider: "meshy", providerTasks: { preview: previewId, refine: refineId }, modelUrl, thumbnailUrl: completed.thumbnail_url || null, input: { mode: "prompt" } };
    }
  };
}

module.exports = { createMeshyProvider };
