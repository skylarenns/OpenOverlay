import fs from "node:fs";
import path from "node:path";

export function restoreBuildSha(release, snapshotBuildSha) {
  const manifestPath = path.join(release, "release-manifest.json");
  if (!fs.existsSync(manifestPath)) return snapshotBuildSha;

  const { releaseSha } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof releaseSha !== "string" || !/^[0-9a-f]{40}$/.test(releaseSha)) {
    throw new Error("Release manifest has an invalid build identity");
  }
  const artifactSha = fs.readFileSync(path.join(release, "apps/backend/dist/.openoverlay-build-commit"), "utf8").trim();
  if (artifactSha !== releaseSha) throw new Error("Release artifact identity does not match its manifest");
  return releaseSha;
}
