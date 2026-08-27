"use strict";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function parseGlbBuffer(buffer) {
  const errors = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
    return { ok: false, errors: ["The artifact is not a complete binary glTF file."], document: null, binary: null, version: null };
  }
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) errors.push("The GLB magic header is invalid.");
  const version = buffer.readUInt32LE(4);
  if (version !== 2) errors.push(`Unsupported glTF binary version ${version}; Comic30 requires GLB 2.0.`);
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength !== buffer.length) errors.push(`The GLB length header (${declaredLength}) does not match the artifact (${buffer.length}).`);

  let cursor = 12;
  let document = null;
  let binary = null;
  while (cursor + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(cursor);
    const type = buffer.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = start + length;
    if (end > buffer.length) {
      errors.push("A GLB chunk extends past the end of the artifact.");
      break;
    }
    if (type === JSON_CHUNK && !document) {
      try {
        document = JSON.parse(buffer.subarray(start, end).toString("utf8").replace(/[\u0000\u0020]+$/g, ""));
      } catch (error) {
        errors.push(`The glTF JSON chunk could not be parsed: ${error.message}`);
      }
    } else if (type === BINARY_CHUNK && !binary) {
      binary = buffer.subarray(start, end);
    }
    cursor = end;
  }
  if (!document) errors.push("The GLB does not contain a readable glTF JSON chunk.");
  return { ok: errors.length === 0, errors, document, binary, version };
}

function inspectGlbBuffer(buffer) {
  const errors = [];
  const warnings = [];
  const parsed = parseGlbBuffer(buffer);
  errors.push(...parsed.errors);
  const { document, version } = parsed;
  const binaryBytes = parsed.binary?.length || 0;
  if (errors.length || !document) return { ok: false, errors, warnings, metrics: { version, byteLength: buffer?.length || 0 } };

  const accessors = Array.isArray(document.accessors) ? document.accessors : [];
  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  const materials = Array.isArray(document.materials) ? document.materials : [];
  const textures = Array.isArray(document.textures) ? document.textures : [];
  const images = Array.isArray(document.images) ? document.images : [];
  const skins = Array.isArray(document.skins) ? document.skins : [];
  const animations = Array.isArray(document.animations) ? document.animations : [];
  let primitiveCount = 0;
  let vertexCount = 0;
  let primitivesWithNormals = 0;
  let primitivesWithUv = 0;
  let primitivesWithTangents = 0;
  let primitivesWithMaterial = 0;

  for (const mesh of meshes) {
    for (const primitive of Array.isArray(mesh.primitives) ? mesh.primitives : []) {
      primitiveCount += 1;
      const attributes = primitive.attributes || {};
      const positionIndex = integer(attributes.POSITION);
      if (positionIndex !== null) vertexCount += Number(accessors[positionIndex]?.count || 0);
      if (integer(attributes.NORMAL) !== null) primitivesWithNormals += 1;
      if (integer(attributes.TEXCOORD_0) !== null) primitivesWithUv += 1;
      if (integer(attributes.TANGENT) !== null) primitivesWithTangents += 1;
      if (integer(primitive.material) !== null) primitivesWithMaterial += 1;
    }
  }

  const pbrMaterialCount = materials.filter((material) => material?.pbrMetallicRoughness).length;
  if (!meshes.length || !primitiveCount || !vertexCount) errors.push("No renderable mesh vertices were found.");
  if (primitiveCount && primitivesWithNormals !== primitiveCount) errors.push("Every mesh primitive must provide vertex normals.");
  if (primitiveCount && primitivesWithUv !== primitiveCount) errors.push("Every mesh primitive must provide TEXCOORD_0 UVs.");
  if (primitiveCount && primitivesWithMaterial !== primitiveCount) errors.push("Every mesh primitive must reference a material.");
  if (!pbrMaterialCount) errors.push("No metallic-roughness PBR material was found.");
  if (!textures.length || !images.length) errors.push("No texture image is embedded or referenced by the asset.");
  if (primitiveCount && primitivesWithTangents !== primitiveCount) warnings.push("One or more primitives omit tangents; Unreal may regenerate them during import.");
  if (!binaryBytes) warnings.push("The GLB has no binary buffer chunk; verify that external buffers remain available.");

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      version,
      byteLength: buffer.length,
      binaryBytes,
      meshCount: meshes.length,
      primitiveCount,
      vertexCount,
      materialCount: materials.length,
      pbrMaterialCount,
      textureCount: textures.length,
      imageCount: images.length,
      skinCount: skins.length,
      animationCount: animations.length,
      normalsCoverage: primitiveCount ? primitivesWithNormals / primitiveCount : 0,
      uvCoverage: primitiveCount ? primitivesWithUv / primitiveCount : 0,
      materialCoverage: primitiveCount ? primitivesWithMaterial / primitiveCount : 0
    }
  };
}

module.exports = { inspectGlbBuffer, parseGlbBuffer };
