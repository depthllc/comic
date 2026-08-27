"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

function exists(value) { try { return fs.existsSync(value); } catch { return false; } }

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let child;
    try {
      child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, shell: false, env: { ...process.env, ...(options.env || {}) } });
    } catch (error) { reject(error); return; }
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else reject(new Error(`${path.basename(executable)} exited with ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-3000)}`));
    });
  });
}

function templateArgs(template, replacements = {}) {
  return (String(template || "").match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((value) => {
    const unquoted = value.replace(/^"|"$/g, "");
    return unquoted.replace(/\{(\w+)\}/g, (_, name) => replacements[name] ?? `{${name}}`);
  });
}

function createUniRigProvider(env = process.env) {
  const root = path.resolve(String(env.COMIC30_UNIRIG_ROOT || "."));
  const bash = String(env.COMIC30_UNIRIG_BASH || "bash").trim();
  const skeletonScript = path.join(root, "launch", "inference", "generate_skeleton.sh");
  const skinScript = path.join(root, "launch", "inference", "generate_skin.sh");
  const mergeScript = path.join(root, "launch", "inference", "merge.sh");
  return {
    id: "unirig",
    probe() {
      const missing = [];
      if (!env.COMIC30_UNIRIG_ROOT) missing.push("COMIC30_UNIRIG_ROOT");
      if (!exists(skeletonScript)) missing.push(skeletonScript);
      if (!exists(skinScript)) missing.push(skinScript);
      if (!exists(mergeScript)) missing.push(mergeScript);
      return { ready: missing.length === 0, reason: missing.length ? `UniRig is missing: ${missing.join(", ")}.` : null, profiles: ["humanoid", "creature"] };
    },
    async rig({ sourceBuffer, source, workDir }) {
      const health = this.probe();
      if (!health.ready) throw new Error(health.reason);
      await fsp.mkdir(workDir, { recursive: true });
      const input = path.join(workDir, "source.glb");
      const skeleton = path.join(workDir, "skeleton.fbx");
      const skinned = path.join(workDir, "skinned.fbx");
      const rigged = path.join(workDir, "rigged.glb");
      await fsp.writeFile(input, sourceBuffer);
      await run(bash, [
        skeletonScript,
        "--input", input,
        "--output", skeleton,
        ...templateArgs(env.COMIC30_UNIRIG_SKELETON_ARGS)
      ], { cwd: root });
      if (!exists(skeleton)) throw new Error("UniRig skeleton inference completed without creating the skeleton FBX.");
      await run(bash, [
        skinScript,
        "--input", skeleton,
        "--output", skinned,
        ...templateArgs(source.profile === "creature" ? env.COMIC30_UNIRIG_CREATURE_SKIN_ARGS : env.COMIC30_UNIRIG_HUMANOID_SKIN_ARGS),
        ...templateArgs(env.COMIC30_UNIRIG_SKIN_ARGS)
      ], { cwd: root });
      if (!exists(skinned)) throw new Error("UniRig skin inference completed without creating the skinned FBX.");
      await run(bash, [
        mergeScript,
        "--source", skinned,
        "--target", input,
        "--output", rigged,
        ...templateArgs(env.COMIC30_UNIRIG_MERGE_ARGS)
      ], { cwd: root });
      if (!exists(rigged)) throw new Error("UniRig merge completed without creating the textured rigged GLB.");
      return {
        provider: "unirig",
        riggedBuffer: await fsp.readFile(rigged),
        fbxBuffer: await fsp.readFile(skinned),
        animationBuffers: {},
        providerTasks: { skeleton: "generate_skeleton.sh", skin: "generate_skin.sh", merge: "merge.sh" }
      };
    }
  };
}

module.exports = { createUniRigProvider, templateArgs };
