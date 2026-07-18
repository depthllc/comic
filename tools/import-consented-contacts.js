#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const dbPath = path.join(root, "data", "db.json");

function parseArgs(argv) {
  const args = { commit: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--commit") args.commit = true;
    else if (arg === "--source") args.source = argv[++index];
    else if (arg === "--help") args.help = true;
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => normalizeKey(header));
  return rows.map((values) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = values[index] || "";
    });
    return item;
  });
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function emailFrom(row) {
  return String(row.email || row.email_address || row.e_mail || "").trim().toLowerCase();
}

function consentValue(row) {
  return String(row.consent || row.opt_in || row.optin || row.permission || row.subscribed || "").trim().toLowerCase();
}

function hasConsent(row) {
  const consent = consentValue(row);
  const source = String(row.source || row.consent_source || row.signup_source || "").trim();
  return ["yes", "true", "1", "opt-in", "opt_in", "subscribed", "consented"].includes(consent) && source.length > 1;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function readDb() {
  if (!fs.existsSync(dbPath)) {
    return { users: [], sessions: [], projects: [], audit: [], emailTokens: [], passwordResetTokens: [], contactProfiles: [], importBatches: [], complianceReviews: [] };
  }
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  db.contactProfiles ||= [];
  db.importBatches ||= [];
  db.audit ||= [];
  return db;
}

function contactProfile(row, batchId) {
  const email = emailFrom(row);
  if (!email || !email.includes("@") || !hasConsent(row)) return null;
  const name = String(row.name || row.full_name || `${row.first_name || ""} ${row.last_name || ""}`).trim();
  return {
    id: makeId("contact"),
    email,
    name,
    source: String(row.source || row.consent_source || row.signup_source).trim(),
    consentStatus: "consented",
    consentedAt: row.consented_at || row.opt_in_at || row.signup_date || new Date().toISOString(),
    tags: String(row.tags || row.niche || row.category || "")
      .split(/[;,|]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
    profile: row,
    importBatchId: batchId,
    createdAt: new Date().toISOString()
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.source) {
    console.log("Usage: node tools/import-consented-contacts.js --source contacts.csv [--commit]");
    console.log("Only rows with email + consent/opt_in + source are eligible. XLSX files should be exported to CSV first.");
    process.exit(args.help ? 0 : 1);
  }

  const sourcePath = path.resolve(args.source);
  if (!fs.existsSync(sourcePath)) throw new Error(`File not found: ${sourcePath}`);
  if (!sourcePath.toLowerCase().endsWith(".csv")) throw new Error("Please export spreadsheet data to CSV before importing.");

  const rows = parseCsv(fs.readFileSync(sourcePath, "utf8"));
  const batchId = makeId("batch");
  const db = readDb();
  const existing = new Set(db.contactProfiles.map((profile) => profile.email));
  const eligible = rows.map((row) => contactProfile(row, batchId)).filter(Boolean);
  const ready = eligible.filter((profile) => !existing.has(profile.email));
  const batch = {
    id: batchId,
    userId: null,
    sourceName: path.basename(sourcePath),
    totalRows: rows.length,
    consentedRows: eligible.length,
    duplicateRows: eligible.length - ready.length,
    rejectedRows: rows.length - eligible.length,
    mode: args.commit ? "committed-consented-only" : "preview",
    createdAt: new Date().toISOString()
  };

  if (args.commit) {
    db.contactProfiles.push(...ready);
    db.importBatches.push(batch);
    db.audit.push({
      id: makeId("audit"),
      userId: null,
      action: "contacts.import.cli",
      metadata: batch,
      createdAt: new Date().toISOString()
    });
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  }

  console.log(JSON.stringify({ batch, sample: ready.slice(0, 10) }, null, 2));
}

main();
