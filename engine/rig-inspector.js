"use strict";

const { inspectGlbBuffer, parseGlbBuffer } = require("./glb-inspector");

const COMPONENTS = {
  5120: { bytes: 1, read: (view, offset) => view.readInt8(offset), normalize: (value) => Math.max(value / 127, -1) },
  5121: { bytes: 1, read: (view, offset) => view.readUInt8(offset), normalize: (value) => value / 255 },
  5122: { bytes: 2, read: (view, offset) => view.readInt16LE(offset), normalize: (value) => Math.max(value / 32767, -1) },
  5123: { bytes: 2, read: (view, offset) => view.readUInt16LE(offset), normalize: (value) => value / 65535 },
  5125: { bytes: 4, read: (view, offset) => view.readUInt32LE(offset), normalize: (value) => value / 4294967295 },
  5126: { bytes: 4, read: (view, offset) => view.readFloatLE(offset), normalize: (value) => value }
};

const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const HUMANOID_ALIASES = {
  hips: ["hips", "pelvis", "root"],
  spine: ["spine", "spine01", "spine1"],
  head: ["head"],
  leftUpperArm: ["leftupperarm", "upperarm_l", "lupperarm", "mixamorigleftarm"],
  rightUpperArm: ["rightupperarm", "upperarm_r", "rupperarm", "mixamorigrightarm"],
  leftLowerArm: ["leftlowerarm", "lowerarm_l", "lforearm", "mixamorigleftforearm"],
  rightLowerArm: ["rightlowerarm", "lowerarm_r", "rforearm", "mixamorigrightforearm"],
  leftUpperLeg: ["leftupleg", "leftupperleg", "upperleg_l", "thigh_l", "lthigh", "mixamorigleftupleg"],
  rightUpperLeg: ["rightupleg", "rightupperleg", "upperleg_r", "thigh_r", "rthigh", "mixamorigrightupleg"],
  leftLowerLeg: ["leftleg", "leftlowerleg", "lowerleg_l", "calf_l", "lcalf", "mixamorigleftleg"],
  rightLowerLeg: ["rightleg", "rightlowerleg", "lowerleg_r", "calf_r", "rcalf", "mixamorigrightleg"],
  leftFoot: ["leftfoot", "foot_l", "lfoot", "mixamorigleftfoot"],
  rightFoot: ["rightfoot", "foot_r", "rfoot", "mixamorigrightfoot"]
};

const VEHICLE_ALIASES = {
  chassis: ["chassis", "body", "vehiclebody", "vehicle_root", "vehicleroot"],
  wheelFrontLeft: ["wheel_front_left", "wheelfl", "frontleftwheel", "wheel_fl"],
  wheelFrontRight: ["wheel_front_right", "wheelfr", "frontrightwheel", "wheel_fr"],
  wheelRearLeft: ["wheel_rear_left", "wheelrl", "rearleftwheel", "wheel_rl"],
  wheelRearRight: ["wheel_rear_right", "wheelrr", "rearrightwheel", "wheel_rr"]
};

// UniRig is category-agnostic, so creature outputs are validated against a
// semantic quadruped contract instead of being forced through humanoid names.
// Tail bones are deliberately optional: a creature can be production-ready
// without a tail, while all four deforming limbs remain mandatory.
const CREATURE_ALIASES = {
  root: ["root", "pelvis", "hips", "bodyroot"],
  spine: ["spine", "spine01", "spine1", "body"],
  head: ["head", "skull"],
  frontLeftUpper: ["frontleftupper", "frontleg_l", "foreleg_l", "leftforeleg", "fl_upper"],
  frontLeftFoot: ["frontleftfoot", "frontfoot_l", "forepaw_l", "leftforepaw", "fl_foot"],
  frontRightUpper: ["frontrightupper", "frontleg_r", "foreleg_r", "rightforeleg", "fr_upper"],
  frontRightFoot: ["frontrightfoot", "frontfoot_r", "forepaw_r", "rightforepaw", "fr_foot"],
  hindLeftUpper: ["hindleftupper", "hindleg_l", "rearleg_l", "lefthindleg", "hl_upper"],
  hindLeftFoot: ["hindleftfoot", "hindfoot_l", "hindpaw_l", "lefthindpaw", "hl_foot"],
  hindRightUpper: ["hindrightupper", "hindleg_r", "rearleg_r", "righthindleg", "hr_upper"],
  hindRightFoot: ["hindrightfoot", "hindfoot_r", "hindpaw_r", "righthindpaw", "hr_foot"]
};

const CREATURE_OPTIONAL_ALIASES = {
  tailBase: ["tail", "tailbase", "tail01"],
  tailTip: ["tailtip", "tailend", "tail04", "tail05"]
};

function normalizedName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readAccessor(document, binary, accessorIndex, options = {}) {
  const accessors = Array.isArray(document.accessors) ? document.accessors : [];
  const views = Array.isArray(document.bufferViews) ? document.bufferViews : [];
  const accessor = accessors[accessorIndex];
  if (!accessor) throw new Error(`Accessor ${accessorIndex} does not exist.`);
  if (accessor.sparse) throw new Error(`Accessor ${accessorIndex} uses sparse storage, which the rig QA worker does not accept.`);
  const view = views[accessor.bufferView];
  if (!view || !binary) throw new Error(`Accessor ${accessorIndex} has no readable binary buffer view.`);
  const component = COMPONENTS[accessor.componentType];
  const width = WIDTHS[accessor.type];
  if (!component || !width) throw new Error(`Accessor ${accessorIndex} uses an unsupported component or value type.`);
  const packed = component.bytes * width;
  const stride = Number(view.byteStride || packed);
  if (stride < packed) throw new Error(`Accessor ${accessorIndex} has an invalid byte stride.`);
  const count = Number(accessor.count || 0);
  const limit = Math.min(count, Number(options.limit || count));
  const base = Number(view.byteOffset || 0) + Number(accessor.byteOffset || 0);
  const required = limit ? base + (limit - 1) * stride + packed : base;
  if (base < 0 || required > binary.length) throw new Error(`Accessor ${accessorIndex} reads beyond the GLB binary chunk.`);
  const values = [];
  for (let row = 0; row < limit; row += 1) {
    const item = [];
    for (let column = 0; column < width; column += 1) {
      const value = component.read(binary, base + row * stride + column * component.bytes);
      item.push(accessor.normalized ? component.normalize(value) : value);
    }
    values.push(item);
  }
  return { accessor, values, count, width };
}

function mapSkeleton(nodes, aliases) {
  const names = nodes.map((node) => normalizedName(node?.name));
  const mapping = {};
  for (const [semantic, candidates] of Object.entries(aliases)) {
    const normalized = candidates.map(normalizedName);
    const index = names.findIndex((name) => normalized.some((candidate) => name === candidate || name.endsWith(candidate)));
    if (index >= 0) mapping[semantic] = { node: index, name: nodes[index]?.name || `node-${index}` };
  }
  return mapping;
}

function inspectNodeGraph(nodes) {
  const errors = [];
  const state = new Array(nodes.length).fill(0);
  function visit(index) {
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length) {
      errors.push(`Skeleton hierarchy references invalid node ${index}.`);
      return;
    }
    if (state[index] === 1) {
      errors.push(`Skeleton hierarchy contains a cycle at node ${index}.`);
      return;
    }
    if (state[index] === 2) return;
    state[index] = 1;
    for (const child of Array.isArray(nodes[index]?.children) ? nodes[index].children : []) visit(child);
    state[index] = 2;
  }
  nodes.forEach((_, index) => visit(index));
  return errors;
}

function boundsOf(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return { min, max, diagonal };
}

function rotatePoint(point, axis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const [x, y, z] = point;
  if (axis === 0) return [x, y * cosine - z * sine, y * sine + z * cosine];
  if (axis === 1) return [x * cosine + z * sine, y, -x * sine + z * cosine];
  return [x * cosine - y * sine, x * sine + y * cosine, z];
}

function runSyntheticDeformationQa(samples) {
  const restPoints = samples.map((sample) => sample.position);
  const restBounds = boundsOf(restPoints);
  const scale = Math.max(restBounds.diagonal, 1);
  const poseAngles = [Math.PI / 18, -Math.PI / 14];
  let responsiveVertexCount = 0;
  let nonFiniteDeformedVertexCount = 0;
  let unstableDeformedVertexCount = 0;
  let maximumDisplacement = 0;
  const posedBoundsRatios = [];

  for (const [poseIndex, baseAngle] of poseAngles.entries()) {
    const posedPoints = [];
    for (const sample of samples) {
      const posed = [0, 0, 0];
      for (let influence = 0; influence < sample.weights.length; influence += 1) {
        const weight = sample.weights[influence];
        if (weight <= 0.0001) continue;
        const joint = sample.joints[influence];
        const axis = (joint + poseIndex) % 3;
        const direction = joint % 2 === 0 ? 1 : -1;
        const rotated = rotatePoint(sample.position, axis, baseAngle * direction * (1 + (joint % 5) * 0.08));
        const translation = ((joint % 7) - 3) * scale * 0.0015 * (poseIndex + 1);
        rotated[axis] += translation;
        posed[0] += rotated[0] * weight;
        posed[1] += rotated[1] * weight;
        posed[2] += rotated[2] * weight;
      }
      if (posed.some((value) => !Number.isFinite(value))) {
        nonFiniteDeformedVertexCount += 1;
        continue;
      }
      const displacement = Math.hypot(
        posed[0] - sample.position[0],
        posed[1] - sample.position[1],
        posed[2] - sample.position[2]
      );
      maximumDisplacement = Math.max(maximumDisplacement, displacement);
      if (poseIndex === 0 && displacement > scale * 1e-5) responsiveVertexCount += 1;
      if (displacement > scale * 4) unstableDeformedVertexCount += 1;
      posedPoints.push(posed);
    }
    if (posedPoints.length) {
      const posedBounds = boundsOf(posedPoints);
      const ratio = restBounds.diagonal > 1e-8 ? posedBounds.diagonal / restBounds.diagonal : 1;
      posedBoundsRatios.push(ratio);
      if (!Number.isFinite(ratio) || ratio < 0.05 || ratio > 20) unstableDeformedVertexCount += posedPoints.length;
    }
  }

  return {
    syntheticPoseCount: poseAngles.length,
    sampledVertexCount: samples.length,
    responsiveVertexCount,
    nonFiniteDeformedVertexCount,
    unstableDeformedVertexCount,
    maximumDisplacement,
    restBoundsDiagonal: restBounds.diagonal,
    posedBoundsRatios,
    passed: samples.length > 0
      && responsiveVertexCount > 0
      && nonFiniteDeformedVertexCount === 0
      && unstableDeformedVertexCount === 0
  };
}

function inspectRiggedGlbBuffer(buffer, options = {}) {
  const profile = String(options.profile || "humanoid").toLowerCase();
  const structural = inspectGlbBuffer(buffer);
  const errors = [...structural.errors];
  const warnings = [...structural.warnings];
  const parsed = parseGlbBuffer(buffer);
  if (!parsed.document || !parsed.binary) {
    return { ok: false, profile, errors: [...new Set([...errors, ...parsed.errors])], warnings, mapping: {}, metrics: structural.metrics || {}, deformationQa: { passed: false } };
  }
  const document = parsed.document;
  const binary = parsed.binary;
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  const skins = Array.isArray(document.skins) ? document.skins : [];
  const animations = Array.isArray(document.animations) ? document.animations : [];
  errors.push(...inspectNodeGraph(nodes));
  if (!skins.length) errors.push("The GLB contains no skin definition.");

  let weightedVertexCount = 0;
  let invalidWeightCount = 0;
  let invalidJointReferenceCount = 0;
  let inverseBindMatrixCount = 0;
  let maxInfluences = 0;
  const skinnedMeshes = new Set();
  const deformationSamples = [];

  for (const [skinIndex, skin] of skins.entries()) {
    const joints = Array.isArray(skin.joints) ? skin.joints : [];
    if (!joints.length) errors.push(`Skin ${skinIndex} has no joints.`);
    for (const joint of joints) if (!Number.isInteger(joint) || joint < 0 || joint >= nodes.length) errors.push(`Skin ${skinIndex} references invalid joint node ${joint}.`);
    if (!Number.isInteger(skin.inverseBindMatrices)) {
      errors.push(`Skin ${skinIndex} has no inverse-bind-matrix accessor.`);
    } else {
      try {
        const matrices = readAccessor(document, binary, skin.inverseBindMatrices);
        inverseBindMatrixCount += matrices.count;
        if (matrices.accessor.type !== "MAT4" || matrices.count !== joints.length) errors.push(`Skin ${skinIndex} inverse-bind-matrix count does not match its joint count.`);
        if (matrices.values.some((row) => row.some((value) => !Number.isFinite(value)))) errors.push(`Skin ${skinIndex} contains non-finite inverse bind matrices.`);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  for (const node of nodes) {
    if (!Number.isInteger(node?.mesh) || !Number.isInteger(node?.skin)) continue;
    skinnedMeshes.add(node.mesh);
    const skin = skins[node.skin];
    const jointCount = Array.isArray(skin?.joints) ? skin.joints.length : 0;
    for (const primitive of Array.isArray(meshes[node.mesh]?.primitives) ? meshes[node.mesh].primitives : []) {
      const attributes = primitive.attributes || {};
      if (!Number.isInteger(attributes.POSITION) || !Number.isInteger(attributes.JOINTS_0) || !Number.isInteger(attributes.WEIGHTS_0)) {
        errors.push(`Skinned mesh ${node.mesh} is missing POSITION, JOINTS_0, or WEIGHTS_0 attributes.`);
        continue;
      }
      try {
        const positions = readAccessor(document, binary, attributes.POSITION);
        const joints = readAccessor(document, binary, attributes.JOINTS_0);
        const weights = readAccessor(document, binary, attributes.WEIGHTS_0);
        if (positions.count !== joints.count || positions.count !== weights.count) errors.push(`Skinned mesh ${node.mesh} has mismatched position, joint, and weight counts.`);
        const count = Math.min(positions.count, joints.count, weights.count, Number(options.maxVertices || 250000));
        const sampledPositions = readAccessor(document, binary, attributes.POSITION, { limit: count }).values;
        const sampledJoints = readAccessor(document, binary, attributes.JOINTS_0, { limit: count }).values;
        const sampledWeights = readAccessor(document, binary, attributes.WEIGHTS_0, { limit: count }).values;
        for (let index = 0; index < count; index += 1) {
          const rowWeights = sampledWeights[index];
          const rowJoints = sampledJoints[index];
          const sum = rowWeights.reduce((total, value) => total + value, 0);
          const influences = rowWeights.filter((value) => value > 0.0001).length;
          maxInfluences = Math.max(maxInfluences, influences);
          if (!Number.isFinite(sum) || sum < 0.97 || sum > 1.03 || influences === 0) invalidWeightCount += 1;
          if (rowJoints.some((joint, componentIndex) => rowWeights[componentIndex] > 0.0001 && (!Number.isInteger(joint) || joint < 0 || joint >= jointCount))) invalidJointReferenceCount += 1;
          if (sampledPositions[index].every(Number.isFinite)) {
            deformationSamples.push({ position: sampledPositions[index], joints: rowJoints, weights: rowWeights });
          }
        }
        weightedVertexCount += count;
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  if (!skinnedMeshes.size) errors.push("No mesh node is bound to a skin.");
  if (!weightedVertexCount) errors.push("No weighted vertices were available for deformation QA.");
  if (invalidWeightCount) errors.push(`${invalidWeightCount} sampled vertices have missing or non-normalized skin weights.`);
  if (invalidJointReferenceCount) errors.push(`${invalidJointReferenceCount} sampled vertices reference joints outside their bound skin.`);
  const syntheticDeformation = runSyntheticDeformationQa(deformationSamples);
  if (!syntheticDeformation.passed) {
    errors.push("Synthetic deformation QA did not produce finite, bounded, responsive posed vertices.");
  }

  const aliases = profile === "vehicle" ? VEHICLE_ALIASES : profile === "creature" ? CREATURE_ALIASES : HUMANOID_ALIASES;
  const mapping = {
    ...mapSkeleton(nodes, aliases),
    ...(profile === "creature" ? mapSkeleton(nodes, CREATURE_OPTIONAL_ALIASES) : {})
  };
  const missingSemantics = Object.keys(aliases).filter((semantic) => !mapping[semantic]);
  if (missingSemantics.length) errors.push(`${profile === "vehicle" ? "Vehicle" : profile === "creature" ? "Creature" : "Humanoid"} skeleton mapping is missing: ${missingSemantics.join(", ")}.`);

  if (options.requireAnimation && !animations.length) errors.push("Deformation QA requires at least one animation clip in this artifact.");
  const deformationQa = {
    passed: weightedVertexCount > 0
      && invalidWeightCount === 0
      && invalidJointReferenceCount === 0
      && missingSemantics.length === 0
      && syntheticDeformation.passed
      && (!options.requireAnimation || animations.length > 0),
    mode: options.requireAnimation ? "animated-clip-plus-synthetic-poses" : "synthetic-pose-sampling",
    weightedVertexCount,
    invalidWeightCount,
    invalidJointReferenceCount,
    animationCount: animations.length,
    ...syntheticDeformation
  };
  return {
    ok: errors.length === 0,
    profile,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    mapping,
    missingSemantics,
    metrics: {
      ...structural.metrics,
      nodeCount: nodes.length,
      skinCount: skins.length,
      skinnedMeshCount: skinnedMeshes.size,
      inverseBindMatrixCount,
      weightedVertexCount,
      invalidWeightCount,
      invalidJointReferenceCount,
      maxInfluences,
      animationCount: animations.length
    },
    deformationQa
  };
}

module.exports = { inspectRiggedGlbBuffer, readAccessor, runSyntheticDeformationQa };
