"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const animationWorker = require("../engine/animation-worker-client");
const { inspectAnimationGlbBuffer } = require("../engine/animation-inspector");
const { createUnrealRigHandoff } = require("../engine/unreal-rig-handoff");
const { createUnrealAnimationHandoff, validateUnrealAnimationHandoff } = require("../engine/unreal-animation-handoff");
const { validateRetargetProfile, normalizeProfiles } = require("../workers/animation-worker/retarget-profiles");
const { createMotionGptProvider } = require("../workers/animation-worker/providers/motiongpt");
const { riggedHumanoidGlb } = require("./rig-worker-test");

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function reply(res, status, payload, contentType = "application/json") {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": buffer.length });
  res.end(buffer);
}

async function main() {
  const clipBuffer = riggedHumanoidGlb();
  const validation = inspectAnimationGlbBuffer(clipBuffer, { profile: "humanoid", expectedClip: "DeformationQA" });
  assert.equal(validation.ok, true, validation.errors.join(" "));
  assert.equal(validation.animationQa.passed, true);
  assert.equal(validation.deformationQa.passed, true);
  assert.ok(validation.clips[0].keyedMappedBoneCount > 0);

  const rigHandoff = createUnrealRigHandoff({
    assetId: "asset-hero",
    name: "Hero Character",
    profile: "humanoid",
    mapping: validation.mapping,
    deformationQa: validation.deformationQa
  });
  assert.equal(validateRetargetProfile("humanoid", rigHandoff).ok, true);
  assert.equal(validateRetargetProfile("vehicle", rigHandoff).ok, false, "A humanoid handoff must not pass a vehicle retarget contract.");
  assert.deepEqual(normalizeProfiles({ profiles: { humanoid: true, creature: false, vehicle: true } }), ["humanoid", "vehicle"]);

  const requirement = { id: "locomotion", name: "DeformationQA", prompt: "A grounded hero locomotion cycle.", durationSeconds: 1, required: true };
  const clipArtifact = { filename: "asset-hero-locomotion.glb", url: "/clip.glb", sha256: sha256(clipBuffer), bytes: clipBuffer.length, format: "glb" };
  const clips = [{ ...requirement, provider: "contract-test", artifact: clipArtifact, validation }];
  const handoff = createUnrealAnimationHandoff({ assetId: "asset-hero", name: "Hero Character", profile: "humanoid", rigHandoff, clips });
  assert.equal(validateUnrealAnimationHandoff(handoff).ok, true);
  const handoffBuffer = Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`);
  const handoffArtifact = { filename: "asset-hero-unreal-animation-handoff.json", url: "/handoff.json", sha256: sha256(handoffBuffer), bytes: handoffBuffer.length, format: "json" };
  const completedJob = {
    id: "anim-test",
    status: "completed",
    requirements: [requirement],
    outputs: [{ assetId: "asset-hero", name: "Hero Character", profile: "humanoid", provider: "contract-test", clips, handoffArtifact }]
  };

  let endpoint;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") return reply(res, 200, { service: "comic30-animation-worker", ready: true, provider: "contract-test", version: "test", capabilities: { profiles: ["humanoid"] } });
    if (req.url === "/v1/jobs" && req.method === "POST") {
      for await (const _chunk of req) { /* drain the request */ }
      return reply(res, 202, { job: completedJob });
    }
    if (req.url === "/v1/jobs/anim-test") return reply(res, 200, { job: completedJob });
    if (req.url === "/clip.glb" || req.url === "/motion.glb") return reply(res, 200, clipBuffer, "model/gltf-binary");
    if (req.url === "/handoff.json") return reply(res, 200, handoffBuffer);
    if (req.url === "/motion/health") return reply(res, 200, { ready: true, version: "motion-test", capabilities: { profiles: ["humanoid"] } });
    if (req.url === "/motion/v1/generations" && req.method === "POST") {
      for await (const _chunk of req) { /* drain multipart input */ }
      return reply(res, 200, { job: { id: "motion-1", status: "completed", artifact: { url: `${endpoint}/motion.glb` } } });
    }
    return reply(res, 404, { error: "not found" });
  });
  await listen(server);
  endpoint = `http://127.0.0.1:${server.address().port}`;

  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "comic30-animation-test-"));
  try {
    const env = { COMIC30_ANIMATION_WORKER_URL: endpoint };
    const health = await animationWorker.probe(env);
    assert.equal(health.available, true);
    const fetched = await animationWorker.getJob("anim-test", env);
    assert.equal(fetched.job.status, "completed");
    const entries = await animationWorker.materializeArtifactEntries(completedJob, target, env);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].clips.length, 1);
    assert.equal(entries[0].handoff.assetId, "asset-hero");

    const forged = JSON.parse(JSON.stringify(completedJob));
    forged.outputs[0].clips[0].artifact.sha256 = "0".repeat(64);
    await assert.rejects(animationWorker.materializeArtifactEntries(forged, path.join(target, "forged"), env), /checksum or byte-length/);

    const motionGpt = createMotionGptProvider({ COMIC30_MOTIONGPT_URL: `${endpoint}/motion`, COMIC30_MOTIONGPT_POLL_MS: "1", COMIC30_MOTIONGPT_MAX_WAIT_MS: "30000" });
    const motionHealth = await motionGpt.probe();
    assert.equal(motionHealth.ready, true);
    assert.deepEqual(normalizeProfiles(motionHealth.capabilities, ["humanoid"]), ["humanoid"]);
    const generated = await motionGpt.animate({
      source: { assetId: "asset-hero", profile: "humanoid" },
      sourceBuffer: clipBuffer,
      rigHandoff,
      clip: requirement,
      workDir: path.join(target, "motion")
    });
    assert.equal(generated.provider, "motiongpt-self-hosted");
    assert.equal(inspectAnimationGlbBuffer(generated.buffer, { profile: "humanoid" }).ok, true);
    console.log(`Animation worker contract verified: ${validation.clips.length} clip, ${validation.animationQa.totalChannels} channels, retarget/deformation QA passed.`);
  } finally {
    await close(server);
    await fsp.rm(target, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
