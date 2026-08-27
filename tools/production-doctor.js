"use strict";

require("../engine/load-local-env")();

const fs = require("fs");
const { spawnSync } = require("child_process");

const WORKERS = [
  { id: "source-assets", url: "COMIC30_ASSET_GENERATOR_URL", token: "COMIC30_ASSET_WORKER_TOKEN" },
  { id: "rigging", url: "COMIC30_RIG_WORKER_URL", token: "COMIC30_RIG_WORKER_TOKEN" },
  { id: "animation", url: "COMIC30_ANIMATION_WORKER_URL", token: "COMIC30_ANIMATION_WORKER_TOKEN" },
  { id: "audio", url: "COMIC30_AUDIO_WORKER_URL", token: "COMIC30_AUDIO_WORKER_TOKEN" }
];

function command(executable, args, timeout = 6000) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim().slice(0, 4000),
    error: result.error ? result.error.message : null
  };
}

async function health(item) {
  const endpoint = String(process.env[item.url] || "").replace(/\/+$/, "");
  if (!endpoint) return { id: item.id, endpoint: null, gateway: false, generation: false, reason: `${item.url} is unset.` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const headers = { Accept: "application/json" };
    const token = String(process.env[item.token] || "");
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${endpoint}/health`, { headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    const generation = item.id === "rigging" ? payload.generationReady === true : payload.ready === true;
    return {
      id: item.id,
      endpoint,
      gateway: response.ok,
      generation,
      service: payload.service || null,
      provider: payload.provider || null,
      providers: payload.providers || null,
      capabilities: payload.capabilities || null,
      reason: generation ? null : payload.reason || "The gateway is running without a ready generation provider."
    };
  } catch (error) {
    return { id: item.id, endpoint, gateway: false, generation: false, reason: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function fileCapability(name, value) {
  const resolved = String(value || "").trim();
  return { name, configured: Boolean(resolved), path: resolved || null, available: Boolean(resolved && fs.existsSync(resolved)) };
}

async function inspect() {
  const workers = await Promise.all(WORKERS.map(health));
  const gpu = command("nvidia-smi", ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"]);
  const docker = command("docker", ["version", "--format", "{{json .Server.Version}}"]);
  const engines = [
    fileCapability("Unreal Engine", process.env.COMIC30_UNREAL_ROOT),
    fileCapability("Python", process.env.PYTHON_BIN),
    fileCapability("Blender", process.env.COMIC30_BLENDER_EXECUTABLE),
    fileCapability("UniRig", process.env.COMIC30_UNIRIG_ROOT)
  ];
  const result = {
    checkedAt: new Date().toISOString(),
    portal: { endpoint: `http://127.0.0.1:${process.env.PORT || 5173}` },
    gpu: { commandAvailable: gpu.ok, description: gpu.output || gpu.error },
    docker: { engineAccessible: docker.ok, description: docker.output || docker.error },
    engines,
    workers,
    gatewayStackReady: workers.every((item) => item.gateway),
    generationStackReady: workers.every((item) => item.generation),
    unrealReady: engines.find((item) => item.name === "Unreal Engine").available
  };
  result.productionReady = result.generationStackReady && result.unrealReady;
  return result;
}

function print(result) {
  console.log("\nComic30 production doctor");
  console.log("=========================");
  for (const item of result.workers) {
    console.log(`${item.id.padEnd(14)} gateway=${String(item.gateway).padEnd(5)} generation=${String(item.generation).padEnd(5)} ${item.reason || item.provider || "ready"}`);
  }
  for (const item of result.engines) console.log(`${item.name.padEnd(14)} available=${String(item.available).padEnd(5)} ${item.path || "not configured"}`);
  console.log(`GPU            ${result.gpu.description || "not detected"}`);
  console.log(`Docker engine  accessible=${result.docker.engineAccessible} ${result.docker.description || ""}`);
  console.log(`\nControl gateways ready: ${result.gatewayStackReady}`);
  console.log(`GPU generation ready:   ${result.generationStackReady}`);
  console.log(`Production ready:       ${result.productionReady}\n`);
}

if (require.main === module) {
  inspect().then((result) => {
    if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else print(result);
    if (process.argv.includes("--strict") && !result.productionReady) process.exitCode = 2;
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { inspect, print };
