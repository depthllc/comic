"use strict";

const SCHEMA = "comic30.unreal-rig-handoff.v1";

const CHAINS = {
  humanoid: [
    ["Spine", "hips", "head"],
    ["LeftArm", "leftUpperArm", "leftLowerArm"],
    ["RightArm", "rightUpperArm", "rightLowerArm"],
    ["LeftLeg", "leftUpperLeg", "leftFoot"],
    ["RightLeg", "rightUpperLeg", "rightFoot"]
  ],
  creature: [
    ["Spine", "root", "head"],
    ["FrontLeftLeg", "frontLeftUpper", "frontLeftFoot"],
    ["FrontRightLeg", "frontRightUpper", "frontRightFoot"],
    ["HindLeftLeg", "hindLeftUpper", "hindLeftFoot"],
    ["HindRightLeg", "hindRightUpper", "hindRightFoot"],
    ["Tail", "tailBase", "tailTip"]
  ],
  vehicle: [
    ["Chassis", "chassis", "chassis"],
    ["FrontLeftWheel", "wheelFrontLeft", "wheelFrontLeft"],
    ["FrontRightWheel", "wheelFrontRight", "wheelFrontRight"],
    ["RearLeftWheel", "wheelRearLeft", "wheelRearLeft"],
    ["RearRightWheel", "wheelRearRight", "wheelRearRight"]
  ]
};

function mappingName(mapping, semantic) {
  return String(mapping?.[semantic]?.name || "").trim() || null;
}

function createUnrealRigHandoff({ assetId, name, profile, mapping, deformationQa }) {
  const normalizedProfile = String(profile || "humanoid").toLowerCase();
  const chains = (CHAINS[normalizedProfile] || []).map(([chain, startSemantic, endSemantic]) => ({
    name: chain,
    startBone: mappingName(mapping, startSemantic),
    endBone: mappingName(mapping, endSemantic)
  })).filter((chain) => chain.startBone && chain.endBone);
  const retargetRoot = normalizedProfile === "humanoid" ? mappingName(mapping, "hips")
    : normalizedProfile === "creature" ? mappingName(mapping, "root")
      : mappingName(mapping, "chassis");
  if (!retargetRoot) throw new Error(`${name || assetId} has no validated ${normalizedProfile} retarget root.`);
  if (!chains.length) throw new Error(`${name || assetId} has no validated IK chains.`);
  if (deformationQa?.passed !== true) throw new Error(`${name || assetId} cannot enter Unreal because deformation QA has not passed.`);
  if (Number(deformationQa?.syntheticPoseCount || 0) < 2 || Number(deformationQa?.responsiveVertexCount || 0) < 1) {
    throw new Error(`${name || assetId} cannot enter Unreal without synthetic-pose deformation evidence.`);
  }
  return {
    schema: SCHEMA,
    assetId,
    name,
    profile: normalizedProfile,
    retargetRoot,
    chains,
    semanticBones: Object.fromEntries(Object.entries(mapping || {}).map(([semantic, value]) => [semantic, value.name])),
    controlRig: {
      requested: true,
      template: normalizedProfile === "humanoid" ? "FKIKHumanoid" : normalizedProfile === "creature" ? "FKIKCreature" : "VehicleArticulation",
      generateIfSupported: true
    },
    validation: { deformationQa },
    generatedAt: new Date().toISOString()
  };
}

function validateUnrealRigHandoff(value) {
  const errors = [];
  if (value?.schema !== SCHEMA) errors.push("Rig handoff schema is invalid.");
  if (!value?.assetId || !value?.profile || !value?.retargetRoot) errors.push("Rig handoff identity, profile, or retarget root is missing.");
  if (!Array.isArray(value?.chains) || !value.chains.length) errors.push("Rig handoff contains no IK chains.");
  if (value?.validation?.deformationQa?.passed !== true) errors.push("Rig handoff does not include passing deformation-QA evidence.");
  if (Number(value?.validation?.deformationQa?.syntheticPoseCount || 0) < 2 || Number(value?.validation?.deformationQa?.responsiveVertexCount || 0) < 1) {
    errors.push("Rig handoff does not include responsive synthetic-pose evidence.");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { SCHEMA, createUnrealRigHandoff, validateUnrealRigHandoff };
