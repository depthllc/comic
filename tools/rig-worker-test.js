"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { inspectRiggedGlbBuffer, runSyntheticDeformationQa } = require("../engine/rig-inspector");
const { createUnrealRigHandoff } = require("../engine/unreal-rig-handoff");
const rigWorker = require("../engine/rig-worker-client");
const { createHumanoidStrategy } = require("../workers/rig-worker/strategies/humanoid");
const { createCreatureStrategy } = require("../workers/rig-worker/strategies/creature");

function riggedHumanoidGlb() {
  const chunks = [];
  let byteLength = 0;
  function add(buffer) {
    const padding = (4 - (byteLength % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      byteLength += padding;
    }
    const view = { buffer: 0, byteOffset: byteLength, byteLength: buffer.length };
    chunks.push(buffer);
    byteLength += buffer.length;
    return view;
  }
  function floats(values) {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
    return buffer;
  }
  function uint16(values) {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => buffer.writeUInt16LE(value, index * 2));
    return buffer;
  }

  const bufferViews = [];
  const positions = bufferViews.push(add(floats([0, 0, 0, 1, 0, 0, 0, 1, 0]))) - 1;
  const normals = bufferViews.push(add(floats([0, 0, 1, 0, 0, 1, 0, 0, 1]))) - 1;
  const uvs = bufferViews.push(add(floats([0, 0, 1, 0, 0, 1]))) - 1;
  const joints = bufferViews.push(add(uint16([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]))) - 1;
  const weights = bufferViews.push(add(floats([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))) - 1;
  const matrices = [];
  for (let index = 0; index < 13; index += 1) matrices.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const inverseBindMatrices = bufferViews.push(add(floats(matrices))) - 1;
  const times = bufferViews.push(add(floats([0, 1]))) - 1;
  const translations = bufferViews.push(add(floats([0, 0, 0, 0, 0.1, 0]))) - 1;
  const image = bufferViews.push(add(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) - 1;
  const binary = Buffer.concat(chunks);

  const accessors = [
    { bufferView: positions, componentType: 5126, count: 3, type: "VEC3" },
    { bufferView: normals, componentType: 5126, count: 3, type: "VEC3" },
    { bufferView: uvs, componentType: 5126, count: 3, type: "VEC2" },
    { bufferView: joints, componentType: 5123, count: 3, type: "VEC4" },
    { bufferView: weights, componentType: 5126, count: 3, type: "VEC4" },
    { bufferView: inverseBindMatrices, componentType: 5126, count: 13, type: "MAT4" },
    { bufferView: times, componentType: 5126, count: 2, type: "SCALAR" },
    { bufferView: translations, componentType: 5126, count: 2, type: "VEC3" }
  ];
  const nodes = [
    { name: "Hips", children: [1, 3, 5] },
    { name: "Spine", children: [2, 7, 9] },
    { name: "Head" },
    { name: "LeftUpperLeg", children: [4] },
    { name: "LeftLowerLeg", children: [11] },
    { name: "RightUpperLeg", children: [6] },
    { name: "RightLowerLeg", children: [12] },
    { name: "LeftUpperArm", children: [8] },
    { name: "LeftLowerArm" },
    { name: "RightUpperArm", children: [10] },
    { name: "RightLowerArm" },
    { name: "LeftFoot" },
    { name: "RightFoot" },
    { name: "CharacterMesh", mesh: 0, skin: 0 }
  ];
  const document = {
    asset: { version: "2.0", generator: "Comic30 rig contract test" },
    buffers: [{ byteLength: binary.length }],
    bufferViews,
    accessors,
    images: [{ bufferView: image, mimeType: "image/png" }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.1, roughnessFactor: 0.7 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, JOINTS_0: 3, WEIGHTS_0: 4 }, material: 0 }] }],
    skins: [{ inverseBindMatrices: 5, skeleton: 0, joints: Array.from({ length: 13 }, (_, index) => index) }],
    animations: [{ name: "DeformationQA", samplers: [{ input: 6, output: 7, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] }],
    nodes,
    scenes: [{ nodes: [0, 13] }],
    scene: 0
  };
  let json = Buffer.from(JSON.stringify(document));
  const jsonPadding = (4 - (json.length % 4)) % 4;
  if (jsonPadding) json = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const binPadding = (4 - (binary.length % 4)) % 4;
  const paddedBinary = binPadding ? Buffer.concat([binary, Buffer.alloc(binPadding)]) : binary;
  const glb = Buffer.alloc(12 + 8 + json.length + 8 + paddedBinary.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(json.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  const binaryHeader = 20 + json.length;
  glb.writeUInt32LE(paddedBinary.length, binaryHeader);
  glb.writeUInt32LE(0x004e4942, binaryHeader + 4);
  paddedBinary.copy(glb, binaryHeader + 8);
  return glb;
}

async function main() {
  const providerCalls = [];
  const uniRig = {
    probe: () => ({ ready: true, reason: null }),
    rig: async (context) => { providerCalls.push(`unirig:${context.source.profile}`); return { provider: "unirig" }; }
  };
  const humanoidStrategy = createHumanoidStrategy({
    providerOrder: ["unirig", "meshy"],
    uniRig,
    fallbackConfigured: true,
    meshifyFallback: async () => { providerCalls.push("meshy"); return { provider: "meshy-fallback" }; }
  });
  assert.equal((await humanoidStrategy.rig({ source: { name: "Hero", profile: "humanoid" } })).provider, "unirig");
  const creatureStrategy = createCreatureStrategy({ providerOrder: ["meshy", "unirig"], uniRig });
  assert.equal((await creatureStrategy.rig({ source: { name: "Creature", profile: "creature" } })).provider, "unirig");
  await assert.rejects(
    createCreatureStrategy({ providerOrder: ["meshy"], uniRig }).rig({ source: { name: "Creature", profile: "creature" } }),
    /requires UniRig/
  );
  assert.deepEqual(providerCalls, ["unirig:humanoid", "unirig:creature"]);

  const buffer = riggedHumanoidGlb();
  const inspection = inspectRiggedGlbBuffer(buffer, { profile: "humanoid", requireAnimation: true });
  assert.equal(inspection.ok, true, inspection.errors.join(" "));
  assert.equal(inspection.deformationQa.passed, true);
  assert.equal(inspection.deformationQa.syntheticPoseCount, 2);
  assert.ok(inspection.deformationQa.responsiveVertexCount > 0, "Synthetic deformation QA must observe actual vertex response.");
  assert.equal(Object.keys(inspection.mapping).length, 13);
  assert.equal(inspectRiggedGlbBuffer(buffer, { profile: "vehicle" }).ok, false, "Humanoid evidence must not pass the vehicle mapping contract.");
  assert.equal(runSyntheticDeformationQa([{ position: [0, 0, 0], joints: [0, 0, 0, 0], weights: [0, 0, 0, 0] }]).passed, false);

  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  const handoff = createUnrealRigHandoff({
    assetId: "asset-hero",
    name: "Hero Character",
    profile: "humanoid",
    mapping: inspection.mapping,
    deformationQa: inspection.deformationQa
  });
  assert.throws(() => createUnrealRigHandoff({
    assetId: "asset-forged",
    name: "Forged evidence",
    profile: "humanoid",
    mapping: inspection.mapping,
    deformationQa: { passed: true, syntheticPoseCount: 0, responsiveVertexCount: 0 }
  }), /synthetic-pose deformation evidence/);
  const handoffBuffer = Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`);
  const handoffDigest = crypto.createHash("sha256").update(handoffBuffer).digest("hex");
  const server = http.createServer((req, res) => {
    const content = req.url.endsWith(".json") ? handoffBuffer : buffer;
    res.writeHead(200, {
      "Content-Type": req.url.endsWith(".json") ? "application/json" : "model/gltf-binary",
      "Content-Length": content.length
    });
    res.end(content);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;
  const artifact = (filename) => ({ url: `/${filename}`, filename, sha256: digest, bytes: buffer.length, format: "glb" });
  const requirement = { id: "asset-hero", name: "Hero Character", rigRequired: true, rigProfile: "humanoid" };
  const job = {
    id: "rig-test",
    status: "completed",
    requirements: [requirement],
    outputs: [{
      assetId: requirement.id,
      name: requirement.name,
      profile: "humanoid",
      provider: "contract-test",
      artifact: artifact("hero-rigged.glb"),
      handoffArtifact: {
        url: "/hero-unreal-rig-handoff.json",
        filename: "hero-unreal-rig-handoff.json",
        sha256: handoffDigest,
        bytes: handoffBuffer.length,
        format: "json"
      },
      animationArtifacts: { walking: artifact("hero-walking.glb"), running: artifact("hero-running.glb") },
      validation: inspection
    }]
  };
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), "comic30-rig-test-"));
  try {
    const entries = await rigWorker.materializeArtifactEntries(job, target, { COMIC30_RIG_WORKER_URL: endpoint });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].animationFiles.length, 2);
    assert.equal(entries[0].handoff.assetId, requirement.id);
    assert.equal((await fsp.stat(entries[0].handoffFile)).size, handoffBuffer.length);
    assert.equal((await fsp.stat(entries[0].file)).size, buffer.length);
    console.log(`Rig worker contract verified: ${inspection.metrics.skinCount} skin, ${inspection.metrics.weightedVertexCount} weighted vertices, ${entries[0].animationFiles.length} deformation clips.`);
  } finally {
    server.close();
    await fsp.rm(target, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { riggedHumanoidGlb };
