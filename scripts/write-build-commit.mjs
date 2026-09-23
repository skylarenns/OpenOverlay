#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const outputDirectory = path.resolve(process.argv[2] || "apps/backend/dist");
const markerPath = path.join(outputDirectory, ".openoverlay-build-commit");
const commit = gitCommit() || firstNonEmpty(process.env.OPENOVERLAY_GIT_SHA, process.env.GIT_COMMIT_SHA, process.env.VERCEL_GIT_COMMIT_SHA);

if (!commit) {
  fs.rmSync(markerPath, { force: true });
  console.warn("Build commit is unavailable; removed any stale backend artifact marker.");
  process.exit(0);
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(markerPath, `${commit}\n`, { encoding: "utf8", mode: 0o644 });
console.log(`Recorded backend artifact commit ${commit.slice(0, 7)}.`);

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
