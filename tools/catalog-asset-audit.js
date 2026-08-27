"use strict";

const fs = require("fs");
const path = require("path");
const { inspectGlbBuffer } = require("../engine/glb-inspector");
const { inspectRiggedGlbBuffer } = require("../engine/rig-inspector");

const ROOT = path.resolve(__dirname, "..");
const CATALOG = [
  { id: "five-wheeler", file: "public/assets/models/generated/five-wheeler.glb", profile: "vehicle" },
  { id: "transport-shuttle", file: "public/assets/models/generated/transport-shuttle.glb", profile: "vehicle" },
  { id: "e45-aircraft", file: "public/assets/models/generated/e45-aircraft-clean.glb", profile: "vehicle" },
  { id: "nathan-walking", file: "public/assets/models/generated/nathan-walking.glb", profile: "humanoid" },
  { id: "neck-mech-walker", file: "public/assets/models/generated/neck-mech-walker.glb", profile: "creature" },
  { id: "space-station-scene", file: "public/assets/models/generated/space-station-scene.glb", profile: null }
];

function auditAsset(item) {
  const absolutePath = path.join(ROOT, item.file);
  if (!fs.existsSync(absolutePath)) {
    return { ...item, sourceReady: false, rigReady: item.profile ? false : null, errors: ["Asset file is missing."] };
  }
  const buffer = fs.readFileSync(absolutePath);
  const source = inspectGlbBuffer(buffer);
  const rig = item.profile ? inspectRiggedGlbBuffer(buffer, { profile: item.profile }) : null;
  return {
    ...item,
    bytes: buffer.length,
    sourceReady: source.ok,
    rigReady: rig ? rig.ok : null,
    source: { metrics: source.metrics, errors: source.errors, warnings: source.warnings },
    rig: rig ? {
      profile: rig.profile,
      metrics: rig.metrics,
      missingSemantics: rig.missingSemantics,
      deformationQa: rig.deformationQa,
      errors: rig.errors,
      warnings: rig.warnings
    } : null
  };
}

function audit() {
  const assets = CATALOG.map(auditAsset);
  return {
    checkedAt: new Date().toISOString(),
    total: assets.length,
    sourceReady: assets.filter((item) => item.sourceReady).length,
    rigRequired: assets.filter((item) => item.profile).length,
    rigReady: assets.filter((item) => item.rigReady).length,
    assets
  };
}

function print(result) {
  console.log("\nComic30 real catalog audit");
  console.log("==========================");
  for (const item of result.assets) {
    const rig = item.rigReady === null ? "n/a" : String(item.rigReady);
    console.log(`${item.id.padEnd(22)} source=${String(item.sourceReady).padEnd(5)} rig=${rig.padEnd(5)} profile=${item.profile || "static"}`);
    if (item.source?.errors?.length) console.log(`  source: ${item.source.errors.join(" | ")}`);
    if (item.rig?.errors?.length) console.log(`  rig:    ${item.rig.errors.join(" | ")}`);
  }
  console.log(`\nRenderable source assets: ${result.sourceReady}/${result.total}`);
  console.log(`Rig-qualified assets:     ${result.rigReady}/${result.rigRequired}\n`);
}

if (require.main === module) {
  const result = audit();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else print(result);
  if (process.argv.includes("--strict") && (result.sourceReady !== result.total || result.rigReady !== result.rigRequired)) {
    process.exitCode = 2;
  }
}

module.exports = { audit, auditAsset, CATALOG };
