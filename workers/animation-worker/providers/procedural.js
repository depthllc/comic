"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

function exists(value) { try { return fs.existsSync(value); } catch { return false; } }

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error(`Blender animation generation exited with ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-3000)}`)));
  });
}

function createProceduralProvider(env = process.env) {
  const blender = String(env.COMIC30_BLENDER_EXECUTABLE || "").trim();
  const script = path.join(__dirname, "vehicle_animation.py");
  return {
    id: "comic30-blender-motion",
    async probe() {
      return { ready: Boolean(blender && exists(blender) && exists(script)), configured: Boolean(blender), executable: blender || null, capabilities: { profiles: ["vehicle"] }, reason: blender && exists(blender) ? null : "COMIC30_BLENDER_EXECUTABLE is not configured for owned vehicle animation." };
    },
    async animate({ source, sourceBuffer, rigHandoff, clip, workDir }) {
      if (source.profile !== "vehicle") throw new Error("The procedural Blender motion provider currently supports vehicle articulation only.");
      const health = await this.probe();
      if (!health.ready) throw new Error(health.reason);
      await fsp.mkdir(workDir, { recursive: true });
      const input = path.join(workDir, "rigged.glb");
      const handoff = path.join(workDir, "rig-handoff.json");
      const output = path.join(workDir, `${clip.id}.glb`);
      await Promise.all([
        fsp.writeFile(input, sourceBuffer),
        fsp.writeFile(handoff, `${JSON.stringify(rigHandoff, null, 2)}\n`, "utf8")
      ]);
      await run(blender, ["--background", "--python", script, "--", "--input", input, "--output", output, "--handoff", handoff, "--clip-id", clip.id, "--clip-name", clip.name, "--prompt", clip.prompt, "--duration", String(clip.durationSeconds || 2)], workDir);
      if (!exists(output)) throw new Error("Blender did not create an animated GLB.");
      return { provider: "comic30-blender-motion", buffer: await fsp.readFile(output), providerTasks: { animation: "vehicle_animation.py" } };
    }
  };
}

module.exports = { createProceduralProvider };
