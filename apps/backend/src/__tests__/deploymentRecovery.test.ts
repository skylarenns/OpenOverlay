import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const deploy = path.join(repositoryRoot, "scripts/openoverlay-deploy");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("immutable release recovery", () => {
  it("discovers the legacy gateway control socket before immutable activation", async () => {
    const fixture = createFixture();
    fs.unlinkSync(path.join(fixture.directory, "current"));
    const legacySocket = `/tmp/oo-legacy-${process.pid}-${Date.now()}.sock`;
    const immutableSocket = `/tmp/oo-immutable-${process.pid}-${Date.now()}.sock`;
    const server = net.createServer();
    const immutableServer = net.createServer();
    await Promise.all([
      new Promise<void>((resolve, reject) => server.once("error", reject).listen(legacySocket, resolve)),
      new Promise<void>((resolve, reject) => immutableServer.once("error", reject).listen(immutableSocket, resolve))
    ]);
    try {
      const result = runFixture(fixture, 'printf "%s" "$CONTROL_SOCKET"', true, {
        OPENOVERLAY_CONTROL_SOCKET: "",
        OPENOVERLAY_LEGACY_CONTROL_SOCKET: legacySocket,
        OPENOVERLAY_IMMUTABLE_CONTROL_SOCKET: immutableSocket
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(legacySocket);
      fs.symlinkSync(fixture.oldRelease, path.join(fixture.directory, "current"));
      const active = runFixture(fixture, 'printf "%s" "$CONTROL_SOCKET"', true, {
        OPENOVERLAY_CONTROL_SOCKET: "",
        OPENOVERLAY_LEGACY_CONTROL_SOCKET: legacySocket,
        OPENOVERLAY_IMMUTABLE_CONTROL_SOCKET: immutableSocket
      });
      expect(active.status).toBe(0);
      expect(active.stdout).toBe(immutableSocket);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => immutableServer.close(() => resolve()));
      fs.rmSync(legacySocket, { force: true });
      fs.rmSync(immutableSocket, { force: true });
    }
  });

  it("accepts tracked environment examples but rejects a mismatched archive commit", () => {
    const fixture = createFixture();
    const repository = path.join(fixture.directory, "archive-source");
    fs.mkdirSync(repository);
    fs.writeFileSync(path.join(repository, ".env.example"), "JWT_SECRET=replace-me\n");
    fs.writeFileSync(path.join(repository, "package.json"), '{"name":"archive-fixture"}\n');
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=OpenOverlay Test", "-c", "user.email=test@openoverlay.local", "commit", "-qm", "archive fixture");
    const sha = git("rev-parse", "HEAD");
    const archive = path.join(fixture.directory, "release.tar.gz");
    const created = spawnSync("git", ["-C", repository, "archive", "--format=tar.gz", "HEAD"]);
    expect(created.status).toBe(0);
    fs.writeFileSync(archive, created.stdout);
    const env = { ARCHIVE: archive, EXPECTED_SHA: sha };
    expect(runFixture(fixture, 'verify_archive "$ARCHIVE" "$EXPECTED_SHA"', true, env).status).toBe(0);
    const mismatch = runFixture(fixture, 'verify_archive "$ARCHIVE" "$NEW_SHA"', true, env);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toMatch(/archive Git commit does not match/);
  });

  it("uses the installed backup volume when a forced deployment has no caller environment", () => {
    const fixture = createFixture();
    const backupRoot = path.join(fixture.directory, "large-volume", "backups");
    const configFile = path.join(fixture.directory, "backup.env");
    fs.writeFileSync(configFile, `OPENOVERLAY_BACKUP_ROOT=${backupRoot}\n`);
    const result = spawnSync("bash", ["-c", 'source "$DEPLOY_SCRIPT"; printf "%s" "$BACKUP_ROOT"'], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEPLOY_SCRIPT: deploy,
        OPENOVERLAY_DEPLOY_LIBRARY_ONLY: "1",
        OPENOVERLAY_BACKUP_ROOT: "",
        OPENOVERLAY_BACKUP_CONFIG_FILE: configFile
      }
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(backupRoot);
  });

  it("restores the old release when the new service fails to start", () => {
    const fixture = createFixture();
    const result = runFixture(
      fixture,
      `
      systemctl() { [[ "$(readlink -f "$CURRENT_LINK")" == "$OLD_RELEASE" ]]; }
      wait_for_release() { [[ "$1" == "$OLD_SHA" ]]; }
      promote_release "$NEW_SHA" "$NEW_RELEASE"
    `
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/rolled back/);
    expect(fs.realpathSync(path.join(fixture.directory, "current"))).toBe(fixture.oldRelease);
  });

  it("refuses an epoch-zero promotion before switching away from a release without a reader contract", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.oldRelease, "release-manifest.json"), JSON.stringify({ privacyEpoch: 0 }));
    const result = runFixture(
      fixture,
      `
      systemctl() { :; }
      wait_for_release() { :; }
      promote_release "$NEW_SHA" "$NEW_RELEASE"
    `,
      false
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/previous release has no schema reader contract/);
    expect(fs.realpathSync(path.join(fixture.directory, "current"))).toBe(fixture.oldRelease);
  });

  it("restores original pointers when a requested rollback fails health", () => {
    const fixture = createFixture();
    fs.unlinkSync(path.join(fixture.directory, "current"));
    fs.symlinkSync(fixture.newRelease, path.join(fixture.directory, "current"));
    fs.symlinkSync(fixture.oldRelease, path.join(fixture.directory, "previous"));
    const result = runFixture(
      fixture,
      `
      assert_promotion_safe() { :; }
      systemctl() { :; }
      wait_for_release() { [[ "$1" == "$NEW_SHA" ]]; }
      rollback_release
    `
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/original release restored/);
    expect(fs.realpathSync(path.join(fixture.directory, "current"))).toBe(fixture.newRelease);
    expect(fs.realpathSync(path.join(fixture.directory, "previous"))).toBe(fixture.oldRelease);
  });

  it("accepts reader-compatible schema but rejects it after a privacy cutover", () => {
    const fixture = createFixture();
    const db = new DatabaseSync(path.join(fixture.directory, "openoverlay.sqlite"));
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (4)");
    db.exec(
      "CREATE TABLE schema_compatibility (schema_version INTEGER PRIMARY KEY, min_reader_version INTEGER); INSERT INTO schema_compatibility VALUES (4, 3)"
    );
    db.close();
    fs.writeFileSync(path.join(fixture.oldRelease, "release-manifest.json"), JSON.stringify({ schemaVersion: 3, readerVersion: 3, privacyEpoch: 0 }));
    const command = 'assert_rollback_compatible "$OLD_RELEASE"';
    expect(runFixture(fixture, command, false).status).toBe(0);
    fs.writeFileSync(path.join(fixture.directory, "privacy-cutover"), "1\n");
    const refused = runFixture(fixture, command, false);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/privacy cutover forbids rollback/);
  });

  it("rejects rollback when a newer schema needs a newer reader", () => {
    const fixture = createFixture();
    const db = new DatabaseSync(path.join(fixture.directory, "openoverlay.sqlite"));
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (4)");
    db.exec(
      "CREATE TABLE schema_compatibility (schema_version INTEGER PRIMARY KEY, min_reader_version INTEGER); INSERT INTO schema_compatibility VALUES (4, 4)"
    );
    db.close();
    fs.writeFileSync(path.join(fixture.oldRelease, "release-manifest.json"), JSON.stringify({ schemaVersion: 3, readerVersion: 3, privacyEpoch: 0 }));
    const refused = runFixture(fixture, 'assert_rollback_compatible "$OLD_RELEASE"', false);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/schema 4 cannot be read/);
  });
});

function createFixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-release-recovery-")));
  directories.push(directory);
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  const oldRelease = path.join(directory, oldSha);
  const newRelease = path.join(directory, newSha);
  fs.mkdirSync(oldRelease);
  fs.mkdirSync(newRelease);
  fs.writeFileSync(path.join(newRelease, "release-manifest.json"), JSON.stringify({ privacyEpoch: 0 }));
  fs.symlinkSync(oldRelease, path.join(directory, "current"));
  return { directory, oldSha, newSha, oldRelease, newRelease };
}

function runFixture(fixture: ReturnType<typeof createFixture>, body: string, mockCompatibility = true, extraEnv: Record<string, string> = {}) {
  return spawnSync(
    "bash",
    [
      "-c",
      `
      set -euo pipefail
      source "$DEPLOY_SCRIPT"
      atomic_link() { ln -sfn "$1" "$2"; }
      ${mockCompatibility ? "assert_rollback_compatible() { :; }" : ""}
      ${body}
      `
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENOVERLAY_DEPLOY_LIBRARY_ONLY: "1",
        OPENOVERLAY_RELEASE_ROOT: fixture.directory,
        OPENOVERLAY_DATABASE_PATH: path.join(fixture.directory, "openoverlay.sqlite"),
        OPENOVERLAY_PRIVACY_CUTOVER_MARKER: path.join(fixture.directory, "privacy-cutover"),
        OPENOVERLAY_NODE_BIN: process.execPath,
        DEPLOY_SCRIPT: deploy,
        OLD_SHA: fixture.oldSha,
        NEW_SHA: fixture.newSha,
        OLD_RELEASE: fixture.oldRelease,
        NEW_RELEASE: fixture.newRelease,
        ...extraEnv
      }
    }
  );
}
