"use strict";

const PROFILE_RULES = {
  humanoid: {
    semanticBones: ["hips", "spine", "head", "leftUpperLeg", "leftFoot", "rightUpperLeg", "rightFoot"],
    chains: ["Spine", "LeftLeg", "RightLeg"]
  },
  creature: {
    semanticBones: ["root", "head"],
    chains: ["Spine"],
    anyChains: ["FrontLeftLeg", "FrontRightLeg", "HindLeftLeg", "HindRightLeg", "Tail"]
  },
  vehicle: {
    semanticBones: ["chassis", "wheelFrontLeft", "wheelFrontRight", "wheelRearLeft", "wheelRearRight"],
    chains: ["Chassis", "FrontLeftWheel", "FrontRightWheel", "RearLeftWheel", "RearRightWheel"]
  }
};

function normalizeProfiles(capabilities, fallback = []) {
  const raw = capabilities?.profiles;
  if (Array.isArray(raw)) return [...new Set(raw.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (raw && typeof raw === "object") {
    return Object.entries(raw).filter(([, enabled]) => enabled === true).map(([profile]) => String(profile).trim().toLowerCase());
  }
  return [...new Set(fallback.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
}

function validateRetargetProfile(profile, handoff) {
  const normalized = String(profile || "").trim().toLowerCase();
  const rules = PROFILE_RULES[normalized];
  const errors = [];
  if (!rules) return { ok: false, profile: normalized, errors: [`Unsupported retarget profile ${normalized || "missing"}.`] };
  if (handoff?.profile !== normalized) errors.push(`Rig handoff profile ${handoff?.profile || "missing"} does not match ${normalized}.`);
  const semanticBones = handoff?.semanticBones || {};
  for (const semantic of rules.semanticBones) {
    if (!String(semanticBones[semantic] || "").trim()) errors.push(`${normalized} retargeting requires semantic bone ${semantic}.`);
  }
  const chains = new Set((handoff?.chains || []).map((chain) => String(chain?.name || "").trim()));
  for (const chain of rules.chains) {
    if (!chains.has(chain)) errors.push(`${normalized} retargeting requires chain ${chain}.`);
  }
  if (rules.anyChains && !rules.anyChains.some((chain) => chains.has(chain))) {
    errors.push(`${normalized} retargeting requires at least one articulated limb or tail chain.`);
  }
  return {
    ok: errors.length === 0,
    profile: normalized,
    errors: [...new Set(errors)],
    semanticBones: rules.semanticBones,
    chains: rules.chains,
    optionalAlternatives: rules.anyChains || []
  };
}

module.exports = { PROFILE_RULES, normalizeProfiles, validateRetargetProfile };
