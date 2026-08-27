"use strict";

function timeout(value, minimum = 1000) {
  return Math.max(minimum, Number(value || 0));
}

async function requestJson(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout(timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.message || payload.error || payload.detail || `HTTP ${response.status}`;
      throw new Error(String(detail));
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function artifactUrl(payload) {
  const candidate = payload?.artifact?.url || payload?.artifact_url || payload?.model_url || payload?.glb_url
    || payload?.outputs?.glb || payload?.output?.glb || payload?.model_urls?.glb;
  return String(candidate || "").trim() || null;
}

module.exports = { requestJson, sleep, artifactUrl };
