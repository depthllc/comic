const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const port = 5199;
const origin = `http://127.0.0.1:${port}`;

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolated Comic30 test server did not start.");
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "comic30-backend-test-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), COMIC30_DATA_DIR: dataDir, CSRF_STRICT: "false", NODE_ENV: "development", OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let cookie = "";
  let csrf = "";

  async function request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (csrf) headers["x-csrf-token"] = csrf;
    const binaryBody = Buffer.isBuffer(options.body) || options.body instanceof Uint8Array || options.body instanceof ArrayBuffer;
    if (options.body && typeof options.body !== "string" && !binaryBody) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${origin}${pathname}`, { ...options, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const tokens = setCookie.split(/,(?=\s*[^;,]+=)/).map((item) => item.split(";")[0].trim());
      const values = new Map(cookie.split("; ").filter(Boolean).map((item) => item.split(/=(.*)/s).slice(0, 2)));
      tokens.forEach((item) => {
        const [name, value] = item.split(/=(.*)/s).slice(0, 2);
        values.set(name, value);
      });
      cookie = [...values].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    if (options.rawResponse) {
      if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname}: ${response.status}`);
      return response;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname}: ${payload.error || response.status}`);
    return payload;
  }

  try {
    await waitForServer();
    const security = await request("/api/security/csrf");
    csrf = security.csrfToken;
    const email = `engine-test-${Date.now()}@example.com`;
    const auth = await request("/api/auth/register", { method: "POST", body: { name: "Engine Test", email, password: "Comic30-Test-Password-91!" } });
    assert(auth.user?.id, "Registration did not create a user.");

    const created = await request("/api/projects", {
      method: "POST",
      body: { title: "Internal Engine Test", genre: "Action RPG", premise: "A persisted end-to-end Comic30 engine validation world." }
    });
    assert(created.project?.id, "Project creation failed.");
    const projectId = created.project.id;

    const glbPath = path.join(__dirname, "..", "public", "assets", "models", "generated", "five-wheeler.glb");
    const glbBytes = await fs.readFile(glbPath);
    const uploadSession = await request(`/api/projects/${projectId}/assets/upload-session`, {
      method: "POST",
      body: { filename: "test-five-wheeler.glb", size: glbBytes.length, contentType: "model/gltf-binary", kind: "vehicle", rigProfile: "none" }
    });
    assert(uploadSession.directUpload === true, "Local asset upload did not select the direct upload path.");
    const uploaded = await request(`/api/projects/${projectId}/assets/upload`, {
      method: "POST",
      headers: {
        "content-type": "model/gltf-binary",
        "x-comic30-filename": encodeURIComponent("test-five-wheeler.glb"),
        "x-comic30-asset-kind": "vehicle",
        "x-comic30-rig-profile": "none"
      },
      body: glbBytes
    });
    assert(uploaded.asset?.source === "user-upload", "The uploaded GLB was not added to the project library.");
    assert(uploaded.asset?.checksum?.length === 64, "The uploaded GLB did not receive a SHA-256 checksum.");
    assert(uploaded.asset?.validation?.metrics?.meshCount > 0, "The uploaded GLB was not structurally inspected.");
    const downloaded = await request(`/api/projects/${projectId}/assets/${uploaded.asset.id}/download`, { rawResponse: true });
    const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
    assert(downloadedBytes.equals(glbBytes), "The secured asset download did not match the uploaded GLB.");

    for (const module of ["story", "scene", "level", "character", "gameplay", "world", "economy", "build"]) {
      const generated = await request(`/api/projects/${projectId}/engine`, {
        method: "POST",
        body: { module, prompt: `Generate a production-ready ${module} pass for the internal engine test.` }
      });
      assert(generated.project?.id === projectId, `${module} generation did not return the persisted project.`);
      assert(generated.actions?.length, `${module} generation produced no engine actions.`);
      if (module !== "build") assert(["python-process", "javascript-deterministic-fallback"].includes(generated.engine?.execution), `${module} did not report its engine execution mode.`);
    }

    const qa = await request(`/api/projects/${projectId}/action`, { method: "POST", body: { action: "qa" } });
    assert(["passed", "needs-work"].includes(qa.project.lifecycle.qaStatus), "QA did not produce a status.");
    const models = await request("/api/models");
    assert(models.models.some((model) => model.provider === "internal" && model.available), "Internal model registry is unavailable.");
    const inference = await request(`/api/projects/${projectId}/inference`, {
      method: "POST",
      body: { provider: "internal", model: "comic30/director-v1", module: "gameplay", message: "Add a shield-dash combo for the test runtime." }
    });
    assert(inference.run?.provider === "internal" && inference.run.status === "completed", "Internal inference was not recorded.");
    const productionPlan = await request(`/api/projects/${projectId}/text-to-game`, {
      method: "POST",
      body: {
        action: "plan",
        prompt: "Create an endless racing game with traffic, increasing speed, production vehicles, audio, Android, iOS, and Win64 builds.",
        qualityTier: "production",
        targets: ["Win64", "Android", "iOS"]
      }
    });
    assert(productionPlan.run?.spec?.family?.id === "endless-racer", "The text-to-game compiler did not classify the requested game family.");
    assert(productionPlan.run?.graph?.some((item) => item.id === "asset-generation"), "The production graph omitted source-asset generation.");
    assert(productionPlan.run?.graph?.some((item) => item.id === "character-rig"), "The production graph omitted the rigging contract.");
    assert(productionPlan.run?.graph?.some((item) => item.id === "artifact-qa"), "The production graph omitted artifact QA.");
    assert(productionPlan.run?.summary?.blockers?.some((item) => item.nodeId === "asset-generation"), "An unconfigured high-fidelity asset worker was incorrectly reported as complete.");
    const orchestration = await request(`/api/projects/${projectId}/orchestrate`, {
      method: "POST",
      body: { provider: "internal", model: "comic30/director-v1", message: "Create an endless racing game with traffic and increasing speed." }
    });
    assert(orchestration.job?.status === "blueprint-generated" && orchestration.job.progress === 100, "Five-agent design orchestration did not generate a blueprint.");
    assert(orchestration.job.engines?.length === 5 && orchestration.job.engines.every((engine) => ["completed", "fallback"].includes(engine.status)), "All five specialist engines were not recorded.");
    assert(orchestration.manifest?.projectId === projectId && orchestration.manifest.counts?.scenes > 0, "Runtime manifest was not generated from the project.");
    assert(orchestration.manifest?.runtime?.type === "endless-racer" && orchestration.manifest.runtime.status === "browser-prototype" && orchestration.manifest.runtime.shippingBuild === false, "The racing prompt did not produce an honestly labelled browser prototype.");
    assert(orchestration.manifest?.assets?.player?.uri?.endsWith(".glb") && orchestration.manifest.assets.character?.status === "animation-present-unvalidated", "3D source assets were not attached to the engine import manifest.");
    const syncedProduction = await request(`/api/projects/${projectId}/text-to-game`, {
      method: "POST",
      body: { action: "sync", runId: productionPlan.run.id }
    });
    assert(syncedProduction.run?.graph?.find((item) => item.id === "gameplay-design")?.status === "completed", "The persisted production graph did not synchronize design-orchestration evidence.");
    assert(syncedProduction.run?.summary?.status === "blocked", "A production graph with missing source-asset workers was incorrectly marked production-ready.");
    for (const type of ["navigation-bake", "shader-validate", "lod-generate", "asset-optimize"]) {
      const operation = await request(`/api/projects/${projectId}/operations`, { method: "POST", body: { type } });
      assert(operation.job?.status === "completed" && operation.job.progress === 100, `${type} operation did not complete.`);
    }
    const qaReport = await request(`/api/projects/${projectId}/qa`, { method: "POST", body: {} });
    assert(qaReport.report?.total === 8, "Structured QA did not evaluate all eight production steps.");
    const analytics = await request(`/api/projects/${projectId}/analytics`);
    assert(analytics.analytics?.projectId === projectId, "Studio analytics were not derived for the project.");
    const deployed = await request(`/api/projects/${projectId}/action`, { method: "POST", body: { action: "deploy" } });
    assert(deployed.project.lifecycle.deploymentStatus === "live", "Deployment did not persist.");
    const exported = await request(`/api/projects/${projectId}/export`, { method: "POST", body: {} });
    assert(exported.build?.size > 0, "Export artifact was empty.");

    const reloaded = await request("/api/projects");
    const project = reloaded.projects.find((item) => item.id === projectId);
    assert(project, "Project did not survive a persistence reload.");
    assert(project.scenes.length > 0 && project.levels.length > 0, "Generated scene/level data was not persisted.");
    assert(project.buildJobs.length > 0 && project.builds.length > 0, "Build and export records were not persisted.");
    assert(project.deployments.length > 0, "Deployment history was not persisted.");
    assert(project.textToGameRuns?.length > 0, "Text-to-game production runs were not persisted.");
    assert(project.textToGameRuns[0]?.spec?.version === "comic30.game-spec.v1", "The persisted game specification version is missing.");
    const persistedUpload = project.assets.find((item) => item.id === uploaded.asset.id);
    assert(persistedUpload?.storage?.provider === "filesystem", "Uploaded asset metadata did not survive persistence reload.");
    const library = await request(`/api/projects/${projectId}/assets`);
    assert(library.assets.some((item) => item.id === uploaded.asset.id), "The asset library route did not return the uploaded GLB.");

    process.stdout.write(JSON.stringify({
      ok: true,
      projectId,
      storyArcs: project.story.length,
      scenes: project.scenes.length,
      levels: project.levels.length,
      characters: project.characters.length,
      terrainZones: project.terrain.length,
      buildJobs: project.buildJobs.length,
      exports: project.builds.length,
      deployments: project.deployments.length
      ,operations: project.operationJobs.length
      ,qaRuns: project.qaRuns.length
      ,modelArtifacts: project.modelArtifacts.length
      ,inferenceRuns: project.inferenceRuns.length
      ,orchestrationJobs: project.orchestrationJobs.length
      ,runtimeActors: project.runtimeManifest?.actors?.length || 0
      ,textToGameRuns: project.textToGameRuns.length
      ,productionStatus: project.textToGameRuns[0].summary.status
      ,uploadedAssets: project.assets.filter((item) => item.source === "user-upload").length
    }, null, 2));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
