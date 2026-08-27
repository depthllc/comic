"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { inspectGlbBuffer } = require("../engine/glb-inspector");
const sourceAssetWorker = require("../engine/source-asset-worker-client");
const { createProviderRegistry, providerOrder } = require("../workers/source-asset-worker/providers");

function glb(document, binary = Buffer.alloc(36)) {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)]);
  const total = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
  const result = Buffer.alloc(total);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(total, 8);
  result.writeUInt32LE(paddedJson.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(result, 20);
  const binaryHeader = 20 + paddedJson.length;
  result.writeUInt32LE(paddedBinary.length, binaryHeader);
  result.writeUInt32LE(0x004e4942, binaryHeader + 4);
  paddedBinary.copy(result, binaryHeader + 8);
  return result;
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Source-asset worker did not start for its health test.");
}

async function main() {
  assert.deepEqual(providerOrder({}), ["trellis2", "meshy"], "Owned TRELLIS.2 must remain the default source provider.");
  const validBuffer = glb({
    asset: { version: "2.0" },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC2" }
    ],
    images: [{ uri: "texture.png" }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 }] }]
  });
  const valid = inspectGlbBuffer(validBuffer);
  assert.equal(valid.ok, true, valid.errors.join(" "));
  assert.equal(valid.metrics.vertexCount, 3);

  const invalid = inspectGlbBuffer(Buffer.from("not-a-model"));
  assert.equal(invalid.ok, false);

  const port = 53190;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "workers", "source-asset-worker", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      COMIC30_ASSET_WORKER_PORT: String(port),
      COMIC30_ASSET_WORKER_TOKEN: "",
      COMIC30_ASSET_PROVIDER_ORDER: "trellis2,meshy",
      COMIC30_TRELLIS2_URL: "",
      MESHY_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/health`);
    assert.equal(health.ready, false);
    assert.deepEqual(health.providerOrder, ["trellis2", "meshy"]);
    assert.match(health.reason, /No configured source-asset provider|TRELLIS|Meshy/i);
    const probed = await sourceAssetWorker.probe({ COMIC30_ASSET_GENERATOR_URL: `http://127.0.0.1:${port}` });
    assert.equal(probed.configured, true);
    assert.equal(probed.available, false, "A configured URL must not count as an available worker without a passing health check.");
  } finally {
    child.kill();
  }

  const trellisServer = http.createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ready: true, version: "contract-test", capabilities: { imageReference: true, promptOnly: false, pbr: true, formats: ["glb"] } }));
      return;
    }
    if (request.url === "/v1/jobs" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(submitted.image, "https://assets.example/reference.png");
      assert.equal(submitted.output.format, "glb");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ job: { id: "trellis-contract", status: "completed", artifact: { url: "https://assets.example/generated.glb" } } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => trellisServer.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${trellisServer.address().port}`;
    const registry = createProviderRegistry({ COMIC30_ASSET_PROVIDER_ORDER: "trellis2,meshy", COMIC30_TRELLIS2_URL: endpoint, MESHY_API_KEY: "" });
    const generated = await registry.generate({
      job: { id: "job-contract" },
      requirement: { id: "vehicle", name: "Hero vehicle", rigProfile: "vehicle" },
      prompt: "A production-ready hero vehicle",
      imageUrl: "https://assets.example/reference.png"
    });
    assert.equal(generated.provider, "trellis2");
    assert.equal(generated.modelUrl, "https://assets.example/generated.glb");
    await assert.rejects(
      registry.generate({ job: { id: "job-no-image" }, requirement: { id: "vehicle", name: "No reference" }, prompt: "text only", imageUrl: null }),
      /image-to-3D|reference image/
    );
  } finally {
    await new Promise((resolve) => trellisServer.close(resolve));
  }

  const artifactPort = 53191;
  const artifactServer = http.createServer((request, response) => {
    if (request.url !== "/artifact.glb") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "model/gltf-binary", "Content-Length": validBuffer.length });
    response.end(validBuffer);
  });
  await new Promise((resolve) => artifactServer.listen(artifactPort, "127.0.0.1", resolve));
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), "comic30-asset-contract-"));
  const requirement = { id: "hero-vehicle", name: "Hero vehicle", required: true };
  const completedJob = {
    status: "completed",
    requirements: [requirement],
    outputs: [{
      assetId: requirement.id,
      name: requirement.name,
      validation: { ok: true },
      artifact: {
        url: "/artifact.glb",
        filename: "hero-vehicle.glb",
        bytes: validBuffer.length,
        sha256: crypto.createHash("sha256").update(validBuffer).digest("hex")
      }
    }]
  };
  const artifactEnv = { COMIC30_ASSET_GENERATOR_URL: `http://127.0.0.1:${artifactPort}` };
  try {
    const files = await sourceAssetWorker.materializeArtifacts(completedJob, targetDir, artifactEnv);
    assert.equal(files.length, 1);
    assert.deepEqual(await fsp.readFile(files[0]), validBuffer);

    const tamperedJob = JSON.parse(JSON.stringify(completedJob));
    tamperedJob.outputs[0].artifact.sha256 = "0".repeat(64);
    await assert.rejects(
      sourceAssetWorker.materializeArtifacts(tamperedJob, targetDir, artifactEnv),
      /checksum verification/
    );
  } finally {
    await new Promise((resolve) => artifactServer.close(resolve));
    await fsp.rm(targetDir, { recursive: true, force: true });
  }
  console.log("Source-asset contract test passed without invoking a paid generation task.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
