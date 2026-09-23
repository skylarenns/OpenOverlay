import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { stageRestore } from "../../../../scripts/openoverlay-restore-stage.mjs";
import { restoreBuildSha } from "../../../../scripts/openoverlay-restore-identity.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const backupScript = path.join(repositoryRoot, "scripts/openoverlay-backup.mjs");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("backup and restore evidence", () => {
  it("verifies a restored snapshot with the candidate release identity", () => {
    const fixture = createFixture();
    const release = path.join(fixture.directory, "release");
    const artifact = path.join(release, "apps/backend/dist");
    const snapshotSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    fs.mkdirSync(artifact, { recursive: true });
    fs.writeFileSync(path.join(release, "release-manifest.json"), JSON.stringify({ releaseSha: candidateSha }));
    fs.writeFileSync(path.join(artifact, ".openoverlay-build-commit"), `${candidateSha}\n`);

    expect(restoreBuildSha(release, snapshotSha)).toBe(candidateSha);
    fs.writeFileSync(path.join(artifact, ".openoverlay-build-commit"), `${snapshotSha}\n`);
    expect(() => restoreBuildSha(release, snapshotSha)).toThrow(/artifact identity/);
    fs.rmSync(path.join(release, "release-manifest.json"));
    expect(restoreBuildSha(release, snapshotSha)).toBe(snapshotSha);
  });

  it("creates a checksum-complete online snapshot and resolves a retained delete tombstone", () => {
    const fixture = createFixture();
    const result = runBackup([
      "create",
      "--kind",
      "predeploy",
      "--root",
      fixture.backupRoot,
      "--database",
      fixture.databasePath,
      "--uploads",
      fixture.uploadDir,
      "--build-sha",
      "a".repeat(40)
    ]);
    expect(result.status).toBe(0);
    const created = JSON.parse(result.stdout.trim()) as { snapshot: string; mediaFiles: number };
    expect(created.mediaFiles).toBe(1);
    expect(fs.existsSync(path.join(created.snapshot, ".valid"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(created.snapshot, "manifest.json"), "utf8"))).toMatchObject({
      buildSha: "a".repeat(40),
      schemaVersion: 2,
      integrityCheck: "ok",
      media: [{ rowId: "media-1", kind: "original" }]
    });

    const verified = runBackup(["verify", "--snapshot", created.snapshot]);
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, mediaFiles: 1 });
    expect(JSON.parse(runBackup(["status", "--root", fixture.backupRoot]).stdout)).toMatchObject({ overdue: false, failedSinceSuccess: false });
  });

  it("never accepts a snapshot after database bytes are corrupted", () => {
    const fixture = createFixture();
    const created = JSON.parse(
      runBackup([
        "create",
        "--kind",
        "daily",
        "--root",
        fixture.backupRoot,
        "--database",
        fixture.databasePath,
        "--uploads",
        fixture.uploadDir,
        "--build-sha",
        "b".repeat(40)
      ]).stdout
    ) as { snapshot: string };
    fs.appendFileSync(path.join(created.snapshot, "openoverlay.sqlite"), "corruption");

    const verified = runBackup(["verify", "--snapshot", created.snapshot]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toMatch(/checksum does not match/);
  });

  it("remaps and hashes original and thumbnail files during an isolated restore", async () => {
    const fixture = createFixture(true);
    const created = JSON.parse(
      runBackup([
        "create",
        "--kind",
        "daily",
        "--root",
        fixture.backupRoot,
        "--database",
        fixture.databasePath,
        "--uploads",
        fixture.uploadDir,
        "--build-sha",
        "c".repeat(40)
      ]).stdout
    ) as { snapshot: string };
    const manifest = JSON.parse(fs.readFileSync(path.join(created.snapshot, "manifest.json"), "utf8"));
    const restored = path.join(fixture.directory, "isolated-restore");
    const { databasePath, stagedUploadDir } = await stageRestore(created.snapshot, manifest, restored);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare("SELECT path, thumbnail_path FROM media WHERE id = 'media-1'").get() as { path: string; thumbnail_path: string };
    db.close();
    expect(row.path).toMatch(new RegExp(`^${stagedUploadDir}/`));
    expect(row.thumbnail_path).toMatch(new RegExp(`^${stagedUploadDir}/`));
    expect(fs.readFileSync(row.path, "utf8")).toBe("stable-media-bytes");
    expect(fs.readFileSync(row.thumbnail_path, "utf8")).toBe("thumbnail-bytes");
  });

  it("copies live media when an older deduplication source is corrupt", () => {
    const fixture = createFixture();
    const args = ["--kind", "daily", "--root", fixture.backupRoot, "--database", fixture.databasePath, "--uploads", fixture.uploadDir];
    const first = JSON.parse(runBackup(["create", ...args, "--build-sha", "d".repeat(40)]).stdout) as { snapshot: string };
    const oldMedia = path.join(first.snapshot, "media", fs.readdirSync(path.join(first.snapshot, "media"))[0]);
    fs.writeFileSync(oldMedia, "corrupt-media-bytes");
    const second = runBackup(["create", ...args, "--build-sha", "e".repeat(40)]);
    expect(second.status).toBe(0);
    const next = JSON.parse(second.stdout) as { snapshot: string };
    expect(runBackup(["verify", "--snapshot", next.snapshot]).status).toBe(0);
    expect(fs.readFileSync(oldMedia, "utf8")).toBe("corrupt-media-bytes");
  });

  it("reports a failed scheduled backup without forgetting the last success", () => {
    const fixture = createFixture();
    expect(
      runBackup([
        "create",
        "--kind",
        "daily",
        "--root",
        fixture.backupRoot,
        "--database",
        fixture.databasePath,
        "--uploads",
        fixture.uploadDir,
        "--build-sha",
        "f".repeat(40)
      ]).status
    ).toBe(0);
    expect(runBackup(["failure", "--root", fixture.backupRoot, "--message", "Backend health unavailable"]).status).toBe(1);
    const status = JSON.parse(runBackup(["status", "--root", fixture.backupRoot]).stdout);
    expect(status).toMatchObject({ overdue: false, failedSinceSuccess: true, lastError: "Backend health unavailable" });
    expect(status.lastSuccessfulSnapshot).toBeTruthy();
  });
});

function createFixture(withThumbnail = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-backup-test-"));
  directories.push(directory);
  const databasePath = path.join(directory, "openoverlay.sqlite");
  const uploadDir = path.join(directory, "uploads");
  const backupRoot = path.join(directory, "backups");
  fs.mkdirSync(uploadDir);
  const originalPath = path.join(uploadDir, "graphic.png");
  const tombstonePath = `${originalPath}.deleting-test`;
  fs.writeFileSync(tombstonePath, "stable-media-bytes");
  const thumbnailPath = path.join(uploadDir, "graphic-thumbnail.webp");
  if (withThumbnail) fs.writeFileSync(thumbnailPath, "thumbnail-bytes");

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (2, '2026-01-01T00:00:00.000Z');
    CREATE TABLE media (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      thumbnail_path TEXT,
      thumbnail_size_bytes INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  database
    .prepare("INSERT INTO media VALUES (?, ?, ?, ?, ?, ?)")
    .run("media-1", originalPath, 18, withThumbnail ? thumbnailPath : null, withThumbnail ? 15 : null, "2026-01-01T00:00:00.000Z");
  database.close();
  return { directory, databasePath, uploadDir, backupRoot };
}

function runBackup(args: string[]) {
  return spawnSync(process.execPath, [backupScript, ...args, ...(args[0] === "create" ? ["--minimum-free-bytes", "0"] : [])], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}
