"use strict";

const { parseGlbBuffer } = require("./glb-inspector");
const { inspectRiggedGlbBuffer, readAccessor } = require("./rig-inspector");

const PATH_WIDTHS = { translation: 3, rotation: 4, scale: 3, weights: null };

function finite(values) {
  return values.every((row) => row.every(Number.isFinite));
}

function inspectAnimationGlbBuffer(buffer, options = {}) {
  const profile = String(options.profile || "humanoid").toLowerCase();
  const rig = inspectRiggedGlbBuffer(buffer, { profile, requireAnimation: true });
  const errors = [...rig.errors];
  const warnings = [...rig.warnings];
  const parsed = parseGlbBuffer(buffer);
  if (!parsed.document || !parsed.binary) {
    return { ok: false, profile, errors: [...new Set([...errors, ...parsed.errors])], warnings, clips: [], mapping: rig.mapping || {}, deformationQa: rig.deformationQa || { passed: false } };
  }

  const document = parsed.document;
  const binary = parsed.binary;
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const animations = Array.isArray(document.animations) ? document.animations : [];
  const mappedNodes = new Set(Object.values(rig.mapping || {}).map((entry) => entry.node));
  const clips = [];

  animations.forEach((animation, animationIndex) => {
    const name = String(animation?.name || `clip-${animationIndex + 1}`).trim();
    const samplers = Array.isArray(animation?.samplers) ? animation.samplers : [];
    const channels = Array.isArray(animation?.channels) ? animation.channels : [];
    const keyedNodes = new Set();
    const keyedMappedNodes = new Set();
    let durationSeconds = 0;
    let rootMotionDistance = 0;
    let translationChannels = 0;
    let rotationChannels = 0;
    let scaleChannels = 0;

    if (!samplers.length || !channels.length) errors.push(`${name} has no animation samplers or channels.`);
    channels.forEach((channel, channelIndex) => {
      const target = channel?.target || {};
      const pathName = String(target.path || "");
      if (!Object.prototype.hasOwnProperty.call(PATH_WIDTHS, pathName)) {
        errors.push(`${name} channel ${channelIndex} uses unsupported target path ${pathName || "missing"}.`);
        return;
      }
      if (!Number.isInteger(target.node) || target.node < 0 || target.node >= nodes.length) {
        errors.push(`${name} channel ${channelIndex} targets an invalid node.`);
        return;
      }
      keyedNodes.add(target.node);
      if (mappedNodes.has(target.node)) keyedMappedNodes.add(target.node);
      const sampler = samplers[channel?.sampler];
      if (!sampler || !Number.isInteger(sampler.input) || !Number.isInteger(sampler.output)) {
        errors.push(`${name} channel ${channelIndex} references an invalid sampler.`);
        return;
      }
      const interpolation = String(sampler.interpolation || "LINEAR").toUpperCase();
      if (!["LINEAR", "STEP", "CUBICSPLINE"].includes(interpolation)) errors.push(`${name} channel ${channelIndex} uses unsupported interpolation ${interpolation}.`);
      try {
        const input = readAccessor(document, binary, sampler.input);
        const output = readAccessor(document, binary, sampler.output);
        if (input.accessor.type !== "SCALAR" || input.width !== 1) errors.push(`${name} channel ${channelIndex} time keys are not scalar.`);
        if (!input.count || !finite(input.values)) errors.push(`${name} channel ${channelIndex} has no finite time keys.`);
        for (let index = 1; index < input.values.length; index += 1) {
          if (input.values[index][0] <= input.values[index - 1][0]) errors.push(`${name} channel ${channelIndex} time keys are not strictly increasing.`);
        }
        const first = Number(input.values[0]?.[0] || 0);
        const last = Number(input.values[input.values.length - 1]?.[0] || 0);
        const duration = Math.max(0, last - first);
        durationSeconds = Math.max(durationSeconds, duration);
        if (duration <= 0 || duration > Number(options.maxDurationSeconds || 600)) errors.push(`${name} channel ${channelIndex} has an invalid duration of ${duration.toFixed(3)} seconds.`);
        const expectedOutputCount = input.count * (interpolation === "CUBICSPLINE" ? 3 : 1);
        if (output.count !== expectedOutputCount) errors.push(`${name} channel ${channelIndex} key and output counts do not match.`);
        if (!finite(output.values)) errors.push(`${name} channel ${channelIndex} contains non-finite values.`);
        const expectedWidth = PATH_WIDTHS[pathName];
        if (expectedWidth && output.width !== expectedWidth) errors.push(`${name} channel ${channelIndex} ${pathName} values have the wrong width.`);
        if (pathName === "rotation") {
          rotationChannels += 1;
          const samples = interpolation === "CUBICSPLINE" ? output.values.filter((_, index) => index % 3 === 1) : output.values;
          for (const quaternion of samples) {
            const length = Math.hypot(...quaternion);
            if (!Number.isFinite(length) || Math.abs(length - 1) > 0.08) {
              errors.push(`${name} channel ${channelIndex} contains a non-normalized quaternion.`);
              break;
            }
          }
        } else if (pathName === "translation") {
          translationChannels += 1;
          const samples = interpolation === "CUBICSPLINE" ? output.values.filter((_, index) => index % 3 === 1) : output.values;
          if (samples.length > 1 && mappedNodes.has(target.node)) {
            rootMotionDistance = Math.max(rootMotionDistance, Math.hypot(
              samples[samples.length - 1][0] - samples[0][0],
              samples[samples.length - 1][1] - samples[0][1],
              samples[samples.length - 1][2] - samples[0][2]
            ));
          }
        } else if (pathName === "scale") scaleChannels += 1;
      } catch (error) {
        errors.push(`${name} channel ${channelIndex}: ${error.message}`);
      }
    });

    if (!keyedMappedNodes.size) errors.push(`${name} does not animate any validated ${profile} skeleton bone.`);
    clips.push({
      index: animationIndex,
      name,
      durationSeconds,
      samplerCount: samplers.length,
      channelCount: channels.length,
      keyedNodeCount: keyedNodes.size,
      keyedMappedBoneCount: keyedMappedNodes.size,
      translationChannels,
      rotationChannels,
      scaleChannels,
      rootMotionDistance
    });
  });

  const requestedName = String(options.expectedClip || "").trim().toLowerCase();
  if (requestedName && !clips.some((clip) => clip.name.toLowerCase() === requestedName || clip.name.toLowerCase().includes(requestedName))) {
    warnings.push(`The generated animation is named ${clips.map((clip) => clip.name).join(", ") || "unnamed"}, not ${options.expectedClip}.`);
  }
  const animationQa = {
    passed: errors.length === 0 && rig.deformationQa?.passed === true && clips.length > 0,
    clipCount: clips.length,
    totalChannels: clips.reduce((total, clip) => total + clip.channelCount, 0),
    keyedMappedBoneCount: Math.max(0, ...clips.map((clip) => clip.keyedMappedBoneCount)),
    maximumDurationSeconds: Math.max(0, ...clips.map((clip) => clip.durationSeconds))
  };
  return {
    ok: animationQa.passed,
    profile,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    clips,
    mapping: rig.mapping,
    metrics: { ...rig.metrics, animationCount: animations.length },
    deformationQa: rig.deformationQa,
    animationQa
  };
}

module.exports = { inspectAnimationGlbBuffer };
