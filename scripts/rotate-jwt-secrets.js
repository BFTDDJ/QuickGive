#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const envFileArg = process.argv.find((arg) => arg.startsWith("--env-file="));
const envFilePath = path.resolve(
  process.cwd(),
  envFileArg ? envFileArg.slice("--env-file=".length) : ".env"
);

function parseEnv(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    values[match[1]] = match[2];
  }

  return values;
}

function updateEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }

  const suffix = contents.endsWith("\n") ? "" : "\n";
  return `${contents}${suffix}${line}\n`;
}

function loadCurrentSecret() {
  if (process.env.JWT_SECRET_CURRENT) {
    return {
      source: "process.env",
      value: process.env.JWT_SECRET_CURRENT
    };
  }

  if (!fs.existsSync(envFilePath)) {
    return null;
  }

  const envContents = fs.readFileSync(envFilePath, "utf8");
  const envValues = parseEnv(envContents);

  if (!envValues.JWT_SECRET_CURRENT) {
    return null;
  }

  return {
    source: envFilePath,
    value: envValues.JWT_SECRET_CURRENT
  };
}

const current = loadCurrentSecret();

if (!current) {
  console.error("JWT rotation failed: JWT_SECRET_CURRENT was not found in process.env or the env file.");
  process.exit(1);
}

const newCurrent = crypto.randomBytes(48).toString("hex");

console.log("JWT rotation plan");
console.log("=================");
console.log(`Current secret source: ${current.source}`);
console.log("");
console.log("Set these values in DigitalOcean App Platform:");
console.log(`JWT_SECRET_PREVIOUS=${current.value}`);
console.log(`JWT_SECRET_CURRENT=${newCurrent}`);
console.log("");
console.log("Then redeploy, wait through the old token TTL, and remove JWT_SECRET_PREVIOUS in a second deploy.");

if (!shouldWrite) {
  console.log("");
  console.log("Dry run only. Nothing was written locally.");
  console.log("Use --write if you intentionally want to update the local env file too.");
  process.exit(0);
}

if (!fs.existsSync(envFilePath)) {
  console.error(`JWT rotation failed: env file not found at ${envFilePath}`);
  process.exit(1);
}

let envContents = fs.readFileSync(envFilePath, "utf8");
envContents = updateEnvValue(envContents, "JWT_SECRET_PREVIOUS", current.value);
envContents = updateEnvValue(envContents, "JWT_SECRET_CURRENT", newCurrent);
fs.writeFileSync(envFilePath, envContents, "utf8");

console.log("");
console.log(`Local env file updated: ${envFilePath}`);
