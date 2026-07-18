const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const envPath = process.argv[2];
const ffmpegPath = process.argv[3];
const outputRoot = process.argv[4] || path.join(repoRoot, ".media-upload");
const bucket = "comic30-media";
const maxBytes = 49 * 1024 * 1024;

if (envPath && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    process.env[match[1]] = value;
  }
}

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const uploadToken = process.env.MEDIA_UPLOAD_TOKEN;
const ticketBaseUrl = String(process.env.MEDIA_UPLOAD_SITE || "https://www.comic30.com").replace(/\/$/, "");
if ((!supabaseUrl || !serviceKey) && !uploadToken) throw new Error("Supabase credentials or MEDIA_UPLOAD_TOKEN are required.");

const assets = [
  "assets/models/generated/e45-aircraft-clean.glb",
  "assets/models/generated/five-wheeler.glb",
  "assets/models/generated/neck-mech-walker.glb",
  "assets/models/generated/space-station-scene.glb",
  "assets/models/generated/transport-shuttle.glb",
  "assets/videos/user/mobile-gameplay-export.mp4",
  "assets/videos/user/mobile-gameplay-rewards.mp4",
  "assets/videos/user/robot-branching-logic.mp4",
  "assets/videos/user/robot-run-candidate-a.mp4",
  "assets/videos/user/robot-section-background.mp4",
  "assets/videos/user/space-game-battle.mp4",
  "assets/videos/user/space-game-character.mp4",
  "assets/videos/user/space-game-hero.mp4",
  "assets/videos/user/space-game-launch.mp4",
  "assets/videos/user/space-game-portal.mp4",
  "assets/videos/user/space-game-terrain.mp4",
  "assets/videos/user/space-game-world.mp4"
];

function mimeType(name) {
  if (name.endsWith(".glb")) return "model/gltf-binary";
  if (name.endsWith(".webm")) return "video/webm";
  return "video/mp4";
}

function optimizedSource(relativePath) {
  const source = path.join(repoRoot, "public", relativePath);
  if (!fs.existsSync(source)) throw new Error(`Missing local media: ${relativePath}`);
  if (!relativePath.endsWith(".mp4") || fs.statSync(source).size <= maxBytes) return source;
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error(`FFmpeg is required for ${relativePath}`);

  const target = path.join(outputRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const crf of [27, 30, 33, 36]) {
    console.log(`Optimizing ${relativePath} (CRF ${crf})`);
    const result = spawnSync(ffmpegPath, [
      "-y", "-i", source,
      "-vf", "scale='min(1280,iw)':-2",
      "-c:v", "libx264", "-preset", "medium", "-crf", String(crf),
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", target
    ], { stdio: "inherit", timeout: 30 * 60 * 1000 });
    if (result.status !== 0) throw new Error(`FFmpeg failed for ${relativePath}`);
    if (fs.statSync(target).size <= maxBytes) return target;
  }
  throw new Error(`Unable to optimize ${relativePath} below 49 MB.`);
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response;
}

async function main() {
  const headers = serviceKey ? { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } : null;
  if (headers) {
    const existing = await fetch(`${supabaseUrl}/storage/v1/bucket/${bucket}`, { headers });
    const bucketBody = {
      id: bucket,
      name: bucket,
      public: true,
      file_size_limit: 52_428_800,
      allowed_mime_types: ["video/mp4", "video/webm", "model/gltf-binary"]
    };
    if (existing.ok) {
      await request(`${supabaseUrl}/storage/v1/bucket/${bucket}`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(bucketBody)
      });
    } else {
      await request(`${supabaseUrl}/storage/v1/bucket`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(bucketBody)
      });
    }
  }

  for (const relativePath of assets) {
    const source = optimizedSource(relativePath);
    const bytes = fs.readFileSync(source);
    console.log(`Uploading ${relativePath} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    if (headers) {
      await request(`${supabaseUrl}/storage/v1/object/${bucket}/${relativePath.split("/").map(encodeURIComponent).join("/")}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": mimeType(relativePath), "x-upsert": "true", "Cache-Control": "public, max-age=31536000" },
        body: bytes
      });
    } else {
      const ticketResponse = await request(`${ticketBaseUrl}/api/media/upload-ticket`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: relativePath, contentType: mimeType(relativePath) })
      });
      const ticket = await ticketResponse.json();
      const signedPath = ticket.signedUrl || ticket.url;
      if (!signedPath) throw new Error(`Upload ticket did not include a signed URL for ${relativePath}`);
      const signedUrl = /^https?:/i.test(signedPath) ? signedPath : `${ticket.storageBaseUrl}/storage/v1${signedPath}`;
      await request(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": mimeType(relativePath), "x-upsert": "true", "Cache-Control": "public, max-age=31536000" },
        body: bytes
      });
    }
  }
  console.log(`Published ${assets.length} Comic30 media assets.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
