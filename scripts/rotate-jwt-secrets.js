#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");

const envPath = process.argv[2] || ".env";
if (!fs.existsSync(envPath)) {
  console.error(`.env not found at ${envPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(envPath, "utf8");
const lines = raw.split(/\r?\n/);

function getValue(key) {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  if (!line) return null;
  return line.slice(key.length + 1);
}

const current = getValue("JWT_SECRET_CURRENT");
if (!current) {
  console.error("JWT_SECRET_CURRENT is missing; aborting rotation.");
  process.exit(1);
}

const newSecret = crypto.randomBytes(48).toString("hex");
let nextLines = [];
let hasPrev = false;
let hasCurrent = false;

for (const line of lines) {
  if (line.startsWith("JWT_SECRET_PREVIOUS=")) {
    nextLines.push(`JWT_SECRET_PREVIOUS=${current}`);
    hasPrev = true;
    continue;
  }
  if (line.startsWith("JWT_SECRET_CURRENT=")) {
    nextLines.push(`JWT_SECRET_CURRENT=${newSecret}`);
    hasCurrent = true;
    continue;
  }
  nextLines.push(line);
}

if (!hasPrev) {
  nextLines.push(`JWT_SECRET_PREVIOUS=${current}`);
}
if (!hasCurrent) {
  nextLines.push(`JWT_SECRET_CURRENT=${newSecret}`);
}

fs.writeFileSync(envPath, nextLines.join("\n"), "utf8");

console.log("JWT secrets rotated.");
console.log("- JWT_SECRET_PREVIOUS set to old current secret");
console.log("- JWT_SECRET_CURRENT set to new secret");
console.log("Reminder: deploy and keep previous until tokens expire.");
