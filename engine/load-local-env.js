"use strict";

const fs = require("fs");
const path = require("path");

function unquote(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  }
  return text;
}

function loadLocalEnv(filename = ".env") {
  const absolute = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(absolute)) return { loaded: false, path: absolute, count: 0 };
  const lines = fs.readFileSync(absolute, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    process.env[key] = unquote(trimmed.slice(separator + 1));
    count += 1;
  }
  return { loaded: true, path: absolute, count };
}

module.exports = loadLocalEnv;
