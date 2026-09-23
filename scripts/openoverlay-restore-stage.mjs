import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// The snapshot database contains paths from the source host. Repoint every
// referenced file before starting an isolated backend or activating a restore.
export async function stageRestore(snapshot, manifest, directory, targetUploadDir = path.join(directory, "uploads")) {
  const databasePath = path.join(directory, "openoverlay.sqlite");
  const stagedUploadDir = path.join(directory, "uploads");
  fs.mkdirSync(stagedUploadDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(snapshot, "openoverlay.sqlite"), databasePath, fs.constants.COPYFILE_EXCL);
  const db = new DatabaseSync(databasePath);
  try {
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(media)")
        .all()
        .map((column) => String(column.name))
    );
    const hasThumbnails = columns.has("thumbnail_path");
    const rows = db.prepare(`SELECT id, path${hasThumbnails ? ", thumbnail_path" : ""} FROM media`).all();
    const byRow = new Map();
    for (const item of manifest.media) {
      if (item.kind !== "original" && item.kind !== "thumbnail") throw new Error("Invalid snapshot media kind");
      if (typeof item.backupName !== "string" || item.backupName !== path.basename(item.backupName) || [".", ".."].includes(item.backupName)) {
        throw new Error("Unsafe snapshot media filename");
      }
      const key = `${item.rowId}:${item.kind}`;
      if (byRow.has(key)) throw new Error(`Duplicate snapshot media entry: ${key}`);
      byRow.set(key, item);
      const source = path.join(snapshot, "media", item.backupName);
      const destination = path.join(stagedUploadDir, item.backupName);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const hash = await hashFile(destination);
      if (hash.sha256 !== item.sha256 || hash.byteSize !== item.byteSize) throw new Error(`Restored media checksum mismatch: ${key}`);
    }
    let expectedCount = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const update = db.prepare(`UPDATE media SET path = ?${hasThumbnails ? ", thumbnail_path = ?" : ""} WHERE id = ?`);
      for (const row of rows) {
        const id = String(row.id);
        const original = byRow.get(`${id}:original`);
        const thumbnail = byRow.get(`${id}:thumbnail`);
        if (!original || Boolean(row.thumbnail_path) !== Boolean(thumbnail)) throw new Error(`Incomplete snapshot media for row ${id}`);
        expectedCount += thumbnail ? 2 : 1;
        const originalPath = path.join(targetUploadDir, original.backupName);
        const thumbnailPath = thumbnail ? path.join(targetUploadDir, thumbnail.backupName) : null;
        const result = hasThumbnails ? update.run(originalPath, thumbnailPath, id) : update.run(originalPath, id);
        if (result.changes !== 1) throw new Error(`Snapshot media row disappeared: ${id}`);
      }
      if (expectedCount !== manifest.media.length) throw new Error("Snapshot media manifest does not match database rows");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`Staged database integrity check failed: ${String(integrity)}`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode = DELETE");
  } finally {
    db.close();
  }
  return { databasePath, stagedUploadDir };
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
