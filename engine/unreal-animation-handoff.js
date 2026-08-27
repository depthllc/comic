"use strict";

const SCHEMA = "comic30.unreal-animation-handoff.v1";

function createUnrealAnimationHandoff({ assetId, name, profile, rigHandoff, clips }) {
  if (!rigHandoff?.assetId || rigHandoff.assetId !== assetId) throw new Error(`${name || assetId} has no matching validated rig handoff.`);
  if (!Array.isArray(clips) || !clips.length) throw new Error(`${name || assetId} has no validated animation clips.`);
  const normalized = clips.map((clip) => {
    if (!clip?.artifact?.sha256 || !clip?.artifact?.bytes || clip.validation?.animationQa?.passed !== true) {
      throw new Error(`${clip?.name || "Animation clip"} lacks passing animation evidence.`);
    }
    return {
      id: clip.id,
      name: clip.name,
      prompt: clip.prompt || "",
      durationSeconds: Number(clip.validation.clips?.[0]?.durationSeconds || 0),
      channelCount: Number(clip.validation.clips?.[0]?.channelCount || 0),
      keyedMappedBoneCount: Number(clip.validation.clips?.[0]?.keyedMappedBoneCount || 0),
      rootMotionDistance: Number(clip.validation.clips?.[0]?.rootMotionDistance || 0),
      artifact: {
        filename: clip.artifact.filename,
        sha256: clip.artifact.sha256,
        bytes: clip.artifact.bytes,
        format: clip.artifact.format
      },
      qa: clip.validation.animationQa
    };
  });
  return {
    schema: SCHEMA,
    assetId,
    name,
    profile,
    targetSkeleton: {
      retargetRoot: rigHandoff.retargetRoot,
      semanticBones: rigHandoff.semanticBones,
      chains: rigHandoff.chains
    },
    clips: normalized,
    unreal: {
      useInterchange: true,
      importSkeletalMesh: false,
      importAnimations: true,
      createIKRetargeter: true,
      createControlRigMappings: rigHandoff.controlRig?.requested === true,
      destination: `/Game/Comic30/Animations/${String(assetId).replace(/[^A-Za-z0-9_]/g, "_")}`
    },
    generatedAt: new Date().toISOString()
  };
}

function validateUnrealAnimationHandoff(value) {
  const errors = [];
  if (value?.schema !== SCHEMA) errors.push("Animation handoff schema is invalid.");
  if (!value?.assetId || !value?.profile || !value?.targetSkeleton?.retargetRoot) errors.push("Animation handoff identity, profile, or target skeleton is missing.");
  if (!Array.isArray(value?.targetSkeleton?.chains) || !value.targetSkeleton.chains.length) errors.push("Animation handoff contains no retarget chains.");
  if (!Array.isArray(value?.clips) || !value.clips.length) errors.push("Animation handoff contains no clips.");
  for (const clip of value?.clips || []) {
    if (!clip?.id || !clip?.name || !clip?.artifact?.sha256 || !clip?.artifact?.bytes) errors.push("Animation handoff clip evidence is incomplete.");
    if (clip?.qa?.passed !== true || Number(clip?.channelCount || 0) < 1 || Number(clip?.keyedMappedBoneCount || 0) < 1) errors.push(`${clip?.name || "Animation clip"} did not pass retarget and keyframe QA.`);
  }
  if (value?.unreal?.useInterchange !== true || value?.unreal?.importAnimations !== true) errors.push("Animation handoff does not request Unreal Interchange animation import.");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { SCHEMA, createUnrealAnimationHandoff, validateUnrealAnimationHandoff };
