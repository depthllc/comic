"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { inspectRiggedGlbBuffer } = require("../../../engine/rig-inspector");

function exists(value) { try { return fs.existsSync(value); } catch { return false; } }

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const stderr = [];
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Blender vehicle rigging exited with ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-3000)}`)));
  });
}

function createVehicleStrategy(env = process.env) {
  const blender = String(env.COMIC30_BLENDER_EXECUTABLE || "").trim();
  const script = path.join(__dirname, "vehicle_rig.py");
  return {
    id: "vehicle-articulation",
    probe() {
      return { ready: Boolean(blender && exists(blender) && exists(script)), reason: blender && exists(blender) ? null : "COMIC30_BLENDER_EXECUTABLE is not configured for vehicle articulation." };
    },
    async rig({ sourceBuffer, source, workDir }) {
      const authored = inspectRiggedGlbBuffer(sourceBuffer, { profile: "vehicle" });
      if (authored.ok) return { provider: "comic30-authored-vehicle", riggedBuffer: sourceBuffer, fbxBuffer: null, animationBuffers: {}, validation: authored, providerTasks: { articulation: "already-authored" } };
      const health = this.probe();
      if (!health.ready) throw new Error(`${source.name} is not an authored vehicle rig and ${health.reason}`);
      await fsp.mkdir(workDir, { recursive: true });
      const input = path.join(workDir, "source.glb");
      const output = path.join(workDir, "vehicle-rigged.glb");
      await fsp.writeFile(input, sourceBuffer);
      await run(blender, ["--background", "--python", script, "--", "--input", input, "--output", output], workDir);
      if (!exists(output)) throw new Error("Blender did not create a vehicle-rigged GLB.");
      return { provider: "comic30-blender-vehicle", riggedBuffer: await fsp.readFile(output), fbxBuffer: null, animationBuffers: {}, providerTasks: { articulation: "vehicle_rig.py" } };
    }
  };
}

module.exports = { createVehicleStrategy };
