"use strict";

function endpoint(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function probe({ label, url, token, timeoutMs = 3000 }) {
  const baseUrl = endpoint(url);
  if (!baseUrl) return { configured: false, available: false, mode: "unconfigured", endpoint: null, reason: `${label} URL is not configured.` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}/health`, { headers, signal: controller.signal });
    const health = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(health.error || `HTTP ${response.status}`);
    return {
      configured: true,
      available: health.ready === true,
      mode: "remote",
      endpoint: baseUrl,
      provider: health.provider || null,
      version: health.version || null,
      capabilities: health.capabilities || {},
      reason: health.ready === true ? null : health.reason || `${label} is reachable but not ready.`
    };
  } catch (error) {
    return { configured: true, available: false, mode: "unreachable", endpoint: baseUrl, reason: `${label} health check failed: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probe };
