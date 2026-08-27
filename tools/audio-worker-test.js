"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const audioWorker = require("../engine/audio-worker-client");
const { inspectWavBuffer } = require("../engine/audio-inspector");
const { createUnrealAudioHandoff, validateUnrealAudioHandoff } = require("../engine/unreal-audio-handoff");
const { createAudioCraftProvider } = require("../workers/audio-worker/providers/audiocraft");

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function reply(res, status, payload, contentType = "application/json") {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": buffer.length });
  res.end(buffer);
}

function pcm16Wav({ seconds = 1, sampleRate = 48000, channels = 2, frequency = 220, amplitude = 0.25 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * amplitude * 32767);
    for (let channel = 0; channel < channels; channel += 1) buffer.writeInt16LE(sample, 44 + frame * blockAlign + channel * bytesPerSample);
  }
  return buffer;
}

async function main() {
  const wav = pcm16Wav();
  const inspected = inspectWavBuffer(wav, { expectedDurationSeconds: 1, loop: true });
  assert.equal(inspected.ok, true, inspected.errors.join(" "));
  assert.equal(inspected.audioQa.passed, true);
  assert.equal(inspected.metrics.sampleRate, 48000);
  assert.equal(inspected.metrics.channels, 2);
  assert.equal(inspectWavBuffer(Buffer.alloc(44)).ok, false, "A silent/invalid WAV must fail closed.");

  const requirement = { id: "music-main", name: "Main Theme", kind: "music", prompt: "Energetic racing theme", durationSeconds: 1, loop: true, required: true };
  const artifact = { filename: "music-main.wav", url: "/music.wav", sha256: sha256(wav), bytes: wav.length, format: "wav" };
  const clip = {
    ...requirement,
    provider: "audiocraft-self-hosted",
    provenance: { model: "musicgen-medium", modelVersion: "contract-test" },
    license: { commercialUseAllowed: true, source: "owned-checkpoint" },
    artifact,
    validation: inspected
  };
  const handoff = createUnrealAudioHandoff({ productionRunId: "production-audio-test", clips: [clip] });
  assert.equal(validateUnrealAudioHandoff(handoff).ok, true);
  const handoffBuffer = Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`);
  const handoffArtifact = { filename: "unreal-audio-handoff.json", url: "/handoff.json", sha256: sha256(handoffBuffer), bytes: handoffBuffer.length, format: "json" };
  const completedJob = { id: "audio-test", status: "completed", requirements: [requirement], outputs: [clip], handoffArtifact };

  let endpoint;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") return reply(res, 200, { service: "comic30-audio-worker", ready: true, provider: "contract-test", version: "test", capabilities: { kinds: ["music", "ambience", "ui", "sfx"] } });
    if (req.url === "/v1/jobs/audio-test") return reply(res, 200, { job: completedJob });
    if (req.url === "/music.wav" || req.url === "/provider/music.wav") return reply(res, 200, wav, "audio/wav");
    if (req.url === "/handoff.json") return reply(res, 200, handoffBuffer);
    if (req.url === "/provider/health") return reply(res, 200, { ready: true, version: "audiocraft-test", capabilities: { kinds: ["music", "ambience", "ui", "sfx"] }, license: { commercialUseAllowed: true } });
    if (req.url === "/provider/v1/generations" && req.method === "POST") {
      for await (const _chunk of req) { /* drain JSON input */ }
      return reply(res, 200, { job: { id: "audio-provider-test", status: "completed", artifact: { url: `${endpoint}/provider/music.wav` }, provenance: { model: "musicgen-medium" }, license: { commercialUseAllowed: true, source: "owned-checkpoint" } } });
    }
    return reply(res, 404, { error: "not found" });
  });
  await listen(server);
  endpoint = `http://127.0.0.1:${server.address().port}`;

  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "comic30-audio-test-"));
  try {
    const env = { COMIC30_AUDIO_WORKER_URL: endpoint };
    const health = await audioWorker.probe(env);
    assert.equal(health.available, true);
    const fetched = await audioWorker.getJob("audio-test", env);
    assert.equal(fetched.job.status, "completed");
    const materialized = await audioWorker.materializeArtifactEntries(completedJob, target, env);
    assert.equal(materialized.clips.length, 1);
    assert.equal(materialized.handoff.productionRunId, "production-audio-test");

    const forged = JSON.parse(JSON.stringify(completedJob));
    forged.outputs[0].artifact.sha256 = "0".repeat(64);
    await assert.rejects(audioWorker.materializeArtifactEntries(forged, path.join(target, "forged"), env), /checksum or byte-length/);

    const provider = createAudioCraftProvider({ COMIC30_AUDIOCRAFT_URL: `${endpoint}/provider`, COMIC30_AUDIOCRAFT_POLL_MS: "1", COMIC30_AUDIOCRAFT_MAX_WAIT_MS: "30000" });
    const providerHealth = await provider.probe();
    assert.equal(providerHealth.ready, true);
    const generated = await provider.generate(requirement, { productionRunId: "production-audio-test" });
    assert.equal(generated.provider, "audiocraft-self-hosted");
    assert.equal(inspectWavBuffer(generated.buffer, { expectedDurationSeconds: 1, loop: true }).ok, true);
    console.log(`Audio worker contract verified: ${inspected.metrics.durationSeconds}s WAV, ${inspected.metrics.sampleRate} Hz, checksum/licensing/acoustic QA passed.`);
  } finally {
    await close(server);
    await fsp.rm(target, { recursive: true, force: true });
  }
}

module.exports = { pcm16Wav };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
