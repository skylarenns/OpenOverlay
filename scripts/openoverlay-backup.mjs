#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { stageRestore } from "./openoverlay-restore-stage.mjs";

const FORMAT_VERSION = 1;
const TOOL_VERSION = "1.0.0";
const MINIMUM_FREE_BYTES = 50 * 1024 ** 3;
const RETENTION = { daily: 7, weekly: 4, predeploy: 3 };

const [command = "help", ...argv] = process.argv.slice(2);
let options = {};
try {
  options = parseOptions(argv);
  if (command === "create") await createSnapshot(options);
  else if (command === "verify") await verifySnapshot(requiredOption(options, "snapshot"));
  else if (command === "status") backupStatus(options);
  else if (command === "failure") {
    recordBackupStatus(options, { lastFailureAt: new Date().toISOString(), lastError: requiredOption(options, "message").slice(0, 300) });
    throw new Error(options.message);
  } else if (command === "media-audit") await auditLiveMedia(options);
  else if (command === "restore-verify") await verifyRestore(options);
  else if (command === "restore" && options.activate === "true") {
    if (process.env.OPENOVERLAY_RESTORE_LOCKED !== "1") {
      const lock = options.lock || "/run/lock/openoverlay-deploy.lock";
      const child = spawnSync("flock", ["-n", lock, process.execPath, process.argv[1], ...process.argv.slice(2)], {
        stdio: "inherit",
        env: { ...process.env, OPENOVERLAY_RESTORE_LOCKED: "1" }
      });
      if (child.error) throw child.error;
      process.exitCode = child.status ?? 1;
    } else await activateRestore(options);
  } else usage();
} catch (error) {
  if (command === "create") {
    try {
      recordBackupStatus(options, {
        lastFailureAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message.slice(0, 300) : "Backup failed"
      });
    } catch {
      // Keep the original backup failure as the reported error.
    }
  }
  console.error(error instanceof Error ? error.message : "Backup operation failed");
  process.exitCode = 1;
}

async function createSnapshot(options) {
  const root = path.resolve(options.root || "/var/backups/openoverlay");
  const databasePath = path.resolve(options.database || "/var/lib/openoverlay/openoverlay.sqlite");
  const uploadDir = path.resolve(options.uploads || "/var/lib/openoverlay/uploads");
  const buildSha = validateSha(options["build-sha"] || path.basename(fs.realpathSync(options.current || "/opt/openoverlay/current")));
  const kind = options.kind || "daily";
  if (kind !== "daily" && kind !== "predeploy") throw new Error("--kind must be daily or predeploy");
  ensureSecureDirectory(root);
  ensureFreeSpace(root, options["minimum-free-bytes"]);

  const createdAt = new Date();
  const stamp = createdAt.toISOString().replaceAll(/[-:]/g, "").replace(".", "-");
  const labels = kind === "daily" && createdAt.getUTCDay() === 0 ? ["daily", "weekly"] : [kind];
  const finalDirectory = path.join(root, `${stamp}-${kind}-${buildSha.slice(0, 12)}`);
  const stagingDirectory = `${finalDirectory}.staging-${randomUUID()}`;
  fs.mkdirSync(path.join(stagingDirectory, "media"), { recursive: true, mode: 0o700 });

  try {
    const destinationDatabase = path.join(stagingDirectory, "openoverlay.sqlite");
    const source = new DatabaseSync(databasePath, { readOnly: true });
    await backup(source, destinationDatabase);
    source.close();
    const copy = new DatabaseSync(destinationDatabase, { readOnly: true });
    const integrity = copy.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${String(integrity || "unknown")}`);
    const schemaVersion = Number(copy.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()?.version || 0);
    const compatibilityTable = copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_compatibility'").get();
    const schemaCompatibility = compatibilityTable
      ? copy.prepare("SELECT schema_version, writer_version, min_reader_version, updated_at FROM schema_compatibility ORDER BY schema_version").all()
      : [];
    const mediaRows = readMediaRows(copy);
    copy.close();

    const previousFiles = await indexPreviousFiles(root);
    const media = [];
    for (const row of mediaRows) {
      for (const item of mediaFilesForRow(row)) {
        const sourcePath = resolveMediaSource(item.originalPath, uploadDir);
        const destinationPath = path.join(stagingDirectory, "media", item.backupName);
        const copied = await copyAndVerify(sourcePath, destinationPath, previousFiles);
        if (item.expectedBytes !== null && copied.byteSize !== item.expectedBytes) {
          throw new Error(`Size mismatch for ${item.kind} ${row.id}`);
        }
        media.push({
          rowId: String(row.id),
          kind: item.kind,
          originalPath: item.originalPath,
          backupName: item.backupName,
          byteSize: copied.byteSize,
          sha256: copied.sha256
        });
      }
    }

    const manifest = {
      formatVersion: FORMAT_VERSION,
      backupToolVersion: TOOL_VERSION,
      createdAt: createdAt.toISOString(),
      labels,
      buildSha,
      schemaVersion,
      schemaCompatibility,
      integrityCheck: "ok",
      database: await hashFile(destinationDatabase),
      media
    };
    writeJson(path.join(stagingDirectory, "manifest.json"), manifest);
    await verifySnapshotContents(stagingDirectory, manifest);
    fs.writeFileSync(path.join(stagingDirectory, ".valid"), `${manifest.database.sha256}\n`, { mode: 0o600 });
    fs.renameSync(stagingDirectory, finalDirectory);
    recordBackupStatus(options, { lastSuccessAt: new Date().toISOString(), lastSuccessfulSnapshot: finalDirectory, lastError: null });
    await pruneSnapshots(root);
    console.log(JSON.stringify({ ok: true, snapshot: finalDirectory, buildSha, schemaVersion, mediaFiles: media.length }));
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

function backupStatus(options) {
  const status = readBackupStatus(options);
  const maximumAgeHours = Number(options["overdue-hours"] || 36);
  if (!Number.isFinite(maximumAgeHours) || maximumAgeHours <= 0) throw new Error("--overdue-hours must be positive");
  const successTime = Date.parse(status.lastSuccessAt || "");
  const overdue = !Number.isFinite(successTime) || Date.now() - successTime > maximumAgeHours * 60 * 60_000;
  const failedSinceSuccess = Boolean(status.lastFailureAt && status.lastError);
  console.log(JSON.stringify({ ...status, overdue, failedSinceSuccess }));
}

function readBackupStatus(options) {
  const file = path.resolve(options["status-file"] || path.join(options.root || "/var/backups/openoverlay", "status.json"));
  if (!fs.existsSync(file)) return { lastSuccessAt: null, lastSuccessfulSnapshot: null, lastFailureAt: null, lastError: null };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function recordBackupStatus(options, update) {
  const file = path.resolve(options["status-file"] || path.join(options.root || "/var/backups/openoverlay", "status.json"));
  const current = readBackupStatus(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...current, ...update })}\n`, { mode: 0o644, flag: "wx" });
  fs.renameSync(temporary, file);
}

async function verifySnapshot(snapshotInput, quiet = false) {
  const snapshot = path.resolve(snapshotInput);
  const validPath = path.join(snapshot, ".valid");
  const manifest = readManifest(snapshot);
  if (!fs.existsSync(validPath) || fs.readFileSync(validPath, "utf8").trim() !== manifest.database.sha256) {
    throw new Error(`Snapshot has no matching validity marker: ${snapshot}`);
  }
  const result = await verifySnapshotContents(snapshot, manifest);
  if (!quiet)
    console.log(JSON.stringify({ ok: true, snapshot, buildSha: manifest.buildSha, integrityCheck: result.integrity, mediaFiles: manifest.media.length }));
  return manifest;
}

async function verifySnapshotContents(snapshot, manifest) {
  const databasePath = path.join(snapshot, "openoverlay.sqlite");
  const databaseHash = await hashFile(databasePath);
  if (databaseHash.sha256 !== manifest.database.sha256 || databaseHash.byteSize !== manifest.database.byteSize) {
    throw new Error("Backup database checksum does not match its manifest");
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  db.close();
  if (integrity !== "ok") throw new Error(`Backup database integrity check failed: ${String(integrity || "unknown")}`);
  for (const item of manifest.media) {
    const file = path.join(snapshot, "media", safeBasename(item.backupName));
    const result = await hashFile(file);
    if (result.sha256 !== item.sha256 || result.byteSize !== item.byteSize) {
      throw new Error(`Backup media checksum mismatch for row ${item.rowId}`);
    }
  }
  return { integrity };
}

async function auditLiveMedia(options) {
  const databasePath = path.resolve(options.database || "/var/lib/openoverlay/openoverlay.sqlite");
  const uploadDir = path.resolve(options.uploads || "/var/lib/openoverlay/uploads");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const rows = readMediaRows(db);
  db.close();
  const results = [];
  for (const row of rows) {
    for (const item of mediaFilesForRow(row)) {
      const source = resolveMediaSource(item.originalPath, uploadDir);
      const result = await hashFile(source);
      if (item.expectedBytes !== null && result.byteSize !== item.expectedBytes) throw new Error(`Media size mismatch for row ${row.id}`);
      results.push({ rowId: String(row.id), kind: item.kind, path: source, ...result });
    }
  }
  console.log(JSON.stringify({ ok: true, database: databasePath, files: results }, null, 2));
}

async function verifyRestore(options) {
  const snapshot = path.resolve(requiredOption(options, "snapshot"));
  const release = path.resolve(options.release || "/opt/openoverlay/current");
  const manifest = await verifySnapshot(snapshot, true);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-restore-"));
  let child;
  try {
    const { databasePath, stagedUploadDir: uploadDir } = await stageRestore(snapshot, manifest, temporary);
    const port = await freePort();
    const entrypoint = path.join(release, "apps/backend/dist/index.js");
    if (!fs.existsSync(entrypoint)) throw new Error(`Compiled backend not found: ${entrypoint}`);
    child = spawn(process.execPath, [entrypoint], {
      cwd: path.join(release, "apps/backend"),
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_PATH: databasePath,
        UPLOAD_DIR: uploadDir,
        LOG_FILE: path.join(temporary, "backend.log"),
        JWT_SECRET: "restore-verification-only-secret",
        CORS_ORIGINS: "http://127.0.0.1:5173",
        FRONTEND_URL: "http://127.0.0.1:5173",
        OPENOVERLAY_GIT_SHA: manifest.buildSha
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await waitForHealth(port, manifest.buildSha);
      const email = `restore-${randomUUID()}@example.invalid`;
      const signup = await jsonRequest(port, "/api/v1/auth/signup", "POST", { email, password: `Restore-${randomUUID()}` });
      if (signup.status !== 201) throw new Error(`Restore auth smoke failed with HTTP ${signup.status}`);
      const cookie = signup.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) throw new Error("Restore auth smoke did not return a session cookie");
      const preset = await jsonRequest(port, "/api/v1/presets", "POST", { name: "Restore Drill", type: "soccer" }, cookie);
      if (preset.status !== 201) throw new Error(`Restore preset smoke failed with HTTP ${preset.status}`);
      const media = await jsonRequest(port, "/api/v1/media?limit=24", "GET", undefined, cookie);
      if (media.status !== 200) throw new Error(`Restore media smoke failed with HTTP ${media.status}`);
      const restoredDb = new DatabaseSync(databasePath, { readOnly: true });
      const mediaRows = restoredDb.prepare("SELECT id, public_id, path, thumbnail_path FROM media").all();
      restoredDb.close();
      for (const row of mediaRows) {
        for (const [kind, file, url] of [
          ["original", row.path, `/api/v1/media/file/${row.public_id}`],
          ["thumbnail", row.thumbnail_path, `/api/v1/media/thumbnail/${row.public_id}`]
        ]) {
          if (!file) continue;
          const expected = manifest.media.find((item) => item.rowId === String(row.id) && item.kind === kind);
          const response = await jsonRequest(port, url, "GET");
          if (response.status !== 200) throw new Error(`Restored ${kind} fetch failed with HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          if (!expected || bytes.length !== expected.byteSize || sha256 !== expected.sha256) throw new Error(`Restored ${kind} bytes do not match snapshot`);
        }
      }
      console.log(JSON.stringify({ ok: true, snapshot, release, buildSha: manifest.buildSha, smoke: ["auth", "preset", "media", "media-bytes"] }));
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `; backend: ${stderr.slice(-500)}` : ""}`);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function activateRestore(options) {
  const confirmation = options.confirm;
  if (confirmation !== "REPLACE-LIVE-DATA") throw new Error("Activation requires --confirm REPLACE-LIVE-DATA");
  const snapshot = path.resolve(requiredOption(options, "snapshot"));
  const databasePath = path.resolve(options.database || "/var/lib/openoverlay/openoverlay.sqlite");
  const uploadDir = path.resolve(options.uploads || "/var/lib/openoverlay/uploads");
  const manifest = await verifySnapshot(snapshot, true);
  if (process.getuid?.() !== 0) throw new Error("Live restore activation must run as root");
  const service = options.service || "Openoverlaybackend.service";
  assertServiceStopped(service);
  if (!fs.existsSync(databasePath) || !fs.existsSync(uploadDir)) throw new Error("Live database and uploads must exist before restore");
  const databaseOwner = fs.statSync(databasePath);
  const uploadOwner = fs.statSync(uploadDir);
  const parent = path.dirname(databasePath);
  const staging = fs.mkdtempSync(path.join(parent, ".openoverlay-restore-stage-"));
  const retained = path.join(parent, `.openoverlay-before-restore-${randomUUID()}`);
  const movedDatabaseSuffixes = [];
  let oldUploadsMoved = false;
  let succeeded = false;
  try {
    const staged = await stageRestore(snapshot, manifest, staging, uploadDir);
    fs.chownSync(staged.databasePath, databaseOwner.uid, databaseOwner.gid);
    fs.chownSync(staged.stagedUploadDir, uploadOwner.uid, uploadOwner.gid);
    for (const item of manifest.media) fs.chownSync(path.join(staged.stagedUploadDir, safeBasename(item.backupName)), uploadOwner.uid, uploadOwner.gid);
    assertServiceStopped(service);
    fs.mkdirSync(retained, { mode: 0o700 });
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${databasePath}${suffix}`;
      if (fs.existsSync(source)) {
        fs.renameSync(source, path.join(retained, `openoverlay.sqlite${suffix}`));
        movedDatabaseSuffixes.push(suffix);
      }
    }
    fs.renameSync(uploadDir, path.join(retained, "uploads"));
    oldUploadsMoved = true;
    fs.renameSync(staged.stagedUploadDir, uploadDir);
    fs.renameSync(staged.databasePath, databasePath);
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = restored.prepare("PRAGMA integrity_check").get()?.integrity_check;
    restored.close();
    if (integrity !== "ok") throw new Error(`Activated database integrity check failed: ${String(integrity)}`);
    succeeded = true;
    console.log(JSON.stringify({ ok: true, activated: snapshot, database: databasePath, restoredMediaFiles: manifest.media.length, previousData: retained }));
  } catch (error) {
    if (movedDatabaseSuffixes.includes("") && fs.existsSync(databasePath)) fs.renameSync(databasePath, path.join(staging, "failed-openoverlay.sqlite"));
    if (oldUploadsMoved && fs.existsSync(uploadDir)) fs.renameSync(uploadDir, path.join(staging, "failed-uploads"));
    for (const suffix of movedDatabaseSuffixes) fs.renameSync(path.join(retained, `openoverlay.sqlite${suffix}`), `${databasePath}${suffix}`);
    if (oldUploadsMoved) fs.renameSync(path.join(retained, "uploads"), uploadDir);
    throw error;
  } finally {
    if (succeeded) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function assertServiceStopped(service) {
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(service)) throw new Error("Invalid service name");
  const active = spawnSync("systemctl", ["is-active", "--quiet", service]);
  if (active.error) throw active.error;
  if (active.status === 0) throw new Error(`Refusing live restore while ${service} is active`);
  const loadState = execFileSync("systemctl", ["show", "-p", "LoadState", "--value", service], { encoding: "utf8" }).trim();
  if (loadState !== "loaded") throw new Error(`Refusing live restore: ${service} is not loaded`);
  const pid = Number(execFileSync("systemctl", ["show", "-p", "MainPID", "--value", service], { encoding: "utf8" }).trim());
  if (!Number.isInteger(pid) || pid !== 0) throw new Error(`Refusing live restore while ${service} has a process`);
  const listeners = spawnSync("ss", ["-Hltpn", "( sport = :8734 or sport = :8735 or sport = :8736 )"], { encoding: "utf8" });
  if (listeners.error || listeners.status !== 0 || listeners.stdout.trim()) throw new Error("Refusing live restore while OpenOverlay has a listener");
}

function readMediaRows(db) {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(media)")
      .all()
      .map((column) => String(column.name))
  );
  const thumbnailFields = ["thumbnail_path", "thumbnail_size_bytes"].every((field) => columns.has(field)) ? ", thumbnail_path, thumbnail_size_bytes" : "";
  return db.prepare(`SELECT id, path, size_bytes${thumbnailFields} FROM media ORDER BY created_at, id`).all();
}

function mediaFilesForRow(row) {
  const files = [
    {
      kind: "original",
      originalPath: String(row.path),
      expectedBytes: Number(row.size_bytes),
      backupName: `${String(row.id)}-original-${path.basename(String(row.path))}`
    }
  ];
  if (row.thumbnail_path) {
    files.push({
      kind: "thumbnail",
      originalPath: String(row.thumbnail_path),
      expectedBytes: row.thumbnail_size_bytes == null ? null : Number(row.thumbnail_size_bytes),
      backupName: `${String(row.id)}-thumbnail-${path.basename(String(row.thumbnail_path))}`
    });
  }
  return files;
}

function resolveMediaSource(originalPath, uploadDir) {
  const normalized = path.resolve(originalPath);
  if (!isInside(normalized, uploadDir)) throw new Error(`Media path is outside upload root: ${originalPath}`);
  if (isRegularFile(normalized)) return normalized;
  const directory = path.dirname(normalized);
  const prefix = `${path.basename(normalized)}.deleting-`;
  const tombstones = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .sort();
  if (tombstones.length !== 1) throw new Error(`Missing media bytes for ${originalPath}`);
  const tombstone = path.join(directory, tombstones[0]);
  if (!isRegularFile(tombstone)) throw new Error(`Invalid media tombstone for ${originalPath}`);
  return tombstone;
}

async function copyAndVerify(source, destination, previousFiles) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const before = fs.statSync(source);
      const sourceHash = await hashFile(source);
      const key = `${sourceHash.byteSize}:${sourceHash.sha256}`;
      const prior = previousFiles.get(key);
      if (prior && isRegularFile(prior)) {
        const priorHash = await hashFile(prior);
        if (priorHash.byteSize === sourceHash.byteSize && priorHash.sha256 === sourceHash.sha256) fs.linkSync(prior, destination);
        else {
          previousFiles.delete(key);
          fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        }
      } else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const destinationHash = await hashFile(destination);
      const after = fs.statSync(source);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || sourceHash.sha256 !== destinationHash.sha256) {
        throw new Error("source changed while it was copied");
      }
      fs.chmodSync(destination, 0o600);
      return destinationHash;
    } catch (error) {
      lastError = error;
      fs.rmSync(destination, { force: true });
      if (attempt < 3) await delay(attempt * 100);
    }
  }
  throw new Error(`Unable to copy stable media bytes from ${source}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function indexPreviousFiles(root) {
  const files = new Map();
  for (const snapshot of (await verifiedSnapshots(root)).reverse()) {
    const manifest = readManifest(snapshot.path);
    for (const item of manifest.media) {
      const file = path.join(snapshot.path, "media", safeBasename(item.backupName));
      if (!files.has(`${item.byteSize}:${item.sha256}`) && isRegularFile(file)) files.set(`${item.byteSize}:${item.sha256}`, file);
    }
  }
  return files;
}

async function pruneSnapshots(root) {
  const snapshots = await verifiedSnapshots(root);
  if (snapshots.length <= 1) return;
  const keep = new Set();
  for (const [label, count] of Object.entries(RETENTION)) {
    const matches = snapshots.filter((snapshot) => snapshot.manifest.labels.includes(label)).slice(0, count);
    for (const snapshot of matches) keep.add(snapshot.path);
  }
  keep.add(snapshots[0].path);
  for (const snapshot of snapshots) {
    if (!keep.has(snapshot.path)) fs.rmSync(snapshot.path, { recursive: true, force: true, maxRetries: 3 });
  }
}

function validSnapshots(root) {
  if (!fs.existsSync(root)) return [];
  const snapshots = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.includes(".staging-")) continue;
    const snapshotPath = path.join(root, entry.name);
    if (!fs.existsSync(path.join(snapshotPath, ".valid"))) continue;
    try {
      snapshots.push({ path: snapshotPath, manifest: readManifest(snapshotPath) });
    } catch {
      // Preserve older/foreign snapshots, but never use or prune them as if
      // they had passed this tool version's verification contract.
    }
  }
  return snapshots.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

async function verifiedSnapshots(root) {
  const verified = [];
  for (const snapshot of validSnapshots(root)) {
    try {
      await verifySnapshot(snapshot.path, true);
      verified.push(snapshot);
    } catch {
      // Damaged snapshots remain for investigation, but cannot supply dedupe
      // bytes or displace a verified recovery point during pruning.
    }
  }
  return verified;
}

function readManifest(snapshot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, "manifest.json"), "utf8"));
  if (manifest.formatVersion !== FORMAT_VERSION || manifest.backupToolVersion !== TOOL_VERSION || !Array.isArray(manifest.media)) {
    throw new Error(`Unsupported backup manifest: ${snapshot}`);
  }
  validateSha(manifest.buildSha);
  return manifest;
}

async function hashFile(file) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of fs.createReadStream(file)) {
    byteSize += chunk.length;
    hash.update(chunk);
  }
  return { byteSize, sha256: hash.digest("hex") };
}

function ensureFreeSpace(root, override) {
  const minimum = override === undefined ? MINIMUM_FREE_BYTES : Number(override);
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error("--minimum-free-bytes must be a non-negative integer");
  const stats = fs.statfsSync(root);
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < minimum) throw new Error(`Backup refused: less than ${minimum} bytes free`);
}

function ensureSecureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function isInside(file, directory) {
  return path.resolve(file).startsWith(`${path.resolve(directory)}${path.sep}`);
}

function safeBasename(value) {
  if (typeof value !== "string" || value !== path.basename(value) || value === "." || value === "..") throw new Error("Unsafe backup filename");
  return value;
}

function validateSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error("Build SHA must be a full lowercase 40-character Git SHA");
  return value;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (key === "activate") options.activate = "true";
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      options[key] = value;
      index += 1;
    }
  }
  return options;
}

function requiredOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing required option: --${name}`);
  return value;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, buildSha) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json();
      if (response.ok && body.ok === true && body.build?.commit === buildSha) return;
      lastError = new Error(`health identity mismatch: ${String(body.build?.commit || "unknown")}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Restored backend did not become healthy: ${lastError instanceof Error ? lastError.message : "unknown"}`);
}

async function jsonRequest(port, requestPath, method, body, cookie) {
  return fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  throw new Error("Usage: openoverlay-backup.mjs create|verify|status|failure|media-audit|restore-verify|restore [options]");
}
