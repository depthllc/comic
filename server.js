const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const EXPORT_DIR = path.join(ROOT, "exports");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 5173);
const ONE_WEEK = 1000 * 60 * 60 * 24 * 7;

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
  ".zip": "application/zip"
};

let writeQueue = Promise.resolve();

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
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(EXPORT_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    await writeDb({
      users: [],
      sessions: [],
      projects: [],
      audit: []
    });
  }
}

async function readDb() {
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
  return project;
}

async function writeDb(db) {
  writeQueue = writeQueue.then(async () => {
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_FILE);
  });
  return writeQueue;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
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
      if (size > 1024 * 1024) {
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
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "c30_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
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
    createdAt: user.createdAt
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
    version: "comic30-runtime-0.2",
    agents: ["director", "story", "character", "world", "terrain", "economy", "build"],
    runtimeTargets: ["web-prototype", "android-project", "ios-project"],
    assetPipelines: ["story-json", "terrain-json", "character-rig-manifest", "economy-ledger", "iap-products"],
    compileRequirements: {
      android: ["Android Studio", "JDK 17+", "Gradle", "release keystore"],
      ios: ["macOS", "Xcode", "Apple Developer team", "provisioning profile"]
    }
  };
}

function generateTerrainZone(projectTitle, prompt = "") {
  const seed = crypto.createHash("sha256").update(`${projectTitle}:${prompt}:${Date.now()}`).digest("hex");
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
  if (["story", "character", "world", "terrain", "economy", "build", "all"].includes(requested)) {
    return requested;
  }
  const text = String(prompt || "").toLowerCase();
  if (/(apk|android|ios|ipa|xcode|gradle|build|compile|store|launch|deploy)/.test(text)) return "build";
  if (/(wallet|token|coin|crypto|reward|iap|purchase|economy|ledger|store pack)/.test(text)) return "economy";
  if (/(terrain|map|level|biome|world|environment|city|arena|dungeon)/.test(text)) return "world";
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

function buildAgentReply(project, intent, actions) {
  const actionText = actions.map((item) => item.label).join(", ");
  const targetText = intent === "build" ? "I also generated a mobile scaffold build job you can download from Builds." : "The project blueprint has been updated and saved.";
  return `${targetText} Updated modules: ${actionText || intent}. Current project has ${project.story.length} story arcs, ${project.characters.length} characters, ${project.worlds.length} worlds, ${project.terrain.length} terrain zones, and ${project.economy.iapProducts.length} IAP products.`;
}

async function runCreationAgent(project, input = {}) {
  normalizeProject(project);
  const prompt = String(input.message || input.prompt || input.direction || "").trim();
  if (!prompt) {
    throw new Error("Agent message is required.");
  }
  const intent = classifyAgentIntent(prompt, input.module);
  const thread = ensureAgentThread(project);
  thread.messages.push(createAgentMessage("user", prompt, "creator", { module: intent }));

  const actions = [];
  if (intent === "all" || intent === "story") {
    const arc = makeAgentStoryArc(project, prompt);
    project.story.push(arc);
    actions.push({ type: "story", id: arc.id, label: `story arc: ${arc.title}` });
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
  return { reply, actions, thread, project };
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
  const safeTarget = ["all", "android", "ios"].includes(String(target).toLowerCase()) ? String(target).toLowerCase() : "all";
  const files = nativeScaffoldFiles(project, safeTarget);
  const zip = createZip(files);
  const filename = `${project.slug}-${safeTarget}-native-scaffold-${Date.now()}.zip`;
  const fullPath = path.join(EXPORT_DIR, filename);
  await fsp.writeFile(fullPath, zip);
  const job = {
    id: makeId("job"),
    target: safeTarget,
    status: "scaffolded",
    artifactType: "android-ios-project-scaffold",
    filename,
    url: `/exports/${filename}`,
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
    url: `/exports/${filename}`,
    size: zip.length,
    createdAt: job.createdAt,
    notes: job.notes
  });
  project.updatedAt = nowIso();
  return job;
}

async function handleApi(req, res, url) {
  const db = await readDb();
  cleanExpiredSessions(db);

  try {
    if (url.pathname === "/api/health") {
      return json(res, 200, { ok: true, name: "Comic30 Portal", time: nowIso() });
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
        createdAt: nowIso()
      };
      db.users.push(user);
      const session = createSession(db, user, req);
      db.audit.push({ id: makeId("audit"), userId: user.id, action: "register", createdAt: nowIso() });
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
      db.audit.push({ id: makeId("audit"), userId: user.id, action: "login", createdAt: nowIso() });
      await writeDb(db);
      setSessionCookie(res, session.token, Math.floor(ONE_WEEK / 1000));
      return json(res, 200, { user: publicUser(user) });
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

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/([^/]+))?$/);
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

      if (subroute === "builds" && req.method === "GET") {
        normalizeProject(project);
        return json(res, 200, { jobs: project.buildJobs, builds: project.builds });
      }

      if (subroute === "build" && req.method === "POST") {
        const body = await readBody(req);
        const job = await createMobileBuildJob(project, body.target || "all");
        db.audit.push({ id: makeId("audit"), userId: auth.user.id, projectId, action: "project.build.scaffold", createdAt: nowIso() });
        await writeDb(db);
        return json(res, 201, { job, project });
      }

      if (subroute === "export" && req.method === "POST") {
        const bundle = buildExportBundle(project);
        const zip = createZip(bundle.files);
        const filename = `${project.slug}-${Date.now()}.zip`;
        const fullPath = path.join(EXPORT_DIR, filename);
        await fsp.writeFile(fullPath, zip);
        const build = {
          id: makeId("build"),
          type: "mobile-project-kit",
          filename,
          url: `/exports/${filename}`,
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
    }

    return json(res, 404, { error: "API route not found." });
  } catch (error) {
    return json(res, 400, { error: error.message || "Request failed." });
  }
}

function buildExportBundle(project) {
  const projectJson = JSON.stringify(project, null, 2);
  const safeProjectJson = projectJson
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const gameplayHtml = `<!doctype html>
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

  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  let file = safeResolve(PUBLIC_DIR, requested);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, "index.html");
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

async function main() {
  await ensureStorage();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
      } else {
        await serveFile(req, res, url);
      }
    } catch (error) {
      console.error(error);
      json(res, 500, { error: "Server error." });
    }
  });
  server.listen(PORT, () => {
    console.log(`Comic30 portal running at http://127.0.0.1:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
