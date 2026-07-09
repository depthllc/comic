const fs = require("fs");
const path = require("path");
const convert = require("fbx2gltf");

const root = path.resolve(__dirname, "..");
const inspectRoot = "C:\\tmp\\comic30-model-inspect";
const outDir = path.join(root, "public", "assets", "models", "generated");

const jobs = [
  {
    name: "neck-mech-walker",
    src: path.join(inspectRoot, "78-fbx-neck_mech_walker_by_3dhaupt", "FBX-Neck_Mech_Walker_by_3DHaupt", "Neck_Mech_Walker_by_3DHaupt.fbx"),
    args: ["--pbr-metallic-roughness", "--anim-framerate", "bake30"]
  },
  {
    name: "transport-shuttle",
    src: path.join(inspectRoot, "6nioagpbdym8-Futuristic_Transport_Shuttle_Rigged", "Futuristic_Transport_Shuttle_Rigged", "Transport Shuttle_fbx.fbx"),
    args: ["--pbr-metallic-roughness", "--anim-framerate", "bake30"]
  },
  {
    name: "e45-aircraft",
    src: path.join(inspectRoot, "c2lpk7avgum8-E-45-Aircraft", "E-45-Aircraft", "E 45 Aircraft-sketchfab-Version.fbx"),
    args: ["--pbr-metallic-roughness", "--anim-framerate", "bake30"]
  },
  {
    name: "nathan-walking",
    src: path.join(inspectRoot, "55-rp_nathan_animated_003_walking_fbx", "rp_nathan_animated_003_walking.fbx"),
    args: ["--pbr-metallic-roughness", "--anim-framerate", "bake30"]
  },
  {
    name: "five-wheeler",
    src: path.join(inspectRoot, "86-fbx", "fbx", "Five_Wheeler-(FBX 7.4 binary mit Animation).fbx"),
    args: ["--pbr-metallic-roughness", "--anim-framerate", "bake30"]
  },
  {
    name: "space-station-scene",
    src: path.join(inspectRoot, "89-fbx", "fbx", "Space Station Scene.fbx"),
    args: ["--pbr-metallic-roughness"]
  }
];

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];

  for (const job of jobs) {
    const dest = path.join(outDir, `${job.name}.glb`);
    if (!fs.existsSync(job.src)) {
      results.push({ name: job.name, ok: false, message: `Missing source: ${job.src}` });
      continue;
    }

    try {
      const output = await convert(job.src, dest, job.args.slice());
      const size = fs.statSync(output).size;
      results.push({ name: job.name, ok: true, output, size });
    } catch (error) {
      results.push({ name: job.name, ok: false, message: error.message });
    }
  }

  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

main();
