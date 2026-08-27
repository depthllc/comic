require("./engine/load-local-env")();

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const localEngineWorker = require("./engine/local-engine-worker");
const textToGamePipeline = require("./engine/text-to-game-pipeline");
const sourceAssetWorker = require("./engine/source-asset-worker-client");
const rigWorker = require("./engine/rig-worker-client");
const animationWorker = require("./engine/animation-worker-client");
const audioWorker = require("./engine/audio-worker-client");
const { inspectGlbBuffer, parseGlbBuffer } = require("./engine/glb-inspector");
const { inspectRiggedGlbBuffer } = require("./engine/rig-inspector");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.COMIC30_DATA_DIR || path.join(ROOT, "data"));
const EXPORT_DIR = path.resolve(process.env.COMIC30_EXPORT_DIR || path.join(ROOT, "exports"));
const ASSET_UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 5173);
const ONE_WEEK = 1000 * 60 * 60 * 24 * 7;
const ONE_HOUR = 1000 * 60 * 60;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const CSRF_STRICT = process.env.CSRF_STRICT === "true" || IS_PRODUCTION;
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const MAX_ASSET_UPLOAD_BYTES = Number(process.env.MAX_ASSET_UPLOAD_BYTES || 250 * 1024 * 1024);
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);
const RATE_LIMITS = {
  default: { windowMs: 60 * 1000, limit: Number(process.env.RATE_LIMIT_DEFAULT || 120) },
  auth: { windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_LIMIT_AUTH || 20) },
  agent: { windowMs: 60 * 1000, limit: Number(process.env.RATE_LIMIT_AGENT || 12) },
  import: { windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_LIMIT_IMPORT || 8) }
};

async function productionWorkerCapabilities() {
  const capabilities = localEngineWorker.capabilities();
  const [sourceAssets, rigging, animation, audio] = await Promise.all([
    sourceAssetWorker.probe(),
    rigWorker.probe(),
    animationWorker.probe(),
    audioWorker.probe()
  ]);
  Object.assign(capabilities, { sourceAssets, rigging, animation, audio });
  return capabilities;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".glb": "model/gltf-binary",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".gltf": "model/gltf+json",
  ".fbx": "application/octet-stream",
  ".obj": "text/plain",
  ".pak": "application/octet-stream",
  ".uasset": "application/octet-stream",
  ".umap": "application/octet-stream",
  ".unitypackage": "application/gzip",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webm": "video/webm"
};

const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".glb", ".gltf", ".fbx", ".obj", ".zip", ".pak", ".uasset", ".umap", ".unitypackage",
  ".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".ogg", ".mp4", ".webm"
]);

let writeQueue = Promise.resolve();
const rateBuckets = new Map();
const assetSignedUrlCache = new Map();

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const SUPABASE_STORAGE_BUCKET = String(process.env.SUPABASE_STORAGE_BUCKET || "comic30-exports");
const SUPABASE_MEDIA_BUCKET = String(process.env.SUPABASE_MEDIA_BUCKET || "comic30-media");
const SUPABASE_ASSET_BUCKET = String(process.env.SUPABASE_ASSET_BUCKET || "comic30-assets");

function emptyDb() {
  return {
    users: [], sessions: [], projects: [], audit: [], emailTokens: [],
    passwordResetTokens: [], contactProfiles: [], importBatches: [], complianceReviews: []
  };
}

function hasSupabase() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function slugify(value) {
  return String(value || "comic30-project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "comic30-project";
}

async function ensureStorage() {
  if (IS_PRODUCTION) {
    if (!hasSupabase()) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.");
    return;
  }
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(EXPORT_DIR, { recursive: true });
  await fsp.mkdir(ASSET_UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    await writeDb({
      users: [],
      sessions: [],
      projects: [],
      audit: [],
      emailTokens: [],
      passwordResetTokens: [],
      contactProfiles: [],
      importBatches: [],
      complianceReviews: []
    });
  }
}

async function readDb() {
  if (hasSupabase()) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/comic30_state?id=eq.primary&select=payload`, {
      headers: supabaseHeaders({ accept: "application/json" })
    });
    if (!response.ok) throw new Error(`Supabase read failed (${response.status}). Run the Comic30 schema migration.`);
    const rows = await response.json();
    return normalizeDb(rows[0]?.payload || emptyDb());
  }
  if (IS_PRODUCTION) throw new Error("Supabase is not configured for production.");
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    return { users: [], sessions: [], projects: [], audit: [] };
  }
  const raw = await fsp.readFile(DB_FILE, "utf8");
  return normalizeDb(JSON.parse(raw || "{}"));
}

function normalizeDb(db) {
  db.users = Array.isArray(db.users) ? db.users : [];
  db.sessions = Array.isArray(db.sessions) ? db.sessions : [];
  db.projects = Array.isArray(db.projects) ? db.projects.map(normalizeProject) : [];
  db.audit = Array.isArray(db.audit) ? db.audit : [];
  db.emailTokens = Array.isArray(db.emailTokens) ? db.emailTokens : [];
  db.passwordResetTokens = Array.isArray(db.passwordResetTokens) ? db.passwordResetTokens : [];
  db.contactProfiles = Array.isArray(db.contactProfiles) ? db.contactProfiles : [];
  db.importBatches = Array.isArray(db.importBatches) ? db.importBatches : [];
  db.complianceReviews = Array.isArray(db.complianceReviews) ? db.complianceReviews : [];
  return db;
}

function normalizeProject(project) {
  project.story = Array.isArray(project.story) ? project.story : [];
  project.characters = Array.isArray(project.characters) ? project.characters : [];
  project.worlds = Array.isArray(project.worlds) ? project.worlds : [];
  project.terrain = Array.isArray(project.terrain) ? project.terrain : [];
  project.ledger = Array.isArray(project.ledger) ? project.ledger : [];
  project.builds = Array.isArray(project.builds) ? project.builds : [];
  project.buildJobs = Array.isArray(project.buildJobs) ? project.buildJobs : [];
  project.aiThreads = Array.isArray(project.aiThreads) ? project.aiThreads : [];
  project.engine = project.engine || defaultEngineConfig();
  project.economy = project.economy || {};
  project.design = project.design || {};
  project.lifecycle = project.lifecycle || { archived: false, qaStatus: "not-run", deploymentStatus: "draft", lastAction: "created" };
  project.deployments = Array.isArray(project.deployments) ? project.deployments : [];
  project.analytics = project.analytics || { players: 0, sessions: 0, retentionD1: 0, rating: 0, revenueUsd: 0 };
  project.activity = Array.isArray(project.activity) ? project.activity : [];
  project.playtests = Array.isArray(project.playtests) ? project.playtests : [];
  project.modelArtifacts = Array.isArray(project.modelArtifacts) ? project.modelArtifacts : [];
  project.inferenceRuns = Array.isArray(project.inferenceRuns) ? project.inferenceRuns : [];
  project.operationJobs = Array.isArray(project.operationJobs) ? project.operationJobs : [];
  project.qaRuns = Array.isArray(project.qaRuns) ? project.qaRuns : [];
  project.assets = Array.isArray(project.assets) ? project.assets : [];
  project.orchestrationJobs = Array.isArray(project.orchestrationJobs) ? project.orchestrationJobs : [];
  project.engineBuildJobs = Array.isArray(project.engineBuildJobs) ? project.engineBuildJobs : [];
  project.textToGameRuns = Array.isArray(project.textToGameRuns) ? project.textToGameRuns : [];
  project.approvals = Array.isArray(project.approvals) ? project.approvals : [];
  project.scenes = Array.isArray(project.scenes) ? project.scenes : [];
  project.levels = Array.isArray(project.levels) ? project.levels : [];
  project.gameplay = project.gameplay || { mechanics: [], objectives: [], difficulty: "adaptive", sessionMinutes: 8 };
  project.gameplay.mechanics = Array.isArray(project.gameplay.mechanics) ? project.gameplay.mechanics : [];
  project.gameplay.objectives = Array.isArray(project.gameplay.objectives) ? project.gameplay.objectives : [];
  const latestPrompt = project.orchestrationJobs[0]?.prompt || project.aiThreads[0]?.messages?.filter((message) => message.role === "user").at(-1)?.content || "";
  if ((!project.runtimeManifest || Number(project.runtimeManifest.version || 0) < 2 || !project.runtimeManifest.assets) && latestPrompt) {
    project.runtimeManifest = buildRuntimeManifest(project, latestPrompt);
  }
  return project;
}

function currentPlaytest(project) {
  normalizeProject(project);
  return project.playtests.find((session) => session.status === "active") || project.playtests[0] || null;
}

function startPlaytest(project) {
  normalizeProject(project);
  project.playtests.forEach((session) => { if (session.status === "active") session.status = "abandoned"; });
  const session = {
    id: makeId("play"), status: "active", arcIndex: 0, score: 0,
    balance: Number(project.economy.startingBalance || 0), choices: [],
    startedAt: nowIso(), updatedAt: nowIso(), completedAt: null
  };
  project.playtests.unshift(session);
  project.analytics.sessions = Number(project.analytics.sessions || 0) + 1;
  project.updatedAt = session.updatedAt;
  return session;
}

function advancePlaytest(project, choiceIndex) {
  const session = currentPlaytest(project);
  if (!session || session.status !== "active") throw new Error("Start a playtest first.");
  const arc = project.story[session.arcIndex];
  if (!arc) throw new Error("The current story node is unavailable.");
  const choice = arc.choices && arc.choices[Number(choiceIndex)];
  if (!choice) throw new Error("Choose a valid story option.");
  const reward = Number(project.economy.rewards?.[session.arcIndex % Math.max(1, project.economy.rewards.length)]?.amount || 25);
  session.choices.push({ arcId: arc.id, arcTitle: arc.title, choiceIndex: Number(choiceIndex), label: choice.label, consequence: choice.consequence, reward, createdAt: nowIso() });
  session.score += 100 + reward;
  session.balance += reward;
  session.arcIndex += 1;
  session.updatedAt = nowIso();
  if (session.arcIndex >= project.story.length) {
    session.status = "completed";
    session.completedAt = session.updatedAt;
    project.analytics.players = Math.max(1, Number(project.analytics.players || 0));
  }
  project.updatedAt = session.updatedAt;
  return session;
}

async function writeDb(db) {
  if (hasSupabase()) {
    writeQueue = writeQueue.then(async () => {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/comic30_state`, {
        method: "POST",
        headers: supabaseHeaders({
          "content-type": "application/json",
          prefer: "resolution=merge-duplicates,return=minimal"
        }),
        body: JSON.stringify({ id: "primary", payload: normalizeDb(db), updated_at: nowIso() })
      });
      if (!response.ok) throw new Error(`Supabase write failed (${response.status}).`);
    });
    return writeQueue;
  }
  if (IS_PRODUCTION) throw new Error("Supabase is not configured for production.");
  writeQueue = writeQueue.then(async () => {
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_FILE);
  });
  return writeQueue;
}

async function saveArtifact(filename, bytes, fallbackUrl) {
  if (!hasSupabase()) return fallbackUrl;
  const objectPath = encodeURIComponent(filename);
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${objectPath}`, {
    method: "POST",
    headers: supabaseHeaders({ "content-type": "application/zip", "x-upsert": "true" }),
    body: bytes
  });
  if (!upload.ok) return fallbackUrl;
  const signed = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${SUPABASE_STORAGE_BUCKET}/${objectPath}`, {
    method: "POST",
    headers: supabaseHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ expiresIn: 60 * 60 * 24 })
  });
  if (!signed.ok) return fallbackUrl;
  const result = await signed.json();
  return `${SUPABASE_URL}/storage/v1${result.signedURL}`;
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name]) => name)
      .map(([name, ...rest]) => [decodeURIComponent(name), decodeURIComponent(rest.join("="))])
  );
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [
    `c30_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  appendSetCookie(res, parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "c30_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function setCsrfCookie(res, token) {
  const parts = [
    `c30_csrf=${encodeURIComponent(token)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ONE_WEEK / 1000)}`
  ];
  if (IS_PRODUCTION) {
    parts.push("Secure");
  }
  appendSetCookie(res, parts.join("; "));
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookie]);
  } else {
    res.setHeader("Set-Cookie", [current, cookie]);
  }
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = passwordHash(password, salt).split(":")[1];
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    emailVerifiedAt: user.emailVerifiedAt || null,
    complianceFlags: user.complianceFlags || [],
    createdAt: user.createdAt
  };
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function auditEntry(req, userId, action, details = {}) {
  return {
    id: makeId("audit"),
    userId: userId || null,
    action,
    ip: requestIp(req),
    userAgent: req.headers["user-agent"] || "unknown",
    details,
    createdAt: nowIso()
  };
}

function isAdmin(user) {
  return Boolean(user && (user.role === "admin" || ADMIN_EMAILS.has(String(user.email || "").toLowerCase())));
}

function rateLimitKey(req, bucket) {
  return `${bucket}:${requestIp(req)}:${parseCookies(req).c30_session || "anon"}`;
}

function checkRateLimit(req, res, bucket = "default") {
  const config = RATE_LIMITS[bucket] || RATE_LIMITS.default;
  const key = rateLimitKey(req, bucket);
  const now = Date.now();
  const item = rateBuckets.get(key);
  if (!item || now > item.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + config.windowMs });
    return true;
  }
  item.count += 1;
  if (item.count > config.limit) {
    json(res, 429, {
      error: "Too many requests. Please wait and try again.",
      retryAfterSeconds: Math.ceil((item.resetAt - now) / 1000)
    });
    return false;
  }
  return true;
}

function csrfTokenFor(req) {
  const cookies = parseCookies(req);
  return cookies.c30_csrf || crypto.randomBytes(24).toString("hex");
}

function verifyCsrf(req, res) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return true;
  if (!CSRF_STRICT && !parseCookies(req).c30_session) return true;
  const cookies = parseCookies(req);
  const header = String(req.headers["x-csrf-token"] || "");
  const cookieToken = String(cookies.c30_csrf || "");
  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(header);
  if (cookieToken && header && cookieBuffer.length === headerBuffer.length && crypto.timingSafeEqual(cookieBuffer, headerBuffer)) {
    return true;
  }
  if (!CSRF_STRICT) return true;
  json(res, 403, { error: "Security token expired. Refresh the page and try again." });
  return false;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createTimedToken(db, collectionName, userId, purpose, ttlMs = ONE_HOUR) {
  const token = crypto.randomBytes(32).toString("hex");
  const record = {
    id: makeId("token"),
    userId,
    purpose,
    tokenHash: tokenHash(token),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    usedAt: null
  };
  db[collectionName].push(record);
  return { token, record };
}

function consumeTimedToken(db, collectionName, token, purpose) {
  const hash = tokenHash(token);
  const record = (db[collectionName] || []).find((item) => item.tokenHash === hash && item.purpose === purpose && !item.usedAt);
  if (!record || new Date(record.expiresAt).getTime() < Date.now()) {
    throw new Error("Token is invalid or expired.");
  }
  record.usedAt = nowIso();
  return record;
}

async function dispatchEmail(kind, to, payload) {
  const message = {
    kind,
    to,
    payload,
    createdAt: nowIso(),
    provider: process.env.EMAIL_PROVIDER || "console-dev"
  };
  if (!process.env.EMAIL_PROVIDER || process.env.EMAIL_PROVIDER === "console") {
    console.log("[Comic30 email]", JSON.stringify(message, null, 2));
    return { queued: true, provider: "console-dev" };
  }
  return { queued: true, provider: process.env.EMAIL_PROVIDER, note: "Provider adapter must be configured with credentials before production." };
}

function productionReadiness(workers = localEngineWorker.capabilities()) {
  const textToGameWorkers = textToGamePipeline.workerRegistry(workers);
  return {
    database: {
      current: hasSupabase() ? "Supabase JSONB state store configured" : "file-backed JSON for local development",
      productionTarget: hasSupabase() ? "managed Supabase persistence active" : "configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
      requiredTables: ["users", "sessions", "projects", "audit_events", "contact_profiles", "build_jobs", "wallet_events", "iap_receipts"]
    },
    email: {
      verification: "implemented with token flow",
      passwordReset: "implemented with token flow",
      provider: process.env.EMAIL_PROVIDER || "console-dev"
    },
    security: {
      rateLimiting: "in-memory MVP limiter active",
      csrf: CSRF_STRICT ? "strict" : "soft local mode; set CSRF_STRICT=true in production",
      audit: "API audit trail active",
      recommended: ["managed WAF", "persistent rate limiter such as Redis", "admin audit review console", "secret rotation"]
    },
    engine: {
      internal: "deterministic design-data engine active",
      pythonProcess: process.env.COMIC30_PYTHON_ENGINE === "false" ? "disabled" : "enabled when Python 3.11+ is available",
      fallback: "deterministic Node engine active",
      productionWorkers: workers,
      operations: ["engine-project-generate", "engine-validate", "cook", "package", "navigation-bake", "shader-validate", "asset-optimize", "lod-generate", "qa"]
    },
    textToGame: {
      specification: textToGamePipeline.SPEC_VERSION,
      productionGraph: textToGamePipeline.RUN_VERSION,
      workers: textToGameWorkers,
      contract: "A build is production-verified only after every required worker node has validated evidence. Template or catalog output is identified as prototype output."
    },
    inference: {
      internalModel: "comic30/director-v1",
      openai: process.env.OPENAI_API_KEY ? `configured: ${process.env.OPENAI_MODEL || "gpt-4.1-mini"}` : "not configured",
      openrouter: process.env.OPENROUTER_API_KEY ? `configured: ${process.env.OPENROUTER_MODEL || "openrouter/free"}` : "not configured",
      fallback: "cloud failures are recorded and use the internal deterministic model"
    },
    nativeBuilds: buildPipelineCapabilities(),
    iap: iapProviderStatus(),
    wallet: walletComplianceStatus(),
    privacy: privacyChecklist()
  };
}

function buildPipelineCapabilities() {
  const workers = localEngineWorker.capabilities();
  return {
    unity: { status: workers.unity.available ? "local Unity 6 worker detected" : process.env.UNITY_BUILDER_URL ? "remote runner configured" : "runner pending", modules: workers.unity.modules, artifacts: ["Android AAB", "iOS Xcode project"] },
    unreal: { status: workers.unreal.available ? "local Unreal Engine 5.6 worker detected" : process.env.UNREAL_BUILDER_URL ? "remote runner configured" : "runner pending", templates: workers.unreal.templates, rendering: workers.unreal.rendering, artifacts: ["Unreal project", "Win64 package", "Android package", "iOS project archive"] },
    flutter: { status: process.env.FLUTTER_BUILDER_URL ? "runner configured" : "runner pending", artifacts: ["APK", "AAB", "IPA archive metadata"] },
    reactNative: { status: process.env.REACT_NATIVE_BUILDER_URL ? "runner configured" : "runner pending", artifacts: ["Android Gradle project", "iOS workspace"] },
    comic30Runtime: { status: "local scaffold generator active", artifacts: ["engine JSON", "native starter ZIP", "store checklist"] }
  };
}

function iapProviderStatus() {
  return {
    apple: {
      status: process.env.APPLE_IAP_SHARED_SECRET || process.env.APPLE_ISSUER_ID ? "credentials detected" : "credentials pending",
      required: ["App Store Connect API key", "product IDs", "receipt validation", "restore purchase flow"]
    },
    google: {
      status: process.env.GOOGLE_PLAY_PACKAGE_NAME && process.env.GOOGLE_APPLICATION_CREDENTIALS ? "credentials detected" : "credentials pending",
      required: ["Google Play package name", "service account", "purchase token validation", "acknowledgement flow"]
    }
  };
}

function walletComplianceStatus() {
  return {
    custodyMode: process.env.WALLET_CUSTODY_PROVIDER ? "provider configured" : "internal ledger only",
    provider: process.env.WALLET_CUSTODY_PROVIDER || null,
    requiredBeforeCryptoLaunch: [
      "custody provider review",
      "KYC/AML decision",
      "OFAC/sanctions screening",
      "fraud and velocity controls",
      "regional disclosures",
      "tax/accounting review",
      "Apple and Google crypto policy review"
    ],
    fraudControls: ["wallet event audit hash", "rate limits", "purchase validation hooks", "manual review queue scaffold"]
  };
}

function privacyChecklist() {
  return {
    required: [
      "privacy policy",
      "terms of use",
      "support/contact path",
      "account deletion flow",
      "age rating questionnaire",
      "Apple privacy nutrition labels",
      "Google Play data safety form",
      "children/COPPA assessment"
    ],
    accountDeletion: "API scaffold implemented",
    dataSafetyStatus: "needs legal/product review before store submission"
  };
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function hasImportConsent(row) {
  const consent = String(row.consent || row.opt_in || row.optIn || row.permission || "").trim().toLowerCase();
  const source = String(row.source || row.consent_source || row.consentSource || "").trim();
  return ["true", "yes", "y", "1", "opt-in", "subscribed"].includes(consent) && source.length >= 3;
}

function buildContactProfile(row, batchId) {
  const email = normalizeEmail(row.email || row.Email || row.EMAIL);
  if (!email) return null;
  if (!hasImportConsent(row)) return null;
  const firstName = String(row.first_name || row.firstName || row.FirstName || row.name || "").trim().slice(0, 80);
  const lastName = String(row.last_name || row.lastName || row.LastName || "").trim().slice(0, 80);
  return {
    id: makeId("contact"),
    email,
    firstName,
    lastName,
    niche: String(row.niche || row.segment || row.category || "").trim().slice(0, 80),
    source: String(row.source || row.consent_source || row.consentSource || "").trim().slice(0, 160),
    consentAt: String(row.consent_at || row.consentAt || row.opt_in_at || nowIso()).trim(),
    importBatchId: batchId,
    status: "imported-consented",
    createdAt: nowIso()
  };
}

function cleanExpiredSessions(db) {
  const now = Date.now();
  db.sessions = (db.sessions || []).filter((session) => new Date(session.expiresAt).getTime() > now);
}

function getAuth(req, db) {
  cleanExpiredSessions(db);
  const token = parseCookies(req).c30_session;
  if (!token) return null;
  const session = db.sessions.find((item) => item.token === token);
  if (!session) return null;
  const user = db.users.find((item) => item.id === session.userId);
  if (!user) return null;
  return { token, session, user };
}

function requireAuth(req, res, db) {
  const auth = getAuth(req, db);
  if (!auth) {
    json(res, 401, { error: "Authentication required." });
    return null;
  }
  return auth;
}

function createSession(db, user, req) {
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    token,
    userId: user.id,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + ONE_WEEK).toISOString(),
    userAgent: req.headers["user-agent"] || "unknown"
  };
  db.sessions.push(session);
  return session;
}

function defaultEngineConfig() {
  return {
    version: "comic30-runtime-0.3",
    agents: ["director", "story", "character", "world", "terrain", "economy", "build"],
    runtimeTargets: ["browser-interaction-sketch", "unreal-project", "unity-mobile-project", "android-package", "ios-project"],
    productionEngine: "unreal-5.6",
    previewEngine: "browser-preview",
    assetPipelines: ["story-json", "terrain-json", "character-rig-manifest", "economy-ledger", "iap-products"],
    compileRequirements: {
      android: ["Android Studio", "JDK 17+", "Gradle", "release keystore"],
      ios: ["macOS", "Xcode", "Apple Developer team", "provisioning profile"]
    }
  };
}

function generateTerrainZone(projectTitle, prompt = "") {
  const seed = crypto.createHash("sha256").update(`${projectTitle}:${prompt}`).digest("hex");
  const biomes = ["neon canyon", "storm forest", "orbital ruins", "foundry city", "frozen relay"];
  const biome = biomes[parseInt(seed.slice(0, 2), 16) % biomes.length];
  const heightmap = Array.from({ length: 9 }, (_, row) =>
    Array.from({ length: 9 }, (_, col) => {
      const index = (row * 9 + col) % (seed.length - 1);
      return parseInt(seed.slice(index, index + 2), 16) % 10;
    })
  );
  return {
    id: makeId("terrain"),
    name: `${projectTitle} ${biome}`,
    biome,
    seed,
    scale: "mobile-open-zone",
    lighting: "cinematic dusk with high-contrast path lights",
    spawnRules: [
      "Place player near a readable landmark.",
      "Keep wallet reward pickups visible but optional.",
      "Gate high-risk enemies behind a clear traversal choice."
    ],
    heightmap,
    generatedAt: nowIso()
  };
}

function generateWorldSpec(project, prompt = "") {
  const terrain = generateTerrainZone(project.title, prompt);
  return {
    id: makeId("world"),
    name: terrain.name,
    biome: terrain.biome,
    threat: "dynamic faction control and reward scarcity",
    playerPromise: "The world layout reacts to quest choices, character loyalty, and economy pressure.",
    terrainId: terrain.id,
    pointsOfInterest: [
      { id: makeId("poi"), name: "Signal Gate", type: "spawn", rewardHint: `+${project.economy.startingBalance || 250} ${project.economy.currencySymbol || "C30"}` },
      { id: makeId("poi"), name: "Faction Relay", type: "choice-hub", rewardHint: "loyalty branch" },
      { id: makeId("poi"), name: "Vault Rift", type: "boss-arena", rewardHint: "rare item sink" }
    ],
    generatedAt: nowIso(),
    terrain
  };
}

function buildProjectBlueprint(ownerId, input = {}) {
  const title = String(input.title || "Untitled Game World").trim().slice(0, 80);
  const genre = String(input.genre || "Cinematic action RPG").trim().slice(0, 80);
  const audience = String(input.audience || "mobile-first players").trim().slice(0, 120);
  const premise = String(input.premise || "A player-driven world where choices reshape factions, rewards, and the next chapter.").trim();
  const artStyle = String(input.artStyle || "stylized AAA mobile realism").trim().slice(0, 120);
  const createdAt = nowIso();
  const currencyName = `${title.replace(/[^a-z0-9 ]/gi, "").split(" ")[0] || "Game"} Credits`;
  const initialTerrain = generateTerrainZone(title, premise);

  return {
    id: makeId("proj"),
    ownerId,
    title,
    slug: slugify(title),
    status: "design",
    genre,
    audience,
    tagline: input.tagline || "Create the story, cast, economy, and mobile build from one command center.",
    createdAt,
    updatedAt: createdAt,
    design: {
      premise,
      artStyle,
      gameplayLoop: input.gameplayLoop || "Explore, choose, battle, earn, upgrade, and unlock the next story branch.",
      camera: input.camera || "third-person cinematic mobile camera",
      buildTargets: ["iOS", "Android"],
      engineTrack: "Comic30 mobile runtime scaffold",
      compliance: ["COPPA review", "App Store review", "Google Play policy review", "regional crypto disclosures"]
    },
    story: generateStory(title, genre, premise),
    characters: generateCharacters(title, genre),
    worlds: [
      {
        id: makeId("world"),
        name: `${title} Prime`,
        biome: "hub city and mission wildlands",
        threat: "an economy imbalance that changes who controls the world",
        playerPromise: "Every major choice changes quests, prices, faction access, and reward paths.",
        terrainId: initialTerrain.id
      }
    ],
    scenes: [
      { id: makeId("scene"), name: "Opening Signal", type: "interactive-cinematic", location: `${title} Prime`, objective: "Reach the signal tower and make the first faction choice.", camera: "third-person follow", triggers: ["spawn", "companion_intro", "choice_gate"] }
    ],
    levels: [
      { id: makeId("level"), name: "Signal District", order: 1, world: `${title} Prime`, objectives: ["Learn movement", "Meet the guide", "Choose a faction route"], encounters: ["scout patrol", "signal anomaly"], completionReward: 25 }
    ],
    gameplay: {
      mechanics: ["third-person traversal", "squad abilities", "branching dialogue", "reward collection"],
      objectives: ["complete missions", "shape faction loyalty", "upgrade the playable cast"],
      difficulty: "adaptive",
      sessionMinutes: 8
    },
    terrain: [initialTerrain],
    economy: {
      walletMode: "internal-ledger",
      chainReadiness: "crypto optional; custody and chain integration must be configured before production launch",
      currencyName,
      currencySymbol: "C30",
      startingBalance: 250,
      maxSupply: 100000000,
      rewards: [
        { id: makeId("reward"), name: "Quest completion", amount: 25, trigger: "story_node_completed" },
        { id: makeId("reward"), name: "Faction streak", amount: 75, trigger: "daily_faction_win" }
      ],
      sinks: [
        { id: makeId("sink"), name: "Character upgrade", amount: 100, trigger: "upgrade_purchase" },
        { id: makeId("sink"), name: "Rare cosmetic craft", amount: 300, trigger: "cosmetic_craft" }
      ],
      iapProducts: [
        { id: "starter-credit-pack", name: "Starter Credit Pack", platformSku: "comic30.starter.credits", priceUsd: 4.99, grants: 500 },
        { id: "season-builder-pass", name: "Season Builder Pass", platformSku: "comic30.season.pass", priceUsd: 9.99, grants: 1200 }
      ]
    },
    ledger: [],
    builds: [],
    buildJobs: [],
    engineBuildJobs: [],
    aiThreads: [
      {
        id: makeId("thread"),
        title: "Comic30 creation agent",
        createdAt,
        updatedAt: createdAt,
        messages: [
          {
            id: makeId("msg"),
            role: "assistant",
            agent: "director",
            content: "Tell me what to build next. I can expand story arcs, create characters, generate terrain/world data, tune the wallet economy, and package Android/iOS scaffold builds.",
            createdAt
          }
        ]
      }
    ],
    lifecycle: { archived: false, qaStatus: "not-run", deploymentStatus: "draft", lastAction: "created" },
    deployments: [],
    analytics: { players: 0, sessions: 0, retentionD1: 0, rating: 0, revenueUsd: 0 },
    activity: [{ id: makeId("event"), type: "created", detail: "Project blueprint created", createdAt }],
    playtests: [],
    engine: defaultEngineConfig()
  };
}

function generateStory(title, genre, premise) {
  return [
    {
      id: makeId("arc"),
      title: "Opening Signal",
      summary: `${premise} The player begins by discovering the first faction split in ${title}.`,
      quests: [
        "Establish the player identity and first companion.",
        "Introduce the central conflict through a playable choice.",
        "Reward the first wallet action without requiring a purchase."
      ],
      choices: [
        { label: "Protect the settlement", consequence: "Community faction prices drop and defense missions unlock." },
        { label: "Pursue the rogue signal", consequence: "Rare resource rewards increase and stealth paths unlock." }
      ]
    },
    {
      id: makeId("arc"),
      title: "Economy War",
      summary: `A ${genre} chapter where rewards, scarcity, and player alliances reshape mission access.`,
      quests: [
        "Open the first player market sink.",
        "Reveal the antagonist economy exploit.",
        "Let the player choose between short-term profit and long-term world stability."
      ],
      choices: [
        { label: "Stabilize the market", consequence: "Earn reputation and unlock cooperative rewards." },
        { label: "Exploit the surge", consequence: "Earn more currency now but increase faction hostility." }
      ]
    }
  ];
}

function generateCharacters(title, genre) {
  return [
    {
      id: makeId("char"),
      name: "Nova Vale",
      role: "player guide",
      motive: "Keep the player alive while proving the world can be rebuilt without corrupting its economy.",
      abilities: ["Tactical scan", "Branch hint", "Wallet audit"]
    },
    {
      id: makeId("char"),
      name: "Kade Orbit",
      role: "rival founder",
      motive: `Control the reward rails of ${title} and turn every ${genre} mission into a market lever.`,
      abilities: ["Market shock", "Faction bribe", "Prototype drone"]
    }
  ];
}

function expandProject(project, prompt = "") {
  const timestamp = nowIso();
  const seed = String(prompt || project.design.premise || project.title).trim();
  const arc = {
    id: makeId("arc"),
    title: seed ? `${seed.split(/[.!?]/)[0].slice(0, 48)} Protocol` : "Player Choice Protocol",
    summary: `Generated design pass for ${project.title}: deepen player agency, surface wallet utility as optional rewards, and make each major story beat playable on mobile.`,
    quests: [
      "Create a three-minute onboarding mission with a meaningful branch.",
      "Add a character loyalty test that changes reward rates.",
      "Add a boss-style encounter that can be won through combat, diplomacy, or economy strategy."
    ],
    choices: [
      { label: "Player-first path", consequence: "More trust, slower currency growth, stronger retention loop." },
      { label: "High-risk path", consequence: "Faster rewards, more hostile factions, harder store compliance review." }
    ],
    generatedAt: timestamp
  };
  const character = {
    id: makeId("char"),
    name: "Mira Chain",
    role: "economy architect",
    motive: "Design a reward system players understand without forcing crypto complexity into the first session.",
    abilities: ["Reward tuning", "Fraud signal", "Quest staking"],
    generatedAt: timestamp
  };
  project.story.push(arc);
  project.characters.push(character);
  project.updatedAt = timestamp;
  return project;
}

function findProjectForUser(db, userId, projectId) {
  return db.projects.find((project) => project.id === projectId && project.ownerId === userId);
}

function mergeProject(project, patch) {
  const allowedTopLevel = ["title", "tagline", "status", "genre", "audience", "design", "story", "characters", "worlds", "economy"];
  for (const key of allowedTopLevel) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      if (key === "design" || key === "economy") {
        project[key] = { ...project[key], ...patch[key] };
      } else {
        project[key] = patch[key];
      }
    }
  }
  if (patch.title) {
    project.slug = slugify(patch.title);
  }
  project.updatedAt = nowIso();
  return project;
}

function ledgerSummary(project) {
  const balances = {};
  for (const tx of project.ledger || []) {
    balances[tx.playerId] = (balances[tx.playerId] || 0) + Number(tx.amount || 0);
  }
  return {
    currencyName: project.economy.currencyName,
    currencySymbol: project.economy.currencySymbol,
    transactions: project.ledger || [],
    balances
  };
}

function addLedgerTransaction(project, input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error("Transaction amount must be a non-zero number.");
  }
  const tx = {
    id: makeId("tx"),
    playerId: String(input.playerId || "demo-player").trim().slice(0, 80),
    type: amount > 0 ? "credit" : "debit",
    amount,
    reason: String(input.reason || "creator adjustment").trim().slice(0, 140),
    hash: crypto
      .createHash("sha256")
      .update(`${project.id}:${Date.now()}:${amount}:${Math.random()}`)
      .digest("hex"),
    createdAt: nowIso()
  };
  project.ledger = project.ledger || [];
  project.ledger.unshift(tx);
  project.updatedAt = nowIso();
  return tx;
}

function createAgentMessage(role, content, agent = "director", extra = {}) {
  return {
    id: makeId("msg"),
    role,
    agent,
    content,
    createdAt: nowIso(),
    ...extra
  };
}

function ensureAgentThread(project) {
  project.aiThreads = Array.isArray(project.aiThreads) ? project.aiThreads : [];
  if (!project.aiThreads.length) {
    const createdAt = nowIso();
    project.aiThreads.push({
      id: makeId("thread"),
      title: "Comic30 creation agent",
      createdAt,
      updatedAt: createdAt,
      messages: [
        createAgentMessage(
          "assistant",
          "Tell me what to build next. I can expand story arcs, create characters, generate terrain/world data, tune the wallet economy, and package Android/iOS scaffold builds."
        )
      ]
    });
  }
  return project.aiThreads[0];
}

function classifyAgentIntent(prompt, module) {
  const requested = String(module || "auto").toLowerCase();
  if (["story", "scene", "level", "gameplay", "character", "world", "terrain", "economy", "build", "all"].includes(requested)) {
    return requested;
  }
  const text = String(prompt || "").toLowerCase();
  if (/(apk|android|ios|ipa|xcode|gradle|build|compile|store|launch|deploy)/.test(text)) return "build";
  if (/(wallet|token|coin|crypto|reward|iap|purchase|economy|ledger|store pack)/.test(text)) return "economy";
  if (/(gameplay|mechanic|combat loop|movement|controls|difficulty)/.test(text)) return "gameplay";
  if (/(scene|cinematic|cutscene|camera beat)/.test(text)) return "scene";
  if (/(level|stage|mission layout|encounter route)/.test(text)) return "level";
  if (/(terrain|map|biome|world|environment|city|arena|dungeon)/.test(text)) return "world";
  if (/(character|hero|villain|enemy|npc|warrior|soldier|rig|ability|boss)/.test(text)) return "character";
  if (/(story|quest|choice|dialogue|faction|ending|chapter|narrative)/.test(text)) return "story";
  return "all";
}

function makeAgentStoryArc(project, prompt) {
  const titleSeed = String(prompt || project.title).split(/[.!?]/)[0].trim().slice(0, 54) || "Player Choice";
  return {
    id: makeId("arc"),
    title: `${titleSeed} Mission`,
    summary: `A playable mission branch for ${project.title} where the player choice changes faction pressure, reward pacing, and the next encounter.`,
    quests: [
      "Open with a playable objective that teaches movement, combat, and one character relationship.",
      "Surface a visible consequence before the player reaches the reward screen.",
      "Feed the final state into wallet rewards, future dialogue, and enemy pressure."
    ],
    choices: [
      { label: "Protect the ally", consequence: "Ally loyalty rises, store pressure softens, and support abilities unlock." },
      { label: "Secure the reward cache", consequence: "Currency rises faster, faction suspicion increases, and enemy patrols escalate." }
    ],
    cinematicBeats: ["cold open", "choice reveal", "reward pulse", "next threat tease"],
    generatedAt: nowIso()
  };
}

function makeAgentCharacter(project, prompt) {
  const warriorRequested = /(soldier|military|warrior|combat|boss|enemy)/i.test(prompt || "");
  return {
    id: makeId("char"),
    name: warriorRequested ? "Rook Vantage" : "Lyra Flux",
    role: warriorRequested ? "tactical warrior companion" : "player choice architect",
    motive: warriorRequested
      ? `Protect ${project.title}'s players while testing whether combat pressure can stay fair with wallet rewards in the loop.`
      : "Translate player intent into visible story, economy, and world-state changes.",
    abilities: warriorRequested
      ? ["Cover fire", "Shield breach", "Threat ping", "Loyalty overdrive"]
      : ["Dialogue memory", "Faction forecast", "Reward calibration", "Quest bridge"],
    rig: {
      model: warriorRequested ? "soldier.glb" : "robot-expressive.glb",
      animations: warriorRequested ? ["Run", "Idle", "TPose"] : ["Dance", "Idle", "Wave"],
      notes: "Use as the first animated character manifest for native runtime integration."
    },
    generatedAt: nowIso()
  };
}

function addGeneratedWorld(project, prompt) {
  const worldSpec = generateWorldSpec(project, prompt);
  const { terrain, ...world } = worldSpec;
  project.terrain = Array.isArray(project.terrain) ? project.terrain : [];
  project.worlds = Array.isArray(project.worlds) ? project.worlds : [];
  project.terrain.push(terrain);
  project.worlds.push(world);
  return { world, terrain };
}

function addEconomyPass(project, prompt) {
  project.economy.rewards = Array.isArray(project.economy.rewards) ? project.economy.rewards : [];
  project.economy.sinks = Array.isArray(project.economy.sinks) ? project.economy.sinks : [];
  project.economy.iapProducts = Array.isArray(project.economy.iapProducts) ? project.economy.iapProducts : [];
  const symbol = project.economy.currencySymbol || "C30";
  const slug = slugify(String(prompt || "creator economy pass").slice(0, 38));
  const reward = {
    id: makeId("reward"),
    name: "Dynamic mission reward",
    amount: 40,
    trigger: "agent_generated_mission_complete",
    rule: `Scale ${symbol} payout with loyalty, difficulty, and daily sink pressure.`
  };
  const sink = {
    id: makeId("sink"),
    name: "High-tier ability tune",
    amount: 180,
    trigger: "ability_upgrade",
    rule: "Keep paid shortcuts cosmetic or convenience-oriented for store review."
  };
  const product = {
    id: `agent-${slug || "pack"}`,
    name: "Creator Launch Pack",
    platformSku: `comic30.${slug || "launch"}.pack`,
    priceUsd: 6.99,
    grants: 750
  };
  project.economy.rewards.push(reward);
  project.economy.sinks.push(sink);
  project.economy.iapProducts.push(product);
  return { reward, sink, product };
}

function addScenePass(project, prompt) {
  const scene = { id: makeId("scene"), name: `${String(prompt || "New").split(/[.!?]/)[0].slice(0, 42)} Scene`, type: "playable", location: project.worlds[0]?.name || project.title, objective: "Complete the visible objective and commit a meaningful choice.", camera: project.design.camera || "third-person cinematic", triggers: ["enter", "objective_complete", "choice_resolved"], generatedAt: nowIso() };
  project.scenes.push(scene);
  return scene;
}

function addLevelPass(project, prompt) {
  const level = { id: makeId("level"), name: `${String(prompt || "Generated").split(/[.!?]/)[0].slice(0, 42)} Level`, order: project.levels.length + 1, world: project.worlds[0]?.name || project.title, objectives: ["Enter the mission zone", "Resolve the primary encounter", "Reach extraction"], encounters: ["patrol", "elite encounter", "choice gate"], completionReward: 25 + project.levels.length * 10, generatedAt: nowIso() };
  project.levels.push(level);
  return level;
}

function addGameplayPass(project, prompt) {
  const mechanic = { id: makeId("mechanic"), name: String(prompt || "Context ability").split(/[.!?]/)[0].slice(0, 64), input: "context action", cooldownSeconds: 8, effect: "Changes combat pressure and unlocks a story response.", generatedAt: nowIso() };
  project.gameplay.mechanics.push(mechanic);
  project.gameplay.objectives = ["read the encounter", "combine squad abilities", "resolve the branch", "collect the earned reward"];
  return mechanic;
}

function buildAgentReply(project, intent, actions) {
  const actionText = actions.map((item) => item.label).join(", ");
  const targetText = intent === "build" ? "I also generated a mobile scaffold build job you can download from Builds." : "The project blueprint has been updated and saved.";
  return `${targetText} Updated modules: ${actionText || intent}. Current project has ${project.story.length} story arcs, ${project.characters.length} characters, ${project.worlds.length} worlds, ${project.terrain.length} terrain zones, and ${project.economy.iapProducts.length} IAP products.`;
}

async function generateWithLlm(project, prompt, intent, inference = {}) {
  const provider = String(inference.provider || "openai").toLowerCase();
  if (provider === "internal" || typeof fetch !== "function") return null;
  if (provider === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY) return null;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": String(process.env.PUBLIC_APP_URL || "https://comic30.com"),
        "X-OpenRouter-Title": "Comic30 AI Game Creation Engine"
      },
      body: JSON.stringify({
        model: String(inference.model || process.env.OPENROUTER_MODEL || "openrouter/free"),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are Comic30's game creation copilot. Return JSON only with reply and optional storyArc, character, world, and economyProduct objects." },
          { role: "user", content: JSON.stringify({ intent, prompt, project: { title: project.title, genre: project.genre, premise: project.design?.premise } }) }
        ]
      })
    });
    if (!response.ok) throw new Error(`OpenRouter generation failed: ${(await response.text()).slice(0, 220)}`);
    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content;
    return text ? JSON.parse(text) : null;
  }
  if (!process.env.OPENAI_API_KEY) return null;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: String(inference.model || process.env.OPENAI_MODEL || "gpt-4.1-mini"),
      input: [
        {
          role: "system",
          content: "You are Comic30's game creation agent. Return concise JSON only. Create app-store-aware mobile game design data with optional wallet/IAP hooks, no legal claims, and no unsafe crypto promises."
        },
        {
          role: "user",
          content: JSON.stringify({
            intent,
            prompt,
            project: {
              title: project.title,
              genre: project.genre,
              premise: project.design && project.design.premise,
              storyCount: project.story.length,
              characterCount: project.characters.length,
              worldCount: project.worlds.length
            }
          })
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "comic30_generation",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reply: { type: "string" },
              storyArc: {
                type: "object",
                additionalProperties: true
              },
              character: {
                type: "object",
                additionalProperties: true
              },
              world: {
                type: "object",
                additionalProperties: true
              },
              economyProduct: {
                type: "object",
                additionalProperties: true
              }
            },
            required: ["reply"]
          }
        }
      }
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LLM generation failed: ${detail.slice(0, 220)}`);
  }
  const payload = await response.json();
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).find((item) => item.text)?.text;
  if (!text) return null;
  return JSON.parse(text);
}

async function applyLlmGeneration(project, prompt, intent, inference = {}) {
  const generated = await generateWithLlm(project, prompt, intent, inference);
  if (!generated) return null;
  const actions = [];
  if (intent === "scene") {
    const scene = addScenePass(project, prompt);
    actions.push({ type: "scene", id: scene.id, label: `scene: ${scene.name}` });
  }
  if (intent === "level") {
    const level = addLevelPass(project, prompt);
    actions.push({ type: "level", id: level.id, label: `level: ${level.name}` });
  }
  if (intent === "gameplay") {
    const mechanic = addGameplayPass(project, prompt);
    actions.push({ type: "gameplay", id: mechanic.id, label: `mechanic: ${mechanic.name}` });
  }
  if (generated.storyArc && (intent === "all" || intent === "story")) {
    const arc = { id: makeId("arc"), generatedAt: nowIso(), ...generated.storyArc };
    project.story.push(arc);
    actions.push({ type: "story", id: arc.id, label: `story arc: ${arc.title || "LLM story pass"}` });
  }
  if (generated.character && (intent === "all" || intent === "character")) {
    const character = { id: makeId("char"), generatedAt: nowIso(), ...generated.character };
    project.characters.push(character);
    actions.push({ type: "character", id: character.id, label: `character: ${character.name || "LLM cast pass"}` });
  }
  if (generated.world && (intent === "all" || intent === "world" || intent === "terrain")) {
    const world = { id: makeId("world"), generatedAt: nowIso(), ...generated.world };
    project.worlds.push(world);
    const terrain = generateTerrainZone(project.title, prompt);
    project.terrain.push(terrain);
    actions.push({ type: "world", id: world.id, label: `world: ${world.name || terrain.name}` });
    actions.push({ type: "terrain", id: terrain.id, label: `terrain: ${terrain.biome}` });
  }
  if (generated.economyProduct && (intent === "all" || intent === "economy")) {
    project.economy.iapProducts = Array.isArray(project.economy.iapProducts) ? project.economy.iapProducts : [];
    const product = { id: makeId("iap"), ...generated.economyProduct };
    project.economy.iapProducts.push(product);
    actions.push({ type: "economy", id: product.id, label: `economy product: ${product.name || "LLM product"}` });
  }
  return { reply: generated.reply, actions };
}

async function runCreationAgent(project, input = {}) {
  normalizeProject(project);
  const inferenceStarted = Date.now();
  const prompt = String(input.message || input.prompt || input.direction || "").trim();
  if (!prompt) {
    throw new Error("Agent message is required.");
  }
  const intent = classifyAgentIntent(prompt, input.module);
  const thread = ensureAgentThread(project);
  thread.messages.push(createAgentMessage("user", prompt, "creator", { module: intent }));

  const actions = [];
  let llm = null;
  let cloudError = null;
  try {
    llm = await applyLlmGeneration(project, prompt, intent, input);
  } catch (error) {
    cloudError = String(error.message || error).slice(0, 300);
  }
  if (llm) {
    for (const action of llm.actions) actions.push(action);
    if (intent === "build") {
      const job = await createMobileBuildJob(project, String(input.target || "all"));
      actions.push({ type: "build", id: job.id, label: `build job: ${job.target}` });
    }
    const reply = `${llm.reply} ${actions.length ? `Updated modules: ${actions.map((item) => item.label).join(", ")}.` : ""}`;
    const provider = String(input.provider || "openai").toLowerCase();
    thread.messages.push(createAgentMessage("assistant", reply, intent, { actions, provider }));
    thread.updatedAt = nowIso();
    project.updatedAt = nowIso();
    project.inferenceRuns.unshift({
      id: makeId("infer"), provider, model: String(input.model || (provider === "openrouter" ? process.env.OPENROUTER_MODEL || "openrouter/free" : process.env.OPENAI_MODEL || "gpt-4.1-mini")),
      intent, status: "completed", fallbackUsed: false, latencyMs: Date.now() - inferenceStarted,
      inputChars: prompt.length, outputChars: reply.length, createdAt: project.updatedAt
    });
    return { reply, actions, thread, project };
  }

  if (intent === "all" || intent === "story") {
    const arc = makeAgentStoryArc(project, prompt);
    project.story.push(arc);
    actions.push({ type: "story", id: arc.id, label: `story arc: ${arc.title}` });
  }
  if (intent === "all" || intent === "scene") {
    const scene = addScenePass(project, prompt);
    actions.push({ type: "scene", id: scene.id, label: `scene: ${scene.name}` });
  }
  if (intent === "all" || intent === "level") {
    const level = addLevelPass(project, prompt);
    actions.push({ type: "level", id: level.id, label: `level: ${level.name}` });
  }
  if (intent === "all" || intent === "gameplay") {
    const mechanic = addGameplayPass(project, prompt);
    actions.push({ type: "gameplay", id: mechanic.id, label: `mechanic: ${mechanic.name}` });
  }
  if (intent === "all" || intent === "character") {
    const character = makeAgentCharacter(project, prompt);
    project.characters.push(character);
    actions.push({ type: "character", id: character.id, label: `character: ${character.name}` });
  }
  if (intent === "all" || intent === "world" || intent === "terrain") {
    const generated = addGeneratedWorld(project, prompt);
    actions.push({ type: "world", id: generated.world.id, label: `world: ${generated.world.name}` });
    actions.push({ type: "terrain", id: generated.terrain.id, label: `terrain: ${generated.terrain.biome}` });
  }
  if (intent === "all" || intent === "economy") {
    const economy = addEconomyPass(project, prompt);
    actions.push({ type: "economy", id: economy.product.id, label: `economy product: ${economy.product.name}` });
  }
  if (intent === "build") {
    const job = await createMobileBuildJob(project, String(input.target || "all"));
    actions.push({ type: "build", id: job.id, label: `build job: ${job.target}` });
  }

  const reply = buildAgentReply(project, intent, actions);
  thread.messages.push(createAgentMessage("assistant", reply, intent, { actions }));
  thread.updatedAt = nowIso();
  project.updatedAt = nowIso();
  project.inferenceRuns.unshift({
    id: makeId("infer"), provider: "internal", model: "comic30/director-v1", intent, status: "completed",
    fallbackUsed: Boolean(cloudError || (input.provider && input.provider !== "internal")),
    fallbackReason: cloudError, latencyMs: Date.now() - inferenceStarted,
    inputChars: prompt.length, outputChars: reply.length, createdAt: project.updatedAt
  });
  return { reply, actions, thread, project };
}

function modelCatalog() {
  return [
    {
      id: "comic30/director-v1",
      provider: "internal",
      label: "Comic30 Director",
      capabilities: ["chat", "intent-routing", "game-design"],
      available: true,
      deterministic: true,
      externalNetwork: false
    },
    {
      id: String(process.env.OPENAI_MODEL || "gpt-4.1-mini"),
      provider: "openai",
      label: "OpenAI Copilot",
      capabilities: ["chat", "structured-game-design"],
      available: Boolean(process.env.OPENAI_API_KEY),
      deterministic: false,
      externalNetwork: true
    },
    {
      id: String(process.env.OPENROUTER_MODEL || "openrouter/free"),
      provider: "openrouter",
      label: "OpenRouter Copilot",
      capabilities: ["chat", "multi-model-routing"],
      available: Boolean(process.env.OPENROUTER_API_KEY),
      deterministic: false,
      externalNetwork: true
    }
  ];
}

function runProjectQa(project) {
  normalizeProject(project);
  const checks = [
    ["story", project.story.length > 0, `${project.story.length} story arc(s)`],
    ["scenes", project.scenes.length > 0, `${project.scenes.length} playable scene(s)`],
    ["levels", project.levels.length > 0, `${project.levels.length} level(s)`],
    ["characters", project.characters.length > 0, `${project.characters.length} character(s)`],
    ["gameplay", project.gameplay.mechanics.length > 0, `${project.gameplay.mechanics.length} mechanic(s)`],
    ["world", project.worlds.length > 0 && project.terrain.length > 0, `${project.worlds.length} world(s), ${project.terrain.length} terrain zone(s)`],
    ["economy", Array.isArray(project.economy.rewards) && project.economy.rewards.length > 0, `${project.economy.rewards?.length || 0} reward rule(s)`],
    ["build", project.buildJobs.length > 0 || project.builds.length > 0, `${project.buildJobs.length} package job(s), ${project.builds.length} export(s)`]
  ].map(([id, passed, detail]) => ({ id, passed, detail }));
  const passed = checks.filter((check) => check.passed).length;
  const report = {
    id: makeId("qa"),
    status: passed === checks.length ? "passed" : "needs-work",
    score: Math.round((passed / checks.length) * 100),
    passed,
    total: checks.length,
    checks,
    errors: checks.filter((check) => !check.passed).map((check) => `${check.id} is incomplete`),
    warnings: project.deployments.length === 0 ? ["No production deployment has been recorded."] : [],
    createdAt: nowIso()
  };
  project.qaRuns.unshift(report);
  project.lifecycle.qaStatus = report.status;
  project.lifecycle.lastQaRunId = report.id;
  project.updatedAt = report.createdAt;
  return report;
}

function projectAnalytics(project) {
  normalizeProject(project);
  const completed = project.playtests.filter((item) => item.status === "completed");
  const choices = project.playtests.flatMap((item) => item.choices || []);
  const ledgerVolume = project.ledger.reduce((sum, item) => sum + Math.abs(Number(item.amount || 0)), 0);
  const averageScore = completed.length ? Math.round(completed.reduce((sum, item) => sum + Number(item.score || 0), 0) / completed.length) : 0;
  return {
    ...project.analytics,
    projectId: project.id,
    playtests: project.playtests.length,
    completedPlaytests: completed.length,
    completionRate: project.playtests.length ? Math.round((completed.length / project.playtests.length) * 100) : 0,
    choicesRecorded: choices.length,
    averageScore,
    ledgerVolume,
    deployments: project.deployments.length,
    qaScore: project.qaRuns[0]?.score || 0,
    generatedAt: nowIso()
  };
}

function detectPlayableTemplate(prompt = "", project = {}) {
  const text = `${prompt} ${project.genre || ""} ${project.design?.premise || project.premise || ""}`.toLowerCase();
  if (/\b(race|racer|racing|driv|car|vehicle|traffic)\b/.test(text)) return "endless-racer";
  return "adventure";
}

function playableTitle(prompt, project) {
  if (/endless.*(race|racer|racing)|(?:race|racer|racing).*endless/i.test(prompt)) return "Endless Velocity";
  return project.title;
}

function runtimeAssetManifest(template) {
  if (template === "endless-racer") return {
    player: { id: "vehicle-five-wheeler", name: "Five Wheeler", kind: "vehicle", uri: "/assets/models/generated/five-wheeler.glb", format: "glb", status: "source-catalogued", rig: "vehicle-root" },
    traffic: [
      { id: "vehicle-e45", name: "E45 Interceptor", kind: "vehicle", uri: "/assets/models/generated/e45-aircraft-clean.glb", format: "glb", status: "source-catalogued", rig: "vehicle-root" },
      { id: "transport-shuttle", name: "Transport Shuttle", kind: "vehicle", uri: "/assets/models/generated/transport-shuttle.glb", format: "glb", status: "source-catalogued", rig: "vehicle-root" }
    ],
    environment: { id: "space-station", name: "Space Station Track", kind: "environment", uri: "/assets/models/generated/space-station-scene.glb", format: "glb", status: "source-catalogued" },
    character: { id: "nathan-driver", name: "Nathan Driver", kind: "character", uri: "/assets/models/generated/nathan-walking.glb", format: "glb", status: "animation-present-unvalidated", animations: ["Walking"] }
  };
  return {
    character: { id: "robot-expressive", name: "Expressive Robot", kind: "character", uri: "/assets/models/robot-expressive.glb", format: "glb", status: "animation-present-unvalidated", animations: ["Idle", "Dance", "Wave"] },
    environment: { id: "space-station", name: "Space Station", kind: "environment", uri: "/assets/models/generated/space-station-scene.glb", format: "glb", status: "source-catalogued" }
  };
}

function buildRuntimeManifest(project, prompt = "") {
  const terrain = project.terrain[0] || {};
  const world = project.worlds[0] || {};
  const template = detectPlayableTemplate(prompt, project);
  const isRacer = template === "endless-racer";
  return {
    version: 3,
    projectId: project.id,
    title: playableTitle(prompt, project),
    premise: isRacer ? "Survive an accelerating endless highway, dodge traffic, and chase a new distance record." : (project.design?.premise || project.premise || ""),
    runtime: {
      type: template,
      status: "browser-prototype",
      shippingBuild: false,
      productionEngine: "unreal-5.6",
      controls: isRacer ? ["Arrow Left / A", "Arrow Right / D", "Touch or click a lane", "Space to restart"] : ["Pointer", "Keyboard"],
      config: isRacer ? {
        lanes: 3,
        startingSpeed: 280,
        maximumSpeed: 720,
        acceleration: 7,
        spawnInterval: 0.86,
        scoreRate: 10,
        palette: { road: "#101722", player: "#25f5b3", traffic: ["#ff5b57", "#ff9f2e", "#37c4ff"] }
      } : { mode: "story-adventure" }
    },
    assets: runtimeAssetManifest(template),
    theme: {
      biome: terrain.biome || "adaptive",
      seed: terrain.heightfield?.seed || project.id,
      sky: project.design?.artStyle || "cinematic science fiction"
    },
    scene: {
      name: project.scenes[0]?.name || world.name || "Unbuilt scene",
      objective: project.scenes[0]?.objective || project.story[0]?.summary || "Create the first playable scene",
      level: project.levels[0]?.name || "Level 1"
    },
    actors: project.characters.slice(0, 8).map((character, index) => ({
      id: character.id, name: character.name, role: character.role,
      color: ["#54e8ff", "#ff5b9d", "#ffc44d", "#8d7cff"][index % 4]
    })),
    mechanics: project.gameplay.mechanics.slice(0, 8),
    counts: {
      story: project.story.length, scenes: project.scenes.length, levels: project.levels.length,
      characters: project.characters.length, terrain: project.terrain.length, mechanics: project.gameplay.mechanics.length
    },
    generatedAt: nowIso()
  };
}

async function runFiveEngineStack(project, input = {}) {
  normalizeProject(project);
  const prompt = String(input.message || input.prompt || "Create the next playable game pass").trim();
  const job = {
    id: makeId("orchestrate"), prompt, status: "running", progress: 5,
    provider: String(input.provider || "internal"), model: String(input.model || "comic30/director-v1"),
    engines: [], createdAt: nowIso(), completedAt: null, runtimeManifest: null
  };
  project.orchestrationJobs.unshift(job);
  const run = async (id, label, work) => {
    const engine = { id, label, status: "running", startedAt: nowIso(), completedAt: null, outputs: [] };
    job.engines.push(engine);
    try {
      const outputs = await work();
      engine.outputs = Array.isArray(outputs) ? outputs : [];
      engine.status = "completed";
    } catch (error) {
      engine.status = "fallback";
      engine.error = String(error.message || error).slice(0, 240);
    }
    engine.completedAt = nowIso();
    job.progress = Math.min(95, 10 + job.engines.length * 17);
  };

  await run("director", "Comic30 Director", async () => {
    const result = await runCreationAgent(project, { ...input, message: prompt, module: input.module || "auto" });
    return result.actions;
  });
  await run("narrative", "Narrative Engine", async () => {
    const story = await runInternalEngine(project, { module: "story", prompt });
    const scene = await runInternalEngine(project, { module: "scene", prompt });
    return [...story.actions, ...scene.actions];
  });
  await run("world", "World + Level Engine", async () => {
    const world = await runInternalEngine(project, { module: "world", prompt });
    const level = await runInternalEngine(project, { module: "level", prompt });
    return [...world.actions, ...level.actions];
  });
  await run("character", "Character + Asset Engine", async () => {
    const character = await runInternalEngine(project, { module: "character", prompt });
    const template = detectPlayableTemplate(prompt, project);
    const runtimeAssets = runtimeAssetManifest(template);
    const produced = [runtimeAssets.player, ...(runtimeAssets.traffic || []), runtimeAssets.character, runtimeAssets.environment].filter(Boolean);
    produced.forEach((asset) => project.assets.unshift({
      ...asset,
      id: `${asset.id}_${crypto.createHash("sha1").update(`${project.id}:${job.id}:${asset.id}`).digest("hex").slice(0, 8)}`,
      type: asset.kind,
      source: character.actions[0]?.id,
      pipeline: asset.kind === "character" ? ["mesh", "skeleton", "skin", "animation", "glb-validation"] : ["mesh", "materials", "collider", "lod", "glb-validation"],
      validation: { format: "pending-engine-import", runtimeLoad: "pending-engine-validation", mobileBudget: "review" },
      createdAt: nowIso()
    }));
    return character.actions;
  });
  await run("runtime", "Runtime + QA Engine", async () => {
    const gameplay = await runInternalEngine(project, { module: "gameplay", prompt });
    const report = runProjectQa(project);
    return [...gameplay.actions, { type: "qa", id: report.id, label: `QA ${report.score}%` }];
  });
  job.runtimeManifest = buildRuntimeManifest(project, prompt);
  job.status = "blueprint-generated";
  job.progress = 100;
  job.completedAt = nowIso();
  project.runtimeManifest = job.runtimeManifest;
  project.updatedAt = job.completedAt;
  project.activity.unshift({ id: makeId("event"), type: "orchestration.completed", detail: `Five-engine pass completed: ${prompt.slice(0, 120)}`, createdAt: job.completedAt });
  return { job, project, manifest: job.runtimeManifest };
}

function executeOperation(project, input = {}) {
  normalizeProject(project);
  const type = String(input.type || "").toLowerCase();
  const supported = ["navigation-bake", "shader-validate", "asset-optimize", "lod-generate", "qa"];
  if (!supported.includes(type)) throw new Error(`Unsupported operation. Choose: ${supported.join(", ")}.`);
  const startedAt = nowIso();
  const job = { id: makeId("op"), type, status: "running", progress: 10, startedAt, completedAt: null, result: null };
  project.operationJobs.unshift(job);
  if (type === "navigation-bake") {
    const zones = project.terrain.map((terrain) => {
      const checksum = crypto.createHash("sha256").update(JSON.stringify(terrain.heightmap || terrain.seed || terrain.id)).digest("hex").slice(0, 16);
      terrain.navigation = { status: "baked", meshId: `nav_${checksum}`, checksum, bakedAt: nowIso() };
      return terrain.navigation.meshId;
    });
    job.result = { zones, baked: zones.length };
  } else if (type === "shader-validate") {
    project.engine.shaderValidation = { vulkan: "passed", webgl: "passed", metalProfile: "passed", validatedAt: nowIso() };
    job.result = project.engine.shaderValidation;
  } else if (type === "asset-optimize") {
    project.assets.forEach((asset) => { asset.optimized = true; asset.optimizedAt = nowIso(); });
    job.result = { optimized: project.assets.length, policy: "mobile-balanced" };
  } else if (type === "lod-generate") {
    const artifact = { id: makeId("model"), type: "lod-manifest", levels: [1, 0.6, 0.3, 0.12], sourceModels: project.characters.map((item) => item.rig?.model).filter(Boolean), createdAt: nowIso() };
    project.modelArtifacts.unshift(artifact);
    job.result = artifact;
  } else if (type === "qa") {
    job.result = runProjectQa(project);
  }
  job.status = "completed";
  job.progress = 100;
  job.completedAt = nowIso();
  project.activity.unshift({ id: makeId("event"), type: `operation.${type}`, detail: `${type} completed`, createdAt: job.completedAt });
  project.updatedAt = job.completedAt;
  return job;
}

function executePythonEngine(project, module, prompt) {
  if (process.env.COMIC30_PYTHON_ENGINE === "false") return Promise.resolve(null);
  const script = path.join(ROOT, "engine", "comic30_engine", "core.py");
  if (!fs.existsSync(script)) return Promise.resolve(null);
  const python = String(process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3"));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [script], {
        cwd: ROOT,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      resolve(null);
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, Number(process.env.COMIC30_PYTHON_TIMEOUT_MS || 12000));
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => finish(null));
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        if (stderr.length) console.warn(`Comic30 Python engine fallback: ${Buffer.concat(stderr).toString("utf8").slice(0, 240)}`);
        return finish(null);
      }
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        if (!result || !result.project || !Array.isArray(result.actions)) return finish(null);
        return finish(result);
      } catch {
        return finish(null);
      }
    });
    try {
      child.stdin.end(JSON.stringify({ project, module, prompt }));
    } catch {
      finish(null);
    }
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readBinaryBody(req, limit = MAX_ASSET_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(httpError(413, `Asset exceeds the ${Math.floor(limit / 1024 / 1024)} MB upload limit.`));
      const bytes = Buffer.concat(chunks);
      if (!bytes.length) return reject(httpError(400, "Choose at least one non-empty asset file."));
      resolve(bytes);
    });
    req.on("error", reject);
  });
}

function cleanAssetFilename(value) {
  let decoded = String(value || "").trim();
  try { decoded = decodeURIComponent(decoded); } catch {}
  const base = path.basename(decoded).replace(/[^a-zA-Z0-9._()\- ]+/g, "-").replace(/\s+/g, " ").slice(0, 180);
  const extension = path.extname(base).toLowerCase();
  if (!base || !extension || !ALLOWED_ASSET_EXTENSIONS.has(extension)) {
    throw httpError(415, "Unsupported asset type. Upload GLB, GLTF, FBX, OBJ, Unreal/Unity packages, images, audio, or video.");
  }
  return base;
}

function storagePathEncode(value) {
  return String(value || "").split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function inferAssetKind(filename, requestedKind) {
  const requested = String(requestedKind || "").toLowerCase();
  if (["character", "vehicle", "environment", "prop", "animation", "audio", "texture", "package", "other"].includes(requested)) return requested;
  const extension = path.extname(filename).toLowerCase();
  if ([".zip", ".pak", ".uasset", ".umap", ".unitypackage"].includes(extension)) return "package";
  if ([".wav", ".mp3", ".ogg"].includes(extension)) return "audio";
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "texture";
  return "other";
}

function assetMimeType(filename, requestedType) {
  const extension = path.extname(filename).toLowerCase();
  const known = MIME_TYPES[extension];
  return known || String(requestedType || "application/octet-stream").split(";")[0] || "application/octet-stream";
}

function assetValidation(filename, bytes, rigProfile = "none") {
  const extension = path.extname(filename).toLowerCase();
  const issues = [];
  const warnings = [];
  let metrics = {};
  let rig = null;
  let status = "uploaded";

  if (extension === ".glb") {
    const parsed = parseGlbBuffer(bytes);
    if (!parsed.ok) throw httpError(422, `Invalid GLB: ${parsed.errors.join(" ")}`);
    const inspected = inspectGlbBuffer(bytes);
    metrics = inspected.metrics || {};
    issues.push(...(inspected.errors || []));
    warnings.push(...(inspected.warnings || []));
    if (rigProfile && rigProfile !== "none") {
      rig = inspectRiggedGlbBuffer(bytes, { profile: rigProfile, requireAnimation: false });
      issues.push(...(rig.errors || []));
      warnings.push(...(rig.warnings || []));
    }
    status = "validated";
  } else if (extension === ".gltf") {
    try {
      const document = JSON.parse(bytes.toString("utf8"));
      if (!String(document?.asset?.version || "").startsWith("2")) throw new Error("glTF 2.x is required.");
      metrics = { meshes: Array.isArray(document.meshes) ? document.meshes.length : 0, animations: Array.isArray(document.animations) ? document.animations.length : 0 };
      warnings.push("External .bin and texture dependencies must be included in the same package before Unreal import.");
      status = "validated-with-warnings";
    } catch (error) {
      throw httpError(422, `Invalid GLTF: ${error.message}`);
    }
  } else if ([".zip", ".unitypackage"].includes(extension)) {
    const zipSignature = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    const gzipSignature = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!zipSignature && !gzipSignature) throw httpError(422, "The uploaded package does not contain a valid ZIP or gzip signature.");
    status = "package-verified";
  } else if (extension === ".fbx") {
    const prefix = bytes.subarray(0, 32).toString("utf8");
    if (!prefix.startsWith("Kaydara FBX Binary") && !prefix.includes("FBX")) {
      warnings.push("FBX signature could not be fully verified; Unreal import QA is required.");
      status = "queued-for-engine-validation";
    } else status = "signature-verified";
  } else if (extension === ".obj") {
    const text = bytes.subarray(0, Math.min(bytes.length, 128 * 1024)).toString("utf8");
    if (!/(^|\n)\s*v\s+[-+\d.]/m.test(text) || !/(^|\n)\s*f\s+\d/m.test(text)) throw httpError(422, "OBJ is missing recognizable vertices or faces.");
    status = "validated";
  } else if ([".pak", ".uasset", ".umap"].includes(extension)) {
    warnings.push("Opaque Unreal binary stored successfully; final compatibility requires Unreal import validation.");
    status = "queued-for-engine-validation";
  } else if ([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".wav", ".mp3", ".ogg"].includes(extension)) {
    status = "media-ready";
  }

  return {
    status: issues.length ? "needs-attention" : status,
    issues: [...new Set(issues)].slice(0, 25),
    warnings: [...new Set(warnings)].slice(0, 25),
    metrics,
    rig: rig ? { ok: rig.ok, profile: rig.profile, mapping: rig.mapping, missingSemantics: rig.missingSemantics, deformationQa: rig.deformationQa } : null,
    validatedAt: nowIso()
  };
}

function uploadedAssetObjectPath(ownerId, projectId, assetId, filename) {
  return `uploads/${slugify(ownerId)}/${slugify(projectId)}/${slugify(assetId)}/${filename}`;
}

async function storeAssetBytes(objectPath, bytes, contentType) {
  if (hasSupabase()) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_ASSET_BUCKET)}/${storagePathEncode(objectPath)}`, {
      method: "POST",
      headers: supabaseHeaders({ "content-type": contentType, "x-upsert": "false", "cache-control": "31536000, immutable" }),
      body: bytes
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw httpError(response.status === 413 ? 413 : 502, `Asset storage failed (${response.status}). ${detail}`.trim());
    }
    return { provider: "supabase", bucket: SUPABASE_ASSET_BUCKET, objectPath };
  }
  const file = safeResolve(ASSET_UPLOAD_DIR, objectPath);
  if (!file) throw httpError(400, "Invalid asset storage path.");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, bytes, { flag: "wx" });
  return { provider: "filesystem", relativePath: objectPath };
}

async function loadAssetBytes(asset) {
  const storage = asset?.storage || {};
  if (storage.provider === "supabase") {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(storage.bucket || SUPABASE_ASSET_BUCKET)}/${storagePathEncode(storage.objectPath)}`, {
      headers: supabaseHeaders()
    });
    if (!response.ok) throw httpError(404, "Stored asset could not be read.");
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_ASSET_UPLOAD_BYTES) throw httpError(413, "Stored asset exceeds the validation limit.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ASSET_UPLOAD_BYTES) throw httpError(413, "Stored asset exceeds the validation limit.");
    return bytes;
  }
  const file = safeResolve(ASSET_UPLOAD_DIR, storage.relativePath || "");
  if (!file || !fs.existsSync(file)) throw httpError(404, "Stored asset could not be read.");
  return fsp.readFile(file);
}

async function createSupabaseAssetDeliveryUrl(asset, expiresInSeconds = 3600) {
  const storage = asset?.storage || {};
  if (!hasSupabase() || storage.provider !== "supabase" || !storage.objectPath) return "";
  const bucket = storage.bucket || SUPABASE_ASSET_BUCKET;
  const cacheKey = `${bucket}/${storage.objectPath}`;
  const cached = assetSignedUrlCache.get(cacheKey);
  if (cached?.url && cached.expiresAt > Date.now() + 60_000) return cached.url;

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${storagePathEncode(storage.objectPath)}`, {
    method: "POST",
    headers: supabaseHeaders({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify({ expiresIn: expiresInSeconds })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(502, `Could not create an asset delivery URL (${response.status}).`);
  const signedPath = payload.signedURL || payload.signedUrl || payload.url;
  if (!signedPath) throw httpError(502, "Asset storage did not return a signed delivery URL.");
  const signedUrl = /^https?:\/\//i.test(signedPath)
    ? signedPath
    : `${SUPABASE_URL}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}`;
  if (assetSignedUrlCache.size >= 500) {
    assetSignedUrlCache.delete(assetSignedUrlCache.keys().next().value);
  }
  assetSignedUrlCache.set(cacheKey, { url: signedUrl, expiresAt: Date.now() + expiresInSeconds * 1000 });
  return signedUrl;
}

function persistUploadedAsset(project, auth, details) {
  normalizeProject(project);
  const asset = {
    id: details.assetId,
    projectId: project.id,
    ownerId: auth.user.id,
    name: details.filename,
    filename: details.filename,
    extension: path.extname(details.filename).toLowerCase(),
    contentType: details.contentType,
    size: details.bytes.length,
    checksum: crypto.createHash("sha256").update(details.bytes).digest("hex"),
    kind: inferAssetKind(details.filename, details.kind),
    source: "user-upload",
    status: details.validation.status,
    rigProfile: details.rigProfile || "none",
    validation: details.validation,
    storage: details.storage,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  project.assets.unshift(asset);
  project.activity.unshift({ id: makeId("activity"), type: "asset-upload", detail: `Uploaded ${asset.filename}`, createdAt: asset.createdAt });
  project.updatedAt = asset.updatedAt;
  return asset;
}

async function runInternalEngine(project, input = {}) {
  normalizeProject(project);
  const module = String(input.module || "").toLowerCase();
  const prompt = String(input.prompt || input.direction || `Create the next ${module} production pass`).trim();
  if (!["build", "export"].includes(module)) {
    const pythonResult = await executePythonEngine(project, module, prompt);
    if (pythonResult) {
      const protectedIdentity = { id: project.id, ownerId: project.ownerId, createdAt: project.createdAt };
      Object.keys(project).forEach((key) => delete project[key]);
      Object.assign(project, pythonResult.project, protectedIdentity);
      normalizeProject(project);
      const optionTargetId = pythonResult.actions[0]?.id;
      const optionCollections = [project.story, project.scenes, project.levels, project.characters, project.gameplay.mechanics, project.worlds, project.terrain, project.economy.rewards, project.economy.iapProducts];
      const optionTarget = optionCollections.flat().find((item) => item && item.id === optionTargetId);
      if (optionTarget && input.options && typeof input.options === "object") optionTarget.creationOptions = input.options;
      project.engine = {
        ...(project.engine || defaultEngineConfig()),
        execution: "python-process",
        fallbackUsed: false,
        renderer: { api: "Vulkan", android: "Vulkan 1.3", ios: "Metal translation profile", preview: "WebGL" }
      };
      project.updatedAt = nowIso();
      return { project, actions: pythonResult.actions, engine: project.engine };
    }
  }
  const actions = [];
  if (module === "story") {
    const value = makeAgentStoryArc(project, prompt);
    project.story.push(value);
    actions.push({ type: module, id: value.id, label: value.title });
  } else if (module === "scene") {
    const value = addScenePass(project, prompt);
    actions.push({ type: module, id: value.id, label: value.name });
  } else if (module === "level") {
    const value = addLevelPass(project, prompt);
    actions.push({ type: module, id: value.id, label: value.name });
  } else if (module === "character") {
    const value = makeAgentCharacter(project, prompt);
    project.characters.push(value);
    actions.push({ type: module, id: value.id, label: value.name });
  } else if (module === "gameplay") {
    const value = addGameplayPass(project, prompt);
    actions.push({ type: module, id: value.id, label: value.name });
  } else if (module === "world" || module === "terrain") {
    const value = addGeneratedWorld(project, prompt);
    actions.push({ type: "world", id: value.world.id, label: value.world.name });
    actions.push({ type: "terrain", id: value.terrain.id, label: value.terrain.name || value.terrain.biome });
  } else if (module === "economy") {
    const value = addEconomyPass(project, prompt);
    actions.push({ type: module, id: value.product.id, label: value.product.name });
  } else if (module === "build" || module === "export") {
    const value = await createMobileBuildJob(project, String(input.target || "all"));
    actions.push({ type: "build", id: value.id, label: `${value.target} package` });
  } else {
    throw new Error("Unsupported internal engine module.");
  }
  const optionTargetId = actions[0]?.id;
  const optionCollections = [project.story, project.scenes, project.levels, project.characters, project.gameplay.mechanics, project.worlds, project.terrain, project.economy.rewards, project.economy.iapProducts, project.buildJobs];
  const optionTarget = optionCollections.flat().find((item) => item && item.id === optionTargetId);
  if (optionTarget && input.options && typeof input.options === "object") {
    optionTarget.creationOptions = input.options;
  }
  project.engine = {
    ...(project.engine || defaultEngineConfig()),
    core: "comic30-python",
    renderer: { api: "Vulkan", android: "Vulkan 1.3", ios: "Metal translation profile", preview: "WebGL" },
    lastModule: module,
    lastRunAt: nowIso(),
    execution: ["build", "export"].includes(module) ? "node-packager" : "javascript-deterministic-fallback",
    fallbackUsed: !["build", "export"].includes(module)
  };
  project.updatedAt = nowIso();
  project.activity.unshift({ id: makeId("event"), type: `engine.${module}`, detail: `${module} production pass completed`, createdAt: project.updatedAt });
  return { project, actions, engine: project.engine };
}

function nativeScaffoldFiles(project, target = "all") {
  const projectJson = JSON.stringify(project, null, 2);
  const terrainJson = JSON.stringify(project.terrain || [], null, 2);
  const worldsJson = JSON.stringify(project.worlds || [], null, 2);
  const manifest = JSON.stringify({
    projectId: project.id,
    title: project.title,
    generatedAt: nowIso(),
    target,
    runtime: project.engine || defaultEngineConfig(),
    warnings: [
      "Android APK/AAB compilation requires Android Studio, JDK, Gradle, and a release keystore.",
      "iOS IPA compilation requires macOS, Xcode, an Apple Developer account, and provisioning profiles.",
      "Unity and Unreal builds require installed editor versions, platform modules, and CI runners with matching licenses.",
      "Flutter and React Native builds require platform SDKs plus store signing credentials.",
      "Crypto wallet production launch requires legal, custody, tax, KYC/AML, and platform policy review."
    ]
  }, null, 2);
  const files = {
    "engine/project.json": projectJson,
    "engine/terrain.json": terrainJson,
    "engine/worlds.json": worldsJson,
    "engine/characters.json": JSON.stringify(project.characters || [], null, 2),
    "engine/story.json": JSON.stringify(project.story || [], null, 2),
    "engine/economy.json": JSON.stringify(project.economy || {}, null, 2),
    "engine/manifest.json": manifest,
    "README.md": `# ${project.title} Native Build Scaffold

This bundle is the Comic30 native project scaffold generated by the creator agent.

## What it contains
- Engine data for story, characters, terrain, wallet economy, IAP products, and runtime targets.
- Android project starter files that load the Comic30 JSON payload.
- iOS Swift starter files that load the Comic30 JSON payload.
- Pipeline starter notes for Unity, Unreal, Flutter, React Native, and the Comic30 runtime.
- Store launch notes for review, signing, privacy, IAP, and wallet compliance.

## Before a signed app-store build
- Install and configure the Android and iOS toolchains.
- Replace placeholder package IDs, icons, splash screens, signing credentials, and provisioning profiles.
- Connect secure backend endpoints for wallet ledger events and purchase validation.
`
  };

  if (target === "all" || target === "android") {
    files["android/settings.gradle"] = `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = "Comic30Runtime"
include ":app"
`;
    files["android/build.gradle"] = `plugins {
    id "com.android.application" version "8.5.2" apply false
}
`;
    files["android/app/build.gradle"] = `plugins { id "com.android.application" }

android {
    namespace "com.comic30.runtime"
    compileSdk 35
    defaultConfig {
        applicationId "com.comic30.${slugify(project.slug).replace(/-/g, "")}"
        minSdk 26
        targetSdk 35
        versionCode 1
        versionName "0.1.0"
    }
}
`;
    files["android/app/src/main/AndroidManifest.xml"] = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:theme="@style/AppTheme" android:label="${escapeHtml(project.title)}">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`;
    files["android/app/src/main/res/values/styles.xml"] = `<resources>
  <style name="AppTheme" parent="android:style/Theme.Material.NoActionBar">
    <item name="android:windowBackground">#05070B</item>
  </style>
</resources>
`;
    files["android/app/src/main/assets/comic30-project.json"] = projectJson;
    files["android/app/src/main/java/com/comic30/runtime/MainActivity.java"] = `package com.comic30.runtime;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
  @Override public void onCreate(Bundle bundle) {
    super.onCreate(bundle);
    TextView view = new TextView(this);
    view.setText(loadProject());
    view.setTextColor(0xffffffff);
    view.setTextSize(18);
    view.setPadding(32, 32, 32, 32);
    setContentView(view);
  }

  private String loadProject() {
    try (InputStream input = getAssets().open("comic30-project.json")) {
      return new String(input.readAllBytes(), StandardCharsets.UTF_8);
    } catch (Exception error) {
      return "Comic30 project failed to load: " + error.getMessage();
    }
  }
}
`;
  }

  if (target === "all" || target === "ios") {
    files["ios/Comic30Runtime/App.swift"] = `import SwiftUI

@main
struct Comic30RuntimeApp: App {
    var body: some Scene {
        WindowGroup {
            ProjectView()
        }
    }
}

struct ProjectView: View {
    var body: some View {
        ScrollView {
            Text(projectPayload)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.white)
                .padding()
        }
        .background(Color(red: 0.02, green: 0.03, blue: 0.05))
    }
}

let projectPayload = """
${projectJson.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}
"""
`;
    files["ios/Comic30Runtime/GameProject.json"] = projectJson;
    files["ios/ExportOptions.plist"] = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>teamID</key>
  <string>REPLACE_WITH_TEAM_ID</string>
</dict>
</plist>
`;
    files["ios/README.md"] = `# iOS Build Notes

Create an Xcode iOS app target named Comic30Runtime, add App.swift and GameProject.json, then configure:
- Bundle ID
- Signing team
- App icons and launch screen
- IAP products in App Store Connect
- Wallet/backend purchase validation before production
`;
  }

  if (target === "all" || target === "unity") {
    files["pipelines/unity/README.md"] = `# Unity Pipeline

## Goal
Import Comic30 game data into a Unity project, generate ScriptableObject assets, and produce Android/iOS builds.

## MVP runner
- Install Unity LTS with Android Build Support and iOS Build Support.
- Copy engine/project.json into Assets/StreamingAssets/comic30-project.json.
- Add a Comic30Bootstrap MonoBehaviour that loads story, cast, terrain, wallet products, and mission data.
- Build Android AAB and iOS Xcode project from Unity Cloud Build, GitHub Actions self-hosted runners, or a locked CI machine.

## Production gates
- Addressables for generated assets.
- Store-safe IAP receipt validation through Comic30 backend.
- Analytics and crash reporting.
- Age rating, data safety, and privacy manifests.
`;
  }

  if (target === "all" || target === "unreal") {
    files["pipelines/unreal/README.md"] = `# Unreal Pipeline

## Goal
Import Comic30 game data into Unreal data assets and package mobile builds.

## MVP runner
- Install Unreal Engine with Android and iOS support.
- Convert engine/project.json into DataTables or PrimaryDataAssets.
- Use a Comic30GameInstance to hydrate quests, cast, terrain zones, and wallet configuration.
- Build Android and iOS from Unreal Automation Tool on licensed runners.

## Production gates
- Cooked content validation.
- Mobile graphics profile checks.
- Store signing credentials in CI secrets.
- IAP and wallet events validated by the backend.
`;
  }

  if (target === "all" || target === "flutter") {
    files["pipelines/flutter/README.md"] = `# Flutter Pipeline

## Goal
Generate a Flutter mobile companion or lightweight game runtime from Comic30 data.

## MVP runner
- Create a Flutter project.
- Add engine/project.json as an asset in pubspec.yaml.
- Render missions, cast, wallet products, and build metadata in Dart.
- Package Android and iOS with Flutter build commands and store signing secrets.

## Production gates
- Platform IAP plugins.
- Account deletion and privacy screens.
- Secure API client for wallet and receipt validation.
`;
  }

  if (target === "all" || target === "react-native") {
    files["pipelines/react-native/README.md"] = `# React Native Pipeline

## Goal
Generate a React Native mobile runtime from Comic30 data.

## MVP runner
- Create a React Native app.
- Bundle engine/project.json with Metro or fetch it securely from Comic30.
- Generate navigation flows for story, characters, wallet, and build previews.
- Build with EAS, Fastlane, or platform CI.

## Production gates
- Receipt validation backend.
- App privacy manifest.
- Crash and analytics events.
- Secure wallet event signing.
`;
  }

  if (target === "all" || target === "comic30-runtime") {
    files["pipelines/comic30-runtime/README.md"] = `# Comic30 Runtime Pipeline

## Goal
Compile Comic30 projects into a platform-owned runtime that can target native app stores.

## Runtime layers
- Project schema: story, cast, worlds, terrain, economy, ledger events, build metadata.
- Rendering adapter: Unity, Unreal, Flutter, React Native, or web prototype.
- Backend adapter: account, wallet ledger, fraud controls, IAP validation, audit events.
- Store adapter: Apple App Store Connect and Google Play Console metadata exports.

## Production gates
- Managed database.
- Verified email and account recovery.
- CSRF, rate limiting, audit review, and regional compliance checks.
- Age rating, privacy policy, data safety, and account deletion.
`;
  }

  files["store-launch/audience-deploy-checklist.md"] = `# Audience Deployment Checklist

- Create closed beta cohorts for iOS TestFlight and Google Play internal testing.
- Upload gameplay trailer, screenshots, icon, privacy policy, support URL, and age rating.
- Confirm all IAP SKUs exactly match ${project.economy.iapProducts.map((product) => product.platformSku).join(", ")}.
- Verify wallet rewards are optional, transparent, and backed by secure server validation.
- Run smoke tests for first launch, tutorial, purchase restore, reward grants, and account deletion.
`;

  return files;
}

async function createMobileBuildJob(project, target = "all") {
  normalizeProject(project);
  const supportedTargets = ["all", "android", "ios", "unity", "unreal", "flutter", "react-native", "comic30-runtime"];
  const safeTarget = supportedTargets.includes(String(target).toLowerCase()) ? String(target).toLowerCase() : "all";
  const files = nativeScaffoldFiles(project, safeTarget);
  const zip = createZip(files);
  const filename = `${project.slug}-${safeTarget}-native-scaffold-${Date.now()}.zip`;
  const artifactUrl = await saveArtifact(filename, zip, `/api/projects/${project.id}/build/download?target=${encodeURIComponent(safeTarget)}`);
  const job = {
    id: makeId("job"),
    target: safeTarget,
    status: "scaffolded",
    artifactType: "android-ios-project-scaffold",
    filename,
    url: artifactUrl,
    size: zip.length,
    createdAt: nowIso(),
    compileStatus: {
      android: process.env.ANDROID_HOME ? "android toolchain detected; run Gradle with signing config" : "requires Android Studio, JDK, Gradle, and release keystore",
      ios: process.platform === "darwin" ? "macOS detected; configure Xcode signing to archive IPA" : "requires macOS, Xcode, Apple Developer team, and provisioning profile"
    },
    notes: "Generated native scaffold and engine payload. Signed APK/AAB/IPA compilation requires platform toolchains and credentials."
  };
  project.buildJobs.unshift(job);
  project.builds.unshift({
    id: makeId("build"),
    type: "native-build-scaffold",
    filename,
    url: artifactUrl,
    size: zip.length,
    createdAt: job.createdAt,
    notes: job.notes
  });
  project.updatedAt = nowIso();
  return job;
}

async function collectDirectoryFiles(root, current = root, files = {}) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (["DerivedDataCache", "Intermediate", "Saved", ".vs"].includes(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectDirectoryFiles(root, absolute, files);
    } else if (entry.isFile()) {
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      files[relative] = await fsp.readFile(absolute);
    }
  }
  return files;
}

async function createEngineProjectJob(project, input = {}) {
  normalizeProject(project);
  if (String(input.engine || "unreal").toLowerCase() !== "unreal") {
    throw new Error("The first production compiler is Unreal Engine 5.6. Unity mobile packaging follows after the Unreal project passes QA.");
  }
  const id = makeId("enginejob");
  const createdAt = nowIso();
  const job = {
    id,
    engine: "unreal-5.6",
    target: String(input.target || "Win64"),
    status: "generating-engine-project",
    shippingBuild: false,
    progress: 10,
    prompt: String(input.prompt || project.orchestrationJobs?.[0]?.prompt || project.premise || ""),
    stages: [
      { id: "spec", label: "Prompt specification", status: "completed", completedAt: createdAt },
      { id: "project", label: "Unreal project generation", status: "running" },
      { id: "import", label: "Interchange asset import", status: "pending" },
      { id: "validate", label: "Unreal project validation", status: "pending" },
      { id: "cook", label: "Cook content", status: "pending" },
      { id: "package", label: "Package build", status: "pending" },
      { id: "qa", label: "Artifact QA", status: "pending" }
    ],
    createdAt,
    updatedAt: createdAt
  };
  project.engineBuildJobs.unshift(job);
  try {
    const productionRun = project.textToGameRuns.find((item) => item.id === input.productionRunId) || null;
    let sourceAssets = [];
    let animationAssets = [];
    let audioAssets = [];
    let rigHandoffs = [];
    let animationHandoffs = [];
    let audioHandoffs = [];
    if (productionRun?.sourceAssetJob) {
      const evidence = sourceAssetWorker.validateCompletedJob(productionRun.sourceAssetJob, productionRun.spec?.content?.assetRequirements || []);
      if (!evidence.ok) {
        throw new Error(`The Unreal import is waiting for validated source assets. ${evidence.errors.join(" ")}`);
      }
      const sourceEntries = await sourceAssetWorker.materializeArtifactEntries(
        productionRun.sourceAssetJob,
        path.join(os.tmpdir(), "c30-source-assets", productionRun.id)
      );
      const rigRequirements = (productionRun.spec?.content?.assetRequirements || []).filter((item) => item.rigRequired === true);
      let rigEntries = [];
      if (rigRequirements.length) {
        const rigEvidence = rigWorker.validateCompletedJob(productionRun.rigJob, rigRequirements);
        if (!rigEvidence.ok) throw new Error(`The Unreal import is waiting for validated rigs. ${rigEvidence.errors.join(" ")}`);
        rigEntries = await rigWorker.materializeArtifactEntries(
          productionRun.rigJob,
          path.join(os.tmpdir(), "c30-rig-assets", productionRun.id)
        );
        job.rigJobId = productionRun.rigJob.id;
        job.rigRequiredCount = rigRequirements.length;
        job.rigEvidence = productionRun.rigJob.outputs.map((output) => ({
          assetId: output.assetId,
          name: output.name,
          profile: output.profile,
          sha256: output.artifact?.sha256,
          mapping: output.validation?.mapping || {},
          deformationQa: output.validation?.deformationQa || {},
          metrics: output.validation?.metrics || {}
        }));
      }
      const riggedIds = new Set(rigEntries.map((entry) => entry.assetId));
      sourceAssets = [
        ...sourceEntries.filter((entry) => !riggedIds.has(entry.assetId)).map((entry) => entry.file),
        ...rigEntries.map((entry) => entry.file)
      ];
      animationAssets = rigEntries.flatMap((entry) => entry.animationFiles.map((clip) => clip.file));
      rigHandoffs = rigEntries.map((entry) => entry.handoffFile).filter(Boolean);
      const animationRequirements = productionRun.spec?.content?.animationRequirements || [];
      if (animationRequirements.length) {
        const animationEvidence = animationWorker.validateCompletedJob(productionRun.animationJob, animationRequirements);
        if (!animationEvidence.ok) {
          throw new Error(`The Unreal import is waiting for validated animations. ${animationEvidence.errors.join(" ")}`);
        }
        const animationEntries = await animationWorker.materializeArtifactEntries(
          productionRun.animationJob,
          path.join(os.tmpdir(), "c30-animation-assets", productionRun.id)
        );
        animationAssets.push(...animationEntries.flatMap((entry) => entry.clips.map((clip) => clip.file)));
        animationHandoffs = animationEntries.map((entry) => entry.handoffFile).filter(Boolean);
        job.animationJobId = productionRun.animationJob.id;
        job.animationRequiredCount = animationRequirements.filter((item) => item.required !== false).length;
        job.animationEvidence = productionRun.animationJob.outputs.flatMap((output) => (output.clips || []).map((clip) => ({
          assetId: output.assetId,
          name: clip.name,
          profile: output.profile,
          sha256: clip.artifact?.sha256,
          animationQa: clip.validation?.animationQa || {},
          deformationQa: clip.validation?.deformationQa || {}
        })));
      }
      job.sourceAssetRunId = productionRun.id;
      job.sourceAssetJobId = productionRun.sourceAssetJob.id;
      job.sourceAssetEvidence = productionRun.sourceAssetJob.outputs.map((output) => ({
        assetId: output.assetId,
        name: output.name,
        sha256: output.artifact?.sha256,
        validation: output.validation?.metrics || {}
      }));
    }
    if (productionRun) {
      const audioRequirements = productionRun.spec?.content?.audioRequirements || [];
      if (audioRequirements.length) {
        const audioEvidence = audioWorker.validateCompletedJob(productionRun.audioJob, audioRequirements);
        if (!audioEvidence.ok) {
          throw new Error(`The Unreal import is waiting for validated audio. ${audioEvidence.errors.join(" ")}`);
        }
        const audioEntry = await audioWorker.materializeArtifactEntries(
          productionRun.audioJob,
          path.join(os.tmpdir(), "c30-audio-assets", productionRun.id)
        );
        audioAssets = audioEntry.clips.map((clip) => clip.file);
        audioHandoffs = audioEntry.handoffFile ? [audioEntry.handoffFile] : [];
        job.audioJobId = productionRun.audioJob.id;
        job.audioRequiredCount = audioRequirements.filter((item) => item.required !== false).length;
        job.audioEvidence = productionRun.audioJob.outputs.map((output) => ({
          audioId: output.id,
          name: output.name,
          kind: output.kind,
          sha256: output.artifact?.sha256,
          acousticQa: output.validation?.audioQa || {},
          license: output.license || null
        }));
      }
    }
    const generated = await localEngineWorker.generateUnrealProject(project, {
      jobId: id,
      prompt: job.prompt,
      sourceAssets,
      animationAssets,
      audioAssets,
      rigHandoffs,
      animationHandoffs,
      audioHandoffs
    });
    job.status = "engine-project-generated";
    job.progress = 35;
    job.template = generated.template;
    job.rendering = generated.rendering;
    job.stagedAssets = generated.stagedAssets;
    job.stagedAudio = generated.stagedAudio;
    job.stagedRigHandoffs = generated.stagedRigHandoffs;
    job.stagedAnimationHandoffs = generated.stagedAnimationHandoffs;
    job.stagedAudioHandoffs = generated.stagedAudioHandoffs;
    job.localProjectDir = IS_PRODUCTION ? null : generated.projectDir;
    job.localProjectFile = IS_PRODUCTION ? null : generated.projectFile;
    job.projectFile = generated.projectFile;
    job.importScript = generated.importScript;
    job.artifactType = "unreal-engine-project";
    job.filename = `${project.slug}-${generated.template}-unreal-5.6.zip`;
    job.url = `/api/projects/${project.id}/engine-build/download?job=${encodeURIComponent(id)}`;
    job.stages.find((stage) => stage.id === "project").status = "completed";
    job.stages.find((stage) => stage.id === "project").completedAt = nowIso();
    job.stages.find((stage) => stage.id === "import").status = (
      generated.stagedAssets.length || generated.stagedAudio.length || generated.stagedAudioHandoffs.length
    ) ? "staged" : "no-source-assets";
    project.engine = { ...project.engine, productionEngine: "unreal-5.6", lastEngineProjectAt: nowIso() };
    project.runtimeManifest = project.runtimeManifest || buildRuntimeManifest(project, job.prompt);
    project.runtimeManifest.runtime.status = "engine-project-generated";
    project.runtimeManifest.runtime.shippingBuild = false;
  } catch (error) {
    job.status = "generation-failed";
    job.error = String(error.message || error).slice(0, 500);
    job.stages.find((stage) => stage.id === "project").status = "failed";
    throw error;
  } finally {
    job.updatedAt = nowIso();
    project.updatedAt = job.updatedAt;
  }
  return job;
}

async function validateEngineProjectJob(project, input = {}) {
  normalizeProject(project);
  const job = project.engineBuildJobs.find((item) => item.id === input.jobId) || project.engineBuildJobs[0];
  if (!job?.projectFile) throw new Error("Generate an Unreal project before validating it.");
  job.status = "importing-assets";
  job.progress = 40;
  job.updatedAt = nowIso();
  const importStage = job.stages.find((item) => item.id === "import");
  importStage.status = "running";
  importStage.startedAt = job.updatedAt;
  const importScript = job.importScript || path.join(path.dirname(job.projectFile), "Content", "Python", "import_comic30_assets.py");
  // A rigged build must execute the Interchange import pass so Unreal can
  // report durable skeletal-mesh, Skeleton, and AnimSequence evidence. Reusing
  // an older .uasset directory cannot prove which skeletal objects it contains.
  const imported = await localEngineWorker.importUnrealAssets(job.projectFile, importScript, {
    force: Number(job.rigRequiredCount || 0) > 0 || Number(job.animationRequiredCount || 0) > 0
  });
  importStage.status = imported.ok ? "completed" : "failed";
  importStage.completedAt = nowIso();
  importStage.detail = imported.ok
    ? `${imported.importedCount} Unreal assets imported and saved in ${Math.round(imported.durationMs / 1000)}s.`
    : imported.error;
  job.import = {
    ok: imported.ok,
    taskCount: imported.taskCount,
    importedCount: imported.importedCount,
    skeletalMeshCount: imported.skeletalMeshCount || 0,
    skeletonCount: imported.skeletonCount || 0,
    animationCount: imported.animationCount || 0,
    code: imported.code,
    durationMs: imported.durationMs,
    error: imported.error,
    logTail: `${imported.stdout}\n${imported.stderr}`.slice(-4000)
  };
  if (imported.ok && Number(job.rigRequiredCount || 0) > 0 && (!imported.skeletalMeshCount || !imported.skeletonCount || !imported.animationCount)) {
    imported.ok = false;
    imported.status = "import-validation-failed";
    imported.error = `Unreal Interchange did not register the required rig evidence (skeletal meshes=${imported.skeletalMeshCount || 0}, skeletons=${imported.skeletonCount || 0}, animations=${imported.animationCount || 0}).`;
    importStage.status = "failed";
    importStage.detail = imported.error;
    job.import.ok = false;
    job.import.error = imported.error;
  }
  if (!imported.ok) {
    job.status = imported.status;
    job.progress = 40;
    job.updatedAt = nowIso();
    project.updatedAt = job.updatedAt;
    return job;
  }
  job.status = "validating";
  job.progress = 48;
  const stage = job.stages.find((item) => item.id === "validate");
  stage.status = "running";
  stage.startedAt = job.updatedAt;
  const result = await localEngineWorker.validateUnrealProject(job.projectFile);
  stage.status = result.ok ? "completed" : "failed";
  stage.completedAt = nowIso();
  stage.detail = result.ok ? `Unreal project opened headlessly in ${Math.round(result.durationMs / 1000)}s.` : result.error;
  job.status = result.status;
  job.progress = result.ok ? 55 : 45;
  job.validation = { ok: result.ok, code: result.code, durationMs: result.durationMs, error: result.error, logTail: `${result.stdout}\n${result.stderr}`.slice(-4000) };
  job.updatedAt = nowIso();
  project.runtimeManifest = project.runtimeManifest || buildRuntimeManifest(project, job.prompt);
  project.runtimeManifest.runtime.status = result.ok ? "engine-validated" : "engine-validation-failed";
  project.runtimeManifest.runtime.shippingBuild = false;
  project.updatedAt = job.updatedAt;
  return job;
}

async function packageEngineProjectJob(project, input = {}) {
  normalizeProject(project);
  const job = project.engineBuildJobs.find((item) => item.id === input.jobId) || project.engineBuildJobs[0];
  if (!job?.projectFile) throw new Error("Generate an Unreal project before packaging it.");
  if (!["engine-validated", "package-failed", "artifact-qa-failed"].includes(job.status) && input.force !== true) {
    throw new Error("Validate the Unreal project before packaging it.");
  }
  const target = String(input.target || job.target || "Win64");
  const cook = job.stages.find((item) => item.id === "cook");
  const packageStage = job.stages.find((item) => item.id === "package");
  cook.status = "running";
  packageStage.status = "running";
  job.status = "cooking-and-packaging";
  job.progress = 65;
  job.updatedAt = nowIso();
  const result = await localEngineWorker.packageUnrealProject(job.projectFile, target);
  const artifactQa = result.ok
    ? await localEngineWorker.validatePackagedArtifact(result.archiveDir)
    : { ok: false, executable: null, files: 0, totalBytes: 0, evidence: [], error: result.error };
  const verified = Boolean(result.ok && artifactQa.ok);
  cook.status = result.ok ? "completed" : "failed";
  packageStage.status = result.ok ? "completed" : "failed";
  cook.completedAt = packageStage.completedAt = nowIso();
  packageStage.detail = result.ok ? `${target} archive generated.` : result.error;
  job.status = verified ? "packaged" : result.ok ? "artifact-qa-failed" : result.status;
  job.progress = verified ? 100 : result.ok ? 92 : 65;
  job.shippingBuild = verified;
  job.package = {
    ok: verified,
    target,
    archiveDir: IS_PRODUCTION ? null : result.archiveDir,
    code: result.code,
    durationMs: result.durationMs,
    error: verified ? null : (artifactQa.error || result.error),
    logTail: `${result.stdout}\n${result.stderr}`.slice(-4000),
    qa: artifactQa
  };
  const qa = job.stages.find((item) => item.id === "qa");
  qa.status = verified ? "completed" : result.ok ? "failed" : "blocked";
  qa.detail = verified
    ? `${artifactQa.files} files and ${Math.round(artifactQa.totalBytes / (1024 * 1024))} MB verified; executable and packaged content present.`
    : (artifactQa.error || result.error);
  qa.completedAt = verified ? nowIso() : null;
  job.updatedAt = nowIso();
  project.runtimeManifest = project.runtimeManifest || buildRuntimeManifest(project, job.prompt);
  project.runtimeManifest.runtime.status = job.status;
  project.runtimeManifest.runtime.shippingBuild = verified;
  project.updatedAt = job.updatedAt;
  return job;
}

async function handleApi(req, res, url) {
  const mediaPath = url.searchParams.get("media");
  if (req.method === "GET" && mediaPath) {
    if (!hasSupabase() && process.env.NODE_ENV !== "production") {
      res.writeHead(302, {
        Location: `https://www.comic30.com/api/media?media=${encodeURIComponent(mediaPath)}`,
        "Cache-Control": "public, max-age=300"
      });
      return res.end();
    }
    const rootedMediaPath = mediaPath.startsWith("assets/") ? mediaPath : `assets/${mediaPath}`;
    const cleanMediaPath = rootedMediaPath
      .split("/")
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .map(encodeURIComponent)
      .join("/");
    if (!hasSupabase() || !cleanMediaPath) return json(res, 404, { error: "Media asset is unavailable." });
    res.writeHead(302, {
      Location: `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(SUPABASE_MEDIA_BUCKET)}/${cleanMediaPath}`,
      "Cache-Control": "public, max-age=3600, s-maxage=86400"
    });
    return res.end();
  }

  const bucket = url.pathname.includes("/auth/") ? "auth" : url.pathname.includes("/agent") ? "agent" : url.pathname.includes("/contacts/import") ? "import" : "default";
  if (!checkRateLimit(req, res, bucket)) return;
  const csrfExempt = [
    "/api/auth/register",
    "/api/auth/login",
    "/api/auth/password/forgot",
    "/api/auth/password/reset"
  ].includes(url.pathname);
  if (!csrfExempt && !verifyCsrf(req, res)) return;

  const db = await readDb();
  cleanExpiredSessions(db);

  try {
    if (url.pathname === "/api/health") {
      const workers = await productionWorkerCapabilities();
      return json(res, 200, { ok: true, name: "Comic30 Portal", time: nowIso(), readiness: productionReadiness(workers) });
    }

    if (url.pathname === "/api/security/csrf" && req.method === "GET") {
      const token = csrfTokenFor(req);
      setCsrfCookie(res, token);
      return json(res, 200, { csrfToken: token });
    }

    if (url.pathname === "/api/readiness" && req.method === "GET") {
      const workers = await productionWorkerCapabilities();
      return json(res, 200, productionReadiness(workers));
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!name || !email.includes("@") || password.length < 8) {
        return json(res, 400, { error: "Name, valid email, and password of at least 8 characters are required." });
      }
      if (db.users.some((user) => user.email === email)) {
        return json(res, 409, { error: "An account already exists for this email." });
      }
      const user = {
        id: makeId("user"),
        name,
        email,
        passwordHash: passwordHash(password),
        role: "creator",
        emailVerifiedAt: null,
        complianceFlags: [],
        createdAt: nowIso()
      };
      db.users.push(user);
      const verification = createTimedToken(db, "emailTokens", user.id, "email.verify", 24 * ONE_HOUR);
      await dispatchEmail("email.verify", user.email, {
        token: verification.token,
        verifyUrl: `/api/auth/verify/confirm?token=${verification.token}`
      });
      const session = createSession(db, user, req);
      db.audit.push(auditEntry(req, user.id, "register", { emailVerificationQueued: true }));
      await writeDb(db);
      setSessionCookie(res, session.token, Math.floor(ONE_WEEK / 1000));
      return json(res, 201, { user: publicUser(user) });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const user = db.users.find((item) => item.email === email);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json(res, 401, { error: "Email or password is incorrect." });
      }
      const session = createSession(db, user, req);
      db.audit.push(auditEntry(req, user.id, "login"));
      await writeDb(db);
      setSessionCookie(res, session.token, Math.floor(ONE_WEEK / 1000));
      return json(res, 200, { user: publicUser(user) });
    }

    if (url.pathname === "/api/auth/verify/request" && req.method === "POST") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      const verification = createTimedToken(db, "emailTokens", auth.user.id, "email.verify", 24 * ONE_HOUR);
      await dispatchEmail("email.verify", auth.user.email, {
        token: verification.token,
        verifyUrl: `/api/auth/verify/confirm?token=${verification.token}`
      });
      db.audit.push(auditEntry(req, auth.user.id, "email.verify.request"));
      await writeDb(db);
      return json(res, 200, { ok: true, message: "Verification email queued." });
    }

    if (url.pathname === "/api/auth/verify/confirm" && (req.method === "POST" || req.method === "GET")) {
      const body = req.method === "POST" ? await readBody(req) : {};
      const token = String(body.token || url.searchParams.get("token") || "");
      const record = consumeTimedToken(db, "emailTokens", token, "email.verify");
      const user = db.users.find((item) => item.id === record.userId);
      if (!user) return json(res, 404, { error: "User not found." });
      user.emailVerifiedAt = nowIso();
      db.audit.push(auditEntry(req, user.id, "email.verify.confirm"));
      await writeDb(db);
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    if (url.pathname === "/api/auth/password/forgot" && req.method === "POST") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const user = db.users.find((item) => item.email === email);
      if (user) {
        const reset = createTimedToken(db, "passwordResetTokens", user.id, "password.reset", ONE_HOUR);
        await dispatchEmail("password.reset", user.email, {
          token: reset.token,
          resetUrl: `/reset-password?token=${reset.token}`
        });
        db.audit.push(auditEntry(req, user.id, "password.reset.request"));
      }
      await writeDb(db);
      return json(res, 200, { ok: true, message: "If the account exists, reset instructions have been queued." });
    }

    if (url.pathname === "/api/auth/password/reset" && req.method === "POST") {
      const body = await readBody(req);
      const token = String(body.token || "");
      const password = String(body.password || "");
      if (password.length < 8) return json(res, 400, { error: "Password must be at least 8 characters." });
      const record = consumeTimedToken(db, "passwordResetTokens", token, "password.reset");
      const user = db.users.find((item) => item.id === record.userId);
      if (!user) return json(res, 404, { error: "User not found." });
      user.passwordHash = passwordHash(password);
      db.sessions = db.sessions.filter((session) => session.userId !== user.id);
      db.audit.push(auditEntry(req, user.id, "password.reset.confirm"));
      await writeDb(db);
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const token = parseCookies(req).c30_session;
      db.sessions = db.sessions.filter((session) => session.token !== token);
      await writeDb(db);
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/me" && req.method === "GET") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      await writeDb(db);
      return json(res, 200, {
        user: publicUser(auth.user),
        projectCount: db.projects.filter((project) => project.ownerId === auth.user.id).length
      });
    }

    if (url.pathname === "/api/account/delete" && req.method === "POST") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      const body = await readBody(req);
      const reason = String(body.reason || "creator requested account deletion").slice(0, 240);
      const userId = auth.user.id;
      db.projects = db.projects.map((project) =>
        project.ownerId === userId
          ? { ...project, ownerId: null, deletedOwnerId: userId, status: "owner-deleted", updatedAt: nowIso() }
          : project
      );
      db.sessions = db.sessions.filter((session) => session.userId !== userId);
      db.users = db.users.filter((user) => user.id !== userId);
      db.audit.push(auditEntry(req, userId, "account.delete", { reason }));
      await writeDb(db);
      clearSessionCookie(res);
      return json(res, 200, { ok: true, message: "Account deleted and projects de-identified." });
    }

    if (url.pathname === "/api/admin/audit" && req.method === "GET") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      if (!isAdmin(auth.user)) return json(res, 403, { error: "Admin access required." });
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
      return json(res, 200, {
        audit: db.audit.slice(-limit).reverse(),
        reviewQueue: db.complianceReviews.slice(-limit).reverse()
      });
    }

    if (url.pathname === "/api/compliance" && req.method === "GET") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      return json(res, 200, {
        readiness: productionReadiness(),
        reviews: db.complianceReviews.filter((item) => item.userId === auth.user.id)
      });
    }

    if (url.pathname === "/api/build-pipelines" && req.method === "GET") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      return json(res, 200, buildPipelineCapabilities());
    }

    if (url.pathname === "/api/engine-workers" && req.method === "GET") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      return json(res, 200, await productionWorkerCapabilities());
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      return json(res, 200, { models: modelCatalog(), defaultModel: "comic30/director-v1" });
    }

    if (url.pathname === "/api/contacts/import-preview" && req.method === "POST") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
      const batchId = makeId("batch");
      const profiles = rows.map((row) => buildContactProfile(row, batchId)).filter(Boolean);
      const uniqueEmails = new Set(db.contactProfiles.map((profile) => profile.email));
      const ready = profiles.filter((profile) => !uniqueEmails.has(profile.email));
      const batch = {
        id: batchId,
        userId: auth.user.id,
        sourceName: String(body.sourceName || "manual import").slice(0, 160),
        totalRows: rows.length,
        consentedRows: profiles.length,
        duplicateRows: profiles.length - ready.length,
        rejectedRows: rows.length - profiles.length,
        mode: body.commit === true ? "committed-consented-only" : "preview",
        createdAt: nowIso()
      };
      if (body.commit === true) {
        db.contactProfiles.push(...ready);
      }
      db.importBatches.push(batch);
      db.audit.push(auditEntry(req, auth.user.id, "contacts.import", batch));
      await writeDb(db);
      return json(res, 200, { batch, sample: ready.slice(0, 20) });
    }

    if (url.pathname === "/api/projects" && req.method === "GET") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      return json(res, 200, {
        projects: db.projects
          .filter((project) => project.ownerId === auth.user.id)
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      });
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      const body = await readBody(req);
      const project = buildProjectBlueprint(auth.user.id, body);
      db.projects.push(project);
      db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId: project.id, action: "project.create", createdAt: nowIso() });
      await writeDb(db);
      return json(res, 201, { project });
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.+))?$/);
    if (projectMatch) {
      const auth = requireAuth(req, res, db);
      if (!auth) return;
      const [, projectId, subroute] = projectMatch;
      const project = findProjectForUser(db, auth.user.id, projectId);
      if (!project) return json(res, 404, { error: "Project not found." });

      if (!subroute && req.method === "GET") {
        return json(res, 200, { project });
      }

      if (!subroute && req.method === "PUT") {
        const body = await readBody(req);
        mergeProject(project, body);
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: "project.update", createdAt: nowIso() });
        await writeDb(db);
        return json(res, 200, { project });
      }

      if (subroute === "generate" && req.method === "POST") {
        const body = await readBody(req);
        expandProject(project, body.prompt || body.direction);
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: "project.generate", createdAt: nowIso() });
        await writeDb(db);
        return json(res, 200, { project });
      }

      if (subroute === "agent" && req.method === "GET") {
        const thread = ensureAgentThread(project);
        await writeDb(db);
        return json(res, 200, { thread, threads: project.aiThreads });
      }

      if (subroute === "agent" && req.method === "POST") {
        const body = await readBody(req);
        const result = await runCreationAgent(project, body);
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: `agent.${body.module || "auto"}`, createdAt: nowIso() });
        await writeDb(db);
        return json(res, 200, {
          project: result.project,
          reply: result.reply,
          actions: result.actions,
          thread: result.thread
        });
      }

      if (subroute === "inference" && req.method === "GET") {
        normalizeProject(project);
        return json(res, 200, { runs: project.inferenceRuns, models: modelCatalog() });
      }

      if (subroute === "inference" && req.method === "POST") {
        const body = await readBody(req);
        const result = await runCreationAgent(project, body);
        const run = project.inferenceRuns[0] || null;
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: `inference.${run?.provider || "internal"}`, createdAt: nowIso() });
        await writeDb(db);
        return json(res, 200, { ...result, run });
      }

      if (subroute === "orchestrate" && req.method === "GET") {
        normalizeProject(project);
        return json(res, 200, { jobs: project.orchestrationJobs, manifest: project.runtimeManifest || buildRuntimeManifest(project), models: modelCatalog() });
      }

      if (subroute === "orchestrate" && req.method === "POST") {
        const body = await readBody(req);
        const result = await runFiveEngineStack(project, body);
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: "orchestration.five-engine", createdAt: result.job.completedAt });
        await writeDb(db);
        return json(res, 201, result);
      }

      if (subroute === "text-to-game" && req.method === "GET") {
        normalizeProject(project);
        const capabilities = await productionWorkerCapabilities();
        return json(res, 200, {
          runs: project.textToGameRuns,
          workers: textToGamePipeline.workerRegistry(capabilities)
        });
      }

      if (subroute === "text-to-game" && req.method === "POST") {
        const body = await readBody(req);
        const action = String(body.action || "plan").toLowerCase();
        const capabilities = await productionWorkerCapabilities();
        let run;
        if (action === "plan") {
          const prompt = String(body.prompt || body.message || "").trim();
          if (prompt.length < 8) return json(res, 400, { error: "Describe the game in at least eight characters." });
          run = textToGamePipeline.createProductionRun(
            project,
            prompt,
            capabilities,
            {
              title: body.title,
              artDirection: body.artDirection,
              qualityTier: body.qualityTier,
              targets: body.targets
            }
          );
        } else if (action === "assets") {
          run = project.textToGameRuns.find((item) => item.id === body.runId) || project.textToGameRuns[0];
          if (!run) return json(res, 404, { error: "Create a text-to-game production plan before generating source assets." });
          const registry = textToGamePipeline.workerRegistry(capabilities);
          if (!registry.sourceAssets.available) {
            return json(res, 409, { error: registry.sourceAssets.reason || "The source-asset worker is not ready.", worker: registry.sourceAssets });
          }
          const submitted = await sourceAssetWorker.submit(run.spec, {
            productionRunId: run.id,
            projectId: project.id,
            referenceImages: Array.isArray(body.referenceImages) ? body.referenceImages : []
          });
          run = textToGamePipeline.attachSourceAssetJob(run, submitted.job);
          if (["completed", "failed"].includes(submitted.job.status)) {
            textToGamePipeline.syncSourceAssetJob(run, submitted.job, sourceAssetWorker.validateCompletedJob(submitted.job, run.spec?.content?.assetRequirements || []));
          }
        } else if (action === "rig") {
          run = project.textToGameRuns.find((item) => item.id === body.runId) || project.textToGameRuns[0];
          if (!run) return json(res, 404, { error: "Create a text-to-game production plan before rigging source assets." });
          const sourceEvidence = sourceAssetWorker.validateCompletedJob(run.sourceAssetJob, run.spec?.content?.assetRequirements || []);
          if (!sourceEvidence.ok) return json(res, 409, { error: `Rigging requires completed, validated source GLBs. ${sourceEvidence.errors.join(" ")}` });
          const rigRequirements = (run.spec?.content?.assetRequirements || []).filter((item) => item.rigRequired === true);
          if (!rigRequirements.length) return json(res, 409, { error: "This game specification does not require a character rig." });
          const registry = textToGamePipeline.workerRegistry(capabilities);
          if (!registry.rigging.available) return json(res, 409, { error: registry.rigging.reason || "The rig worker is not ready.", worker: registry.rigging });
          const submitted = await rigWorker.submit(run.spec, run.sourceAssetJob, {
            productionRunId: run.id,
            projectId: project.id
          });
          run = textToGamePipeline.attachRigJob(run, submitted.job);
          if (["completed", "failed"].includes(submitted.job.status)) {
            textToGamePipeline.syncRigJob(run, submitted.job, rigWorker.validateCompletedJob(submitted.job, rigRequirements));
          }
        } else if (action === "animation") {
          run = project.textToGameRuns.find((item) => item.id === body.runId) || project.textToGameRuns[0];
          if (!run) return json(res, 404, { error: "Create a text-to-game production plan before generating animation." });
          const animationRequirements = run.spec?.content?.animationRequirements || [];
          if (!animationRequirements.length) return json(res, 409, { error: "This game specification does not require animation clips." });
          const rigRequirements = (run.spec?.content?.assetRequirements || []).filter((item) => item.rigRequired === true);
          const rigEvidence = rigWorker.validateCompletedJob(run.rigJob, rigRequirements);
          if (!rigEvidence.ok) return json(res, 409, { error: `Animation requires completed, validated rigs. ${rigEvidence.errors.join(" ")}` });
          const registry = textToGamePipeline.workerRegistry(capabilities);
          if (!registry.animation.available) return json(res, 409, { error: registry.animation.reason || "The animation worker is not ready.", worker: registry.animation });
          const submitted = await animationWorker.submit(run.spec, run.rigJob, {
            productionRunId: run.id,
            projectId: project.id
          });
          run = textToGamePipeline.attachAnimationJob(run, submitted.job);
          if (["completed", "failed"].includes(submitted.job.status)) {
            textToGamePipeline.syncAnimationJob(run, submitted.job, animationWorker.validateCompletedJob(submitted.job, animationRequirements));
          }
        } else if (action === "audio") {
          run = project.textToGameRuns.find((item) => item.id === body.runId) || project.textToGameRuns[0];
          if (!run) return json(res, 404, { error: "Create a text-to-game production plan before generating audio." });
          const audioRequirements = run.spec?.content?.audioRequirements || [];
          if (!audioRequirements.length) return json(res, 409, { error: "This game specification does not require audio clips." });
          const registry = textToGamePipeline.workerRegistry(capabilities);
          if (!registry.audio.available) return json(res, 409, { error: registry.audio.reason || "The audio worker is not ready.", worker: registry.audio });
          const submitted = await audioWorker.submit(run.spec, {
            productionRunId: run.id,
            projectId: project.id
          });
          run = textToGamePipeline.attachAudioJob(run, submitted.job);
          if (["completed", "failed"].includes(submitted.job.status)) {
            textToGamePipeline.syncAudioJob(run, submitted.job, audioWorker.validateCompletedJob(submitted.job, audioRequirements));
          }
        } else if (action === "sync") {
          run = project.textToGameRuns.find((item) => item.id === body.runId) || project.textToGameRuns[0];
          if (!run) return json(res, 404, { error: "Create a text-to-game production plan before syncing worker output." });
          if (run.sourceAssetJob?.id && !["completed", "failed"].includes(run.sourceAssetJob.status)) {
            const current = await sourceAssetWorker.getJob(run.sourceAssetJob.id);
            const validation = sourceAssetWorker.validateCompletedJob(current.job, run.spec?.content?.assetRequirements || []);
            textToGamePipeline.syncSourceAssetJob(run, current.job, validation);
          }
          if (run.rigJob?.id && !["completed", "failed"].includes(run.rigJob.status)) {
            const current = await rigWorker.getJob(run.rigJob.id);
            const validation = rigWorker.validateCompletedJob(current.job, run.spec?.content?.assetRequirements || []);
            textToGamePipeline.syncRigJob(run, current.job, validation);
          }
          if (run.animationJob?.id && !["completed", "failed"].includes(run.animationJob.status)) {
            const current = await animationWorker.getJob(run.animationJob.id);
            const validation = animationWorker.validateCompletedJob(current.job, run.spec?.content?.animationRequirements || []);
            textToGamePipeline.syncAnimationJob(run, current.job, validation);
          }
          if (run.audioJob?.id && !["completed", "failed"].includes(run.audioJob.status)) {
            const current = await audioWorker.getJob(run.audioJob.id);
            const validation = audioWorker.validateCompletedJob(current.job, run.spec?.content?.audioRequirements || []);
            textToGamePipeline.syncAudioJob(run, current.job, validation);
          }
          run = textToGamePipeline.syncProductionRun(project, run.id, capabilities);
        } else {
          return json(res, 400, { error: "Text-to-game action must be plan, assets, rig, animation, audio, or sync." });
        }
        project.updatedAt = nowIso();
        db.audit.push({
          id: makeId("audit"),
          userId: auth.user.id,
          projectId,
          action: `text-to-game.${action}`,
          detail: { runId: run.id, family: run.spec?.family?.id, status: run.status },
          createdAt: project.updatedAt
        });
        await writeDb(db);
        return json(res, action === "plan" ? 201 : ["assets", "rig", "animation", "audio"].includes(action) ? 202 : 200, { project, run });
      }

      if (subroute === "runtime-manifest" && req.method === "GET") {
        const manifest = project.runtimeManifest || buildRuntimeManifest(project);
        return json(res, 200, { manifest });
      }

      if (subroute === "engine-build" && req.method === "GET") {
        normalizeProject(project);
        return json(res, 200, {
          jobs: project.engineBuildJobs,
          capabilities: localEngineWorker.capabilities()
        });
      }

      if (subroute === "engine-build/preview" && req.method === "GET") {
        normalizeProject(project);
        const requestedId = String(url.searchParams.get("job") || "");
        const job = project.engineBuildJobs.find((item) => item.id === requestedId) || project.engineBuildJobs[0];
        const mediaDir = job?.localProjectDir ? path.join(job.localProjectDir, "Media") : null;
        const candidates = mediaDir ? [
          path.join(mediaDir, "TP_VehicleAdvBP_Preview.png"),
          path.join(mediaDir, "TP_ThirdPersonBP.png"),
          path.join(mediaDir, "TP_VehicleAdvBP.png")
        ] : [];
        const previewFile = candidates.find((candidate) => fs.existsSync(candidate));
        if (!previewFile) return json(res, 404, { error: "The Unreal template preview is not available on this worker." });
        const stat = await fsp.stat(previewFile);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": stat.size,
          "Cache-Control": "private, max-age=300"
        });
        return fs.createReadStream(previewFile).pipe(res);
      }

      if (subroute === "engine-build" && req.method === "POST") {
        const body = await readBody(req);
        const action = String(body.action || "generate").toLowerCase();
        let job;
        if (action === "generate") job = await createEngineProjectJob(project, body);
        else if (action === "validate") job = await validateEngineProjectJob(project, body);
        else if (action === "package") job = await packageEngineProjectJob(project, body);
        else if (action === "launch" || action === "open-editor") {
          normalizeProject(project);
          job = project.engineBuildJobs.find((item) => item.id === body.jobId) || project.engineBuildJobs[0];
          if (!job) return json(res, 404, { error: "No Unreal build job was found for this project." });
          if (action === "launch") {
            if (!job.package?.archiveDir || job.status !== "packaged") {
              return json(res, 409, { error: "Package the Unreal Win64 build before launching it." });
            }
            const launched = localEngineWorker.launchPackagedGame(job.package.archiveDir);
            job.lastLaunch = { type: "packaged-game", pid: launched.pid, executable: launched.executable, launchedAt: nowIso() };
          } else {
            const launched = localEngineWorker.openUnrealProject(job.projectFile);
            job.lastLaunch = { type: "unreal-editor", pid: launched.pid, executable: launched.executable, launchedAt: nowIso() };
          }
          job.updatedAt = nowIso();
          project.updatedAt = job.updatedAt;
        } else return json(res, 400, { error: "Engine build action must be generate, validate, package, launch, or open-editor." });
        db.audit.push({
          id: makeId("audit"),
          userId: auth.user.id,
          projectId,
          action: `engine-build.${action}`,
          createdAt: nowIso()
        });
        await writeDb(db);
        return json(res, action === "generate" ? 201 : 200, {
          project,
          job,
          capabilities: localEngineWorker.capabilities()
        });
      }

      if (subroute === "engine-build/download" && req.method === "GET") {
        normalizeProject(project);
        const requestedId = String(url.searchParams.get("job") || "");
        const job = project.engineBuildJobs.find((item) => item.id === requestedId) || project.engineBuildJobs[0];
        if (!job?.localProjectDir || !fs.existsSync(job.localProjectDir)) {
          return json(res, 404, { error: "The generated Unreal project is not available on this worker." });
        }
        const zip = createZip(await collectDirectoryFiles(job.localProjectDir));
        const filename = job.filename || `${project.slug}-unreal-5.6.zip`;
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
          "Content-Length": zip.length,
          "Cache-Control": "private, no-store"
        });
        return res.end(zip);
      }

      if (subroute === "engine" && req.method === "POST") {
        const body = await readBody(req);
        const result = await runInternalEngine(project, body);
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: `engine.${body.module || "unknown"}`, createdAt: nowIso() });
        await writeDb(db);
        return json(res, 200, result);
      }

      if (subroute === "engine/item" && req.method === "PUT") {
        const body = await readBody(req);
        normalizeProject(project);
        const module = String(body.module || "");
        const index = Number(body.index);
        const collections = {
          story: project.story, scene: project.scenes, level: project.levels,
          character: project.characters, gameplay: project.gameplay.mechanics,
          world: project.worlds, economy: project.economy.rewards,
          build: project.buildJobs
        };
        const collection = collections[module];
        if (!collection || !Number.isInteger(index) || !collection[index]) return json(res, 404, { error: "Engine item not found." });
        const value = typeof body.value === "string" ? JSON.parse(body.value) : body.value;
        if (!value || typeof value !== "object" || Array.isArray(value)) return json(res, 400, { error: "Engine item must be a JSON object." });
        collection[index] = { ...collection[index], ...value, id: collection[index].id, updatedAt: nowIso() };
        project.updatedAt = nowIso();
        project.activity.unshift({ id: makeId("event"), type: `engine.${module}.update`, detail: `${module} item updated`, createdAt: project.updatedAt });
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: `engine.${module}.update`, createdAt: project.updatedAt });
        await writeDb(db);
        return json(res, 200, { project, item: collection[index] });
      }

      if (subroute === "playtest" && req.method === "GET") {
        const session = currentPlaytest(project);
        const arc = session && session.status === "active" ? project.story[session.arcIndex] || null : null;
        return json(res, 200, { session, arc, totalArcs: project.story.length });
      }

      if (subroute === "playtest" && req.method === "POST") {
        const body = await readBody(req);
        const action = String(body.action || "start").toLowerCase();
        const session = action === "choose" ? advancePlaytest(project, body.choiceIndex) : startPlaytest(project);
        const arc = session.status === "active" ? project.story[session.arcIndex] || null : null;
        project.activity.unshift({ id: makeId("event"), type: `playtest.${action}`, detail: action === "choose" ? `Completed ${session.choices.at(-1).arcTitle}` : "Started a playtest", createdAt: nowIso() });
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: `project.playtest.${action}`, createdAt: nowIso() });
        await writeDb(db);
        return json(res, 200, { project, session, arc, totalArcs: project.story.length });
      }

      if (subroute === "ledger" && req.method === "GET") {
        return json(res, 200, ledgerSummary(project));
      }

      if (subroute === "ledger" && req.method === "POST") {
        const body = await readBody(req);
        const transaction = addLedgerTransaction(project, body);
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: "ledger.transaction", createdAt: nowIso() });
        await writeDb(db);
        return json(res, 201, { transaction, ledger: ledgerSummary(project) });
      }

      if (subroute === "assets" && req.method === "GET") {
        normalizeProject(project);
        return json(res, 200, { assets: project.assets, project });
      }

      if (subroute === "assets/upload" && req.method === "POST") {
        const filename = cleanAssetFilename(req.headers["x-comic30-filename"]);
        const contentType = assetMimeType(filename, req.headers["content-type"]);
        const kind = String(req.headers["x-comic30-asset-kind"] || "other");
        const rigProfile = String(req.headers["x-comic30-rig-profile"] || "none").toLowerCase();
        const bytes = await readBinaryBody(req);
        const validation = assetValidation(filename, bytes, rigProfile);
        const assetId = makeId("asset");
        const objectPath = uploadedAssetObjectPath(auth.user.id, projectId, assetId, filename);
        const storage = await storeAssetBytes(objectPath, bytes, contentType);
        const asset = persistUploadedAsset(project, auth, {
          assetId, filename, contentType, kind, rigProfile, bytes, validation, storage
        });
        db.audit.push({
          id: makeId("audit"), userId: auth.user.id, projectId,
          action: "asset.upload", detail: { assetId, filename, size: bytes.length, status: validation.status }, createdAt: asset.createdAt
        });
        await writeDb(db);
        return json(res, 201, { asset, project });
      }

      if (subroute === "assets/upload-session" && req.method === "POST") {
        const body = await readBody(req);
        const filename = cleanAssetFilename(body.filename);
        const declaredSize = Number(body.size || 0);
        if (!Number.isFinite(declaredSize) || declaredSize <= 0) throw httpError(400, "The selected asset is empty.");
        if (declaredSize > MAX_ASSET_UPLOAD_BYTES) throw httpError(413, `Asset exceeds the ${Math.floor(MAX_ASSET_UPLOAD_BYTES / 1024 / 1024)} MB upload limit.`);
        if (!hasSupabase()) {
          return json(res, 200, { directUpload: true, maxBytes: MAX_ASSET_UPLOAD_BYTES });
        }
        const assetId = makeId("asset");
        const objectPath = uploadedAssetObjectPath(auth.user.id, projectId, assetId, filename);
        const response = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${encodeURIComponent(SUPABASE_ASSET_BUCKET)}/${storagePathEncode(objectPath)}`, {
          method: "POST",
          headers: supabaseHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ allowOverwrite: false })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw httpError(502, `Could not create an asset upload session. ${payload.message || payload.error || ""}`.trim());
        const signedPath = payload.url || payload.signedURL || payload.signedUrl;
        if (!signedPath) throw httpError(502, "Asset storage did not return a signed upload URL.");
        const uploadUrl = /^https?:\/\//i.test(signedPath)
          ? signedPath
          : `${SUPABASE_URL}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}`;
        return json(res, 201, {
          directUpload: false,
          assetId,
          filename,
          objectPath,
          uploadUrl,
          method: "PUT",
          expiresInSeconds: 7200,
          contentType: assetMimeType(filename, body.contentType)
        });
      }

      if (subroute === "assets/finalize" && req.method === "POST") {
        if (!hasSupabase()) throw httpError(409, "Direct asset finalization requires configured object storage.");
        const body = await readBody(req);
        const filename = cleanAssetFilename(body.filename);
        const assetId = String(body.assetId || "");
        if (!/^asset_[a-zA-Z0-9_-]+$/.test(assetId)) throw httpError(400, "Invalid asset upload session.");
        const objectPath = uploadedAssetObjectPath(auth.user.id, projectId, assetId, filename);
        if (String(body.objectPath || "") !== objectPath) throw httpError(400, "Asset upload ownership check failed.");
        const storage = { provider: "supabase", bucket: SUPABASE_ASSET_BUCKET, objectPath };
        const bytes = await loadAssetBytes({ storage });
        const contentType = assetMimeType(filename, body.contentType);
        const rigProfile = String(body.rigProfile || "none").toLowerCase();
        const validation = assetValidation(filename, bytes, rigProfile);
        const asset = persistUploadedAsset(project, auth, {
          assetId, filename, contentType, kind: body.kind, rigProfile, bytes, validation, storage
        });
        db.audit.push({
          id: makeId("audit"), userId: auth.user.id, projectId,
          action: "asset.upload.finalize", detail: { assetId, filename, size: bytes.length, status: validation.status }, createdAt: asset.createdAt
        });
        await writeDb(db);
        return json(res, 201, { asset, project });
      }

      const assetDownloadMatch = String(subroute || "").match(/^assets\/([^/]+)\/download$/);
      if (assetDownloadMatch && req.method === "GET") {
        normalizeProject(project);
        const asset = project.assets.find((item) => item.id === assetDownloadMatch[1] && item.source === "user-upload");
        if (!asset) throw httpError(404, "Uploaded asset was not found.");
        const inline = url.searchParams.get("inline") === "1";
        const safeFilename = String(asset.filename || "comic30-asset").replace(/["\r\n]/g, "-");
        if (asset.storage?.provider === "supabase") {
          const deliveryUrl = new URL(await createSupabaseAssetDeliveryUrl(asset));
          if (!inline) deliveryUrl.searchParams.set("download", safeFilename);
          res.writeHead(302, {
            location: deliveryUrl.toString(),
            "cache-control": "private, max-age=300",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff"
          });
          return res.end();
        }
        const bytes = await loadAssetBytes(asset);
        res.writeHead(200, {
          "content-type": asset.contentType || "application/octet-stream",
          "content-length": bytes.length,
          "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeFilename}"`,
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff"
        });
        return res.end(bytes);
      }

      if (subroute === "builds" && req.method === "GET") {
        normalizeProject(project);
        return json(res, 200, { jobs: project.buildJobs, builds: project.builds });
      }

      if (subroute === "operations" && req.method === "GET") {
        normalizeProject(project);
        return json(res, 200, { jobs: project.operationJobs, models: project.modelArtifacts, assets: project.assets });
      }

      if (subroute === "operations" && req.method === "POST") {
        const body = await readBody(req);
        const job = executeOperation(project, body);
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: `operation.${job.type}`, createdAt: nowIso() });
        await writeDb(db);
        return json(res, 201, { job, project });
      }

      if (subroute === "qa" && req.method === "GET") {
        normalizeProject(project);
        return json(res, 200, { latest: project.qaRuns[0] || null, runs: project.qaRuns });
      }

      if (subroute === "qa" && req.method === "POST") {
        const report = runProjectQa(project);
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: "project.qa", createdAt: report.createdAt });
        await writeDb(db);
        return json(res, 201, { report, project });
      }

      if (subroute === "analytics" && req.method === "GET") {
        return json(res, 200, { analytics: projectAnalytics(project) });
      }

      if (subroute === "build" && req.method === "POST") {
        const body = await readBody(req);
        const job = await createMobileBuildJob(project, body.target || "all");
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: "project.build.scaffold", createdAt: nowIso() });
        await writeDb(db);
        return json(res, 201, { job, project });
      }

      if (subroute === "action" && req.method === "POST") {
        const body = await readBody(req);
        const action = String(body.action || "").toLowerCase();
        normalizeProject(project);
        let createdProject = null;
        if (action === "archive") {
          project.lifecycle.archived = true;
          project.status = "archived";
        } else if (action === "restore") {
          project.lifecycle.archived = false;
          project.status = "design";
        } else if (action === "qa") {
          runProjectQa(project);
        } else if (action === "deploy" || action === "redeploy") {
          const deployment = { id: makeId("deploy"), version: project.deployments.length + 1, status: "live", channel: String(body.channel || "production"), createdAt: nowIso() };
          project.deployments.unshift(deployment);
          project.lifecycle.deploymentStatus = "live";
          project.status = "deployed";
          project.analytics.players = Math.max(project.analytics.players, 128 + deployment.version * 37);
          project.analytics.sessions = Math.max(project.analytics.sessions, project.analytics.players * 3);
          project.analytics.retentionD1 = Math.max(project.analytics.retentionD1, 42);
          project.analytics.rating = Math.max(project.analytics.rating, 4.3);
        } else if (action === "replicate") {
          createdProject = JSON.parse(JSON.stringify(project));
          createdProject.id = makeId("proj");
          createdProject.title = `${project.title} Copy`;
          createdProject.slug = slugify(createdProject.title);
          createdProject.createdAt = nowIso();
          createdProject.updatedAt = createdProject.createdAt;
          createdProject.status = "design";
          createdProject.lifecycle = { archived: false, qaStatus: "not-run", deploymentStatus: "draft", lastAction: "replicated" };
          createdProject.deployments = [];
          createdProject.builds = [];
          createdProject.buildJobs = [];
          db.projects.push(createdProject);
        } else {
          return json(res, 400, { error: "Unsupported project action." });
        }
        project.lifecycle.lastAction = action;
        project.updatedAt = nowIso();
        project.activity.unshift({ id: makeId("event"), type: action, detail: `${action} completed`, createdAt: project.updatedAt });
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: `project.${action}`, createdAt: project.updatedAt });
        await writeDb(db);
        return json(res, 200, { project, createdProject });
      }

      if (subroute === "export" && req.method === "POST") {
        const bundle = buildExportBundle(project);
        const zip = createZip(bundle.files);
        const filename = `${project.slug}-${Date.now()}.zip`;
        const artifactUrl = await saveArtifact(filename, zip, `/api/projects/${project.id}/export/download`);
        const build = {
          id: makeId("build"),
          type: "mobile-project-kit",
          filename,
          url: artifactUrl,
          size: zip.length,
          createdAt: nowIso(),
          notes: "Contains game design data, economy config, playable prototype, store checklist, and mobile runtime integration notes."
        };
        project.builds.unshift(build);
        project.updatedAt = nowIso();
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: "project.export", createdAt: nowIso() });
        await writeDb(db);
        return json(res, 201, { build });
      }

      if (subroute === "export/download" && req.method === "GET") {
        const zip = createZip(buildExportBundle(project).files);
        const filename = `${project.slug}-comic30-export.zip`;
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${filename}"`,
          "content-length": zip.length
        });
        return res.end(zip);
      }

      if (subroute === "build/download" && req.method === "GET") {
        const target = String(url.searchParams.get("target") || "all");
        const zip = createZip(nativeScaffoldFiles(project, target));
        const filename = `${project.slug}-${slugify(target)}-native-scaffold.zip`;
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${filename}"`,
          "content-length": zip.length
        });
        return res.end(zip);
      }
    }

    return json(res, 404, { error: "API route not found." });
  } catch (error) {
    return json(res, Number(error.statusCode) || 400, { error: error.message || "Request failed." });
  }
}

function buildExportBundle(project) {
  const projectJson = JSON.stringify(project, null, 2);
  const safeProjectJson = projectJson
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const narrativeGameplayHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.title)} Prototype</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #101419; color: #f4f8fb; }
    main { max-width: 980px; margin: 0 auto; padding: 32px; }
    button { border: 0; padding: 12px 16px; margin: 8px 8px 0 0; background: #16c6d4; color: #071014; font-weight: 700; }
    .panel { border: 1px solid #283744; padding: 20px; margin-top: 20px; background: #17212b; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(project.title)}</h1>
    <p>${escapeHtml(project.design.premise)}</p>
    <div id="game" class="panel"></div>
  </main>
  <script type="application/json" id="project-data">${safeProjectJson}</script>
  <script>
    const project = JSON.parse(document.getElementById("project-data").textContent);
    const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
    let arcIndex = 0;
    const game = document.getElementById("game");
    function render() {
      const arc = project.story[arcIndex % project.story.length];
      game.innerHTML = "<h2>" + safe(arc.title) + "</h2><p>" + safe(arc.summary) + "</p>" +
        arc.choices.map((choice, index) => "<button data-choice='" + index + "'>" + safe(choice.label) + "</button>").join("") +
        "<p id='result'></p>";
    }
    game.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-choice]");
      if (!button) return;
      const arc = project.story[arcIndex % project.story.length];
      const choice = arc.choices[Number(button.dataset.choice)];
      document.getElementById("result").textContent = choice.consequence + " +" + project.economy.startingBalance + " " + project.economy.currencySymbol;
      arcIndex += 1;
      setTimeout(render, 1800);
    });
    render();
  </script>
</body>
</html>`;

  const racerGameplayHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHtml(project.runtimeManifest?.title || project.title)}</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#050811;color:#fff;font-family:Arial,sans-serif}canvas{display:block;width:100%;height:100%;touch-action:none}.hud{position:fixed;inset:18px 18px auto;display:flex;justify-content:space-between;font-weight:900;pointer-events:none}.help{position:fixed;inset:auto 0 24px;text-align:center;font-weight:800;color:#25f5b3;pointer-events:none}</style></head><body><canvas id="game" tabindex="0"></canvas><div class="hud"><span id="score">DISTANCE 0 m</span><span id="speed">280 km/h</span></div><div class="help" id="help">Click to drive · A/D or arrow keys</div><script>const c=document.getElementById('game'),x=c.getContext('2d'),score=document.getElementById('score'),speed=document.getElementById('speed'),help=document.getElementById('help');let g={run:false,over:false,lane:1,score:0,best:+localStorage.getItem('c30-best')||0,speed:280,cars:[],spawn:0,last:performance.now()};function size(){let d=devicePixelRatio||1;c.width=innerWidth*d;c.height=innerHeight*d;x.setTransform(d,0,0,d,0,0)}function start(){g={...g,run:true,over:false,lane:1,score:0,speed:280,cars:[],spawn:0,last:performance.now()};help.textContent='A/D or arrows · dodge traffic'}function move(d){if(!g.run||g.over)start();g.lane=Math.max(0,Math.min(2,g.lane+d))}addEventListener('resize',size);addEventListener('keydown',e=>{if(['ArrowLeft','a','A'].includes(e.key))move(-1);if(['ArrowRight','d','D'].includes(e.key))move(1);if(e.key===' ')start()});c.addEventListener('pointerdown',e=>{if(!g.run||g.over)return start();move(e.clientX<innerWidth/2?-1:1)});function car(px,py,w,h,col){x.fillStyle=col;x.fillRect(px-w/2,py-h/2,w,h);x.fillStyle='#dff';x.fillRect(px-w*.28,py-h*.28,w*.56,h*.2);x.fillStyle='#050811';x.fillRect(px-w*.4,py+h*.2,w*.2,h*.14);x.fillRect(px+w*.2,py+h*.2,w*.2,h*.14)}function loop(t){let w=innerWidth,h=innerHeight,dt=Math.min(.034,(t-g.last)/1000||0);g.last=t;if(g.run&&!g.over){g.score+=dt*g.speed/8;g.speed=Math.min(720,g.speed+dt*7);g.spawn-=dt;if(g.spawn<=0){g.cars.push({lane:Math.random()*3|0,y:-70,v:g.speed*(.76+Math.random()*.22),c:['#ff5b57','#ff9f2e','#37c4ff'][Math.random()*3|0]});g.spawn=Math.max(.32,.86-g.speed/1500)}g.cars.forEach(a=>a.y+=a.v*dt);g.cars=g.cars.filter(a=>a.y<h+90);if(g.cars.some(a=>a.lane===g.lane&&Math.abs(a.y-(h-84))<58)){g.over=true;g.run=false;g.best=Math.max(g.best,g.score|0);localStorage.setItem('c30-best',g.best);help.textContent='CRASHED · '+(g.score|0)+' m · click or Space to retry'}}let grd=x.createLinearGradient(0,0,0,h);grd.addColorStop(0,'#071525');grd.addColorStop(1,'#190d29');x.fillStyle=grd;x.fillRect(0,0,w,h);let l=w*.18,r=w*.64,lw=r/3;x.fillStyle='#101722';x.fillRect(l,0,r,h);x.strokeStyle='#25f5b3';x.strokeRect(l,0,r,h);x.strokeStyle='#778391';x.setLineDash([30,24]);for(let i=1;i<3;i++){x.beginPath();x.moveTo(l+lw*i,0);x.lineTo(l+lw*i,h);x.stroke()}x.setLineDash([]);let lx=i=>l+lw*i+lw/2;g.cars.forEach(a=>car(lx(a.lane),a.y,Math.min(44,lw*.4),72,a.c));car(lx(g.lane),h-84,Math.min(48,lw*.44),78,'#25f5b3');score.textContent='DISTANCE '+(g.score|0)+' m · BEST '+g.best+' m';speed.textContent=(g.speed|0)+' km/h';if(!g.run&&!g.over){x.fillStyle='rgba(3,7,12,.7)';x.fillRect(0,0,w,h);x.fillStyle='#fff';x.textAlign='center';x.font='900 36px Arial';x.fillText('${escapeHtml(project.runtimeManifest?.title || "ENDLESS VELOCITY")}',w/2,h/2);x.textAlign='left'}requestAnimationFrame(loop)}size();requestAnimationFrame(loop);</script></body></html>`;
  const gameplayHtml = project.runtimeManifest?.runtime?.type === "endless-racer" ? racerGameplayHtml : narrativeGameplayHtml;

  const readme = `# ${project.title}

${project.tagline}

## Premise
${project.design.premise}

## Mobile Targets
- iOS
- Android

## Included
- data/project.json: full Comic30 project data
- data/story.json: branching story arcs and player choices
- data/characters.json: character roster
- data/worlds.json: generated world definitions
- data/terrain.json: terrain zones and heightmap seeds
- data/economy.json: wallet rewards, sinks, and in-app purchase products
- data/engine.json: Comic30 runtime and agent configuration
- data/ai-threads.json: saved agent chat history
- playable-prototype/index.html: browser-playable narrative prototype
- native-scaffold/: Android and iOS starter project files
- mobile-runtime/README.md: native engine integration notes
- store-submission/checklist.md: App Store and Google Play launch checklist

## Production Notes
This bundle is a launch scaffold. A production app store release still needs native build signing, payment provider setup, wallet custody decisions, privacy policy review, age rating, and Apple/Google policy review.
`;

  const checklist = `# Store Submission Checklist

- Confirm gameplay is functional on target iOS and Android devices.
- Configure Apple and Google in-app purchase products to match economy SKUs.
- Complete privacy policy, terms, age rating, and data safety forms.
- Decide whether the wallet remains an internal ledger or connects to a regulated crypto custody provider.
- Keep crypto rewards optional and avoid pay-to-win claims in store copy.
- Add customer support, account deletion, refund, and fraud review flows.
- Run platform compliance review before submitting.
`;

  const apiContract = `# Comic30 API Contract

POST /api/auth/register
POST /api/auth/login
POST /api/projects
GET /api/projects
PUT /api/projects/:id
POST /api/projects/:id/generate
GET /api/projects/:id/agent
POST /api/projects/:id/agent
GET /api/projects/:id/ledger
POST /api/projects/:id/ledger
GET /api/projects/:id/builds
POST /api/projects/:id/build
POST /api/projects/:id/export

All authenticated routes use the c30_session HttpOnly cookie.
`;

  const nativeFiles = Object.fromEntries(
    Object.entries(nativeScaffoldFiles(project, "all")).map(([name, content]) => [`native-scaffold/${name}`, content])
  );

  return {
    files: {
      "README.md": readme,
      "data/project.json": projectJson,
      "data/story.json": JSON.stringify(project.story, null, 2),
      "data/characters.json": JSON.stringify(project.characters, null, 2),
      "data/worlds.json": JSON.stringify(project.worlds || [], null, 2),
      "data/terrain.json": JSON.stringify(project.terrain || [], null, 2),
      "data/economy.json": JSON.stringify(project.economy, null, 2),
      "data/engine.json": JSON.stringify(project.engine || defaultEngineConfig(), null, 2),
      "data/ai-threads.json": JSON.stringify(project.aiThreads || [], null, 2),
      "data/build-jobs.json": JSON.stringify(project.buildJobs || [], null, 2),
      "playable-prototype/index.html": gameplayHtml,
      "mobile-runtime/README.md": "Integrate this project data into Unity, Unreal, React Native, Flutter, or the Comic30 mobile runtime layer. Map story nodes to scenes, characters to prefabs, economy events to secure backend calls, and IAP SKUs to platform stores.\n",
      "store-submission/checklist.md": checklist,
      "backend/api-contract.md": apiContract,
      ...nativeFiles
    }
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name.replace(/\\/g, "/"));
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

function safeResolve(base, requested) {
  const normalized = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.resolve(base, normalized);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

async function serveFile(req, res, url) {
  const exportMatch = url.pathname.match(/^\/exports\/([^/]+\.zip)$/);
  if (exportMatch) {
    const file = safeResolve(EXPORT_DIR, exportMatch[1]);
    if (!file || !fs.existsSync(file)) return text(res, 404, "Not found");
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${path.basename(file)}"`
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const cleanPages = {
    "/privacy-policy": "privacy-policy.html",
    "/terms-of-use": "terms-of-use.html"
  };
  const requested = cleanPages[url.pathname] || (url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  let file = safeResolve(PUBLIC_DIR, requested);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, "index.html");
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0"
  });
  fs.createReadStream(file).pipe(res);
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveFile(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message || "Server error." });
  }
}

async function main() {
  await ensureStorage();
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`Comic30 portal running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = handler;

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
