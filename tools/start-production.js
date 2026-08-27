"use strict";

require("../engine/load-local-env")();

const path = require("path");
const { spawn } = require("child_process");
const doctor = require("./production-doctor");

const ROOT = path.resolve(__dirname, "..");
const SERVICES = [
  { id: "source", script: "workers/source-asset-worker/server.js", url: process.env.COMIC30_ASSET_GENERATOR_URL },
  { id: "rig", script: "workers/rig-worker/server.js", url: process.env.COMIC30_RIG_WORKER_URL },
  { id: "animation", script: "workers/animation-worker/server.js", url: process.env.COMIC30_ANIMATION_WORKER_URL },
  { id: "audio", script: "workers/audio-worker/server.js", url: process.env.COMIC30_AUDIO_WORKER_URL },
  { id: "portal", script: "server.js", url: `http://127.0.0.1:${process.env.PORT || 5173}` }
];

const children = new Map();
let closing = false;

async function reachable(baseUrl) {
  if (!baseUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const suffix = baseUrl.includes(`:${process.env.PORT || 5173}`) ? "/api/health" : "/health";
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}${suffix}`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function pipe(child, id, stream) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) if (line) console.log(`[${id}] ${line}`);
  });
}

function launch(service) {
  const child = spawn(process.execPath, [path.join(ROOT, service.script)], {
    cwd: ROOT,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.set(service.id, child);
  pipe(child, service.id, child.stdout);
  pipe(child, service.id, child.stderr);
  child.on("exit", (code, signal) => {
    children.delete(service.id);
    if (!closing) console.error(`[${service.id}] stopped unexpectedly (code=${code}, signal=${signal || "none"}).`);
  });
}

async function waitFor(service, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(service.url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function main() {
  console.log("Starting Comic30 control plane...");
  for (const service of SERVICES) {
    if (await reachable(service.url)) console.log(`[${service.id}] already running at ${service.url}`);
    else launch(service);
  }
  const states = await Promise.all(SERVICES.map(async (service) => ({ id: service.id, ready: await waitFor(service) })));
  const failed = states.filter((item) => !item.ready);
  if (failed.length) throw new Error(`Services did not start: ${failed.map((item) => item.id).join(", ")}`);
  doctor.print(await doctor.inspect());
  console.log(`Comic30 portal: http://127.0.0.1:${process.env.PORT || 5173}/?portal=signin&comic30=production-control-plane`);
  if (!children.size) console.log("All services were already running; this process can exit safely.");
}

function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Stopping Comic30 services (${signal})...`);
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  console.error(error.stack || error.message);
  shutdown("startup failure");
  process.exitCode = 1;
});
