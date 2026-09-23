#!/usr/bin/env node

import fs from "node:fs";

const files = ["vercel.json", "apps/frontend/vercel.json"];
const expectedRewrites = ["/login", "/signup", "/dash", "/dash/(.*)", "/overlay/(.*)", "/overlay-test/(.*)"];
const requiredSecurityHeaders = [
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options"
];

let sharedRouting;
for (const file of files) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];
  const rewriteSources = rewrites.map((rewrite) => rewrite?.source);
  if (JSON.stringify(rewriteSources) !== JSON.stringify(expectedRewrites) || rewrites.some((rewrite) => rewrite?.destination !== "/index.html")) {
    throw new Error(`${file} must rewrite only the known client routes to /index.html; missing static assets must remain 404 responses`);
  }

  const headerRules = Array.isArray(config.headers) ? config.headers : [];
  const assetRule = headerRules.find((rule) => rule?.source === "/assets/(.*)");
  const assetCache = headerValue(assetRule, "cache-control");
  if (!assetCache || !/max-age=31536000/i.test(assetCache) || !/immutable/i.test(assetCache)) {
    throw new Error(`${file} must cache hashed /assets files immutably`);
  }

  const globalRule = headerRules.find((rule) => rule?.source === "/(.*)");
  for (const name of requiredSecurityHeaders) {
    if (!headerValue(globalRule, name)) throw new Error(`${file} is missing the ${name} response header`);
  }

  const routing = JSON.stringify({ framework: config.framework, headers: config.headers, rewrites: config.rewrites });
  if (sharedRouting === undefined) sharedRouting = routing;
  else if (routing !== sharedRouting) throw new Error("The root and frontend Vercel routing/security configurations have drifted apart");

  console.log(`${file}: routing, cache, and security headers validated`);
}

const backendUnitFile = "apps/backend/systemd/Openoverlaybackend.service";
const backendUnit = fs.readFileSync(backendUnitFile, "utf8");
for (const line of [
  "Environment=PATH=/usr/bin:/bin",
  "ExecStart=/usr/bin/node dist/gateway.js",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "PrivateDevices=true",
  "ProtectSystem=strict",
  "ProtectHome=true",
  "ReadOnlyPaths=/opt/openoverlay",
  "ReadWritePaths=/var/lib/openoverlay /var/log/openoverlay /run/openoverlay",
  "UMask=0077"
]) {
  if (!backendUnit.split(/\r?\n/).includes(line)) throw new Error(`${backendUnitFile} is missing required setting: ${line}`);
}

const backendDeployFile = "scripts/deploy-backend.sh";
const backendDeploy = fs.readFileSync(backendDeployFile, "utf8");
for (const fragment of [
  "git ls-remote origin refs/heads/main",
  "git fetch origin main",
  "flock -n 9",
  "git switch --detach",
  "npm ci --include=dev",
  "kill -TERM",
  "wait_for_commit",
  "schema_version",
  "refusing incompatible source rollback",
  "rolling back"
]) {
  if (!backendDeploy.includes(fragment)) throw new Error(`${backendDeployFile} is missing required deployment invariant: ${fragment}`);
}
for (const obsolete of ["SELF_UPDATE_ENABLED", "SELF_UPDATE_REPO_DIR", "GATEWAY_RELEASE_DIR"]) {
  if (backendUnit.includes(obsolete)) throw new Error(`${backendUnitFile} still contains obsolete mutable updater setting: ${obsolete}`);
}

const hostDeployFile = "scripts/openoverlay-deploy";
const hostDeploy = fs.readFileSync(hostDeployFile, "utf8");
for (const fragment of [
  "/run/lock/openoverlay-deploy.lock",
  "flock -n 9",
  "MAX_ARCHIVE_BYTES=268435456",
  "tar -tzf",
  "git get-tar-commit-id",
  "restore-verify",
  "BACKUP_CONFIG_FILE",
  "privacyEpoch: shared.openOverlayCompatibility().features?.stage === true ? 1 : 0",
  "assert_promotion_safe",
  "atomic_link",
  "wait_for_release"
]) {
  if (!hostDeploy.includes(fragment)) throw new Error(`${hostDeployFile} is missing required release invariant: ${fragment}`);
}
if (hostDeploy.includes("git pull") || hostDeploy.includes("git fetch")) {
  throw new Error(`${hostDeployFile} must never mutate a Git checkout`);
}

console.log(`${backendUnitFile}: immutable release path and systemd hardening validated`);
console.log(`${backendDeployFile}: direct SSH build, health check, and schema-safe rollback validated`);
console.log(`${hostDeployFile}: immutable promotion, backup, and rollback wiring validated`);

function headerValue(rule, name) {
  if (!rule || !Array.isArray(rule.headers)) return undefined;
  return rule.headers.find((header) => typeof header?.key === "string" && header.key.toLowerCase() === name)?.value;
}
