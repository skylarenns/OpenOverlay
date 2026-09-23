#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

try {
  const databasePath = path.resolve(process.env.DATABASE_PATH || "./data/openoverlay.sqlite");
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(databasePath), "uploads"));
  const globalLimit = Number(process.env.MEDIA_GLOBAL_MAX_BYTES || 10 * 1024 * 1024 * 1024);
  const freeSpaceFloor = Number(process.env.STORAGE_MINIMUM_FREE_BYTES ?? 1024 * 1024 * 1024);
  const userLimit = 250 * 1024 * 1024;
  const limit = Number(process.env.THUMBNAIL_BACKFILL_LIMIT || 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("THUMBNAIL_BACKFILL_LIMIT must be from 1 to 1000");
  if (!Number.isSafeInteger(globalLimit) || globalLimit <= 0) throw new Error("MEDIA_GLOBAL_MAX_BYTES must be positive");
  if (!Number.isSafeInteger(freeSpaceFloor) || freeSpaceFloor < 0) throw new Error("STORAGE_MINIMUM_FREE_BYTES must be non-negative");
  const database = new DatabaseSync(databasePath);
  const rows = database
    .prepare("SELECT id, owner_user_id, path FROM media WHERE thumbnail_path IS NULL AND mime_type != 'image/svg+xml' ORDER BY created_at, id LIMIT ?")
    .all(limit);
  let completed = 0;
  let skippedForCapacity = 0;
  const hasFreeSpace = (reservation) => {
    const stats = fs.statfsSync(uploadDir, { bigint: true });
    return stats.bavail * stats.bsize >= BigInt(freeSpaceFloor) + BigInt(reservation);
  };
  for (const row of rows) {
    const source = path.resolve(String(row.path));
    if (!source.startsWith(`${uploadDir}${path.sep}`) || !fs.lstatSync(source).isFile()) throw new Error(`Unsafe or missing media path for ${String(row.id)}`);
    const sourceBytes = fs.statSync(source).size;
    if (!hasFreeSpace(sourceBytes)) {
      skippedForCapacity += 1;
      continue;
    }
    const destination = path.join(uploadDir, `${randomUUID()}-thumbnail.webp`);
    const temporary = `${destination}.uploading-backfill`;
    try {
      const info = await sharp(source, { limitInputPixels: 40_000_000, failOn: "error" })
        .rotate()
        .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toFile(temporary);
      database.exec("BEGIN IMMEDIATE");
      try {
        const globalUsage = database.prepare("SELECT COALESCE(SUM(size_bytes + COALESCE(thumbnail_size_bytes, 0)), 0) AS bytes FROM media").get();
        const userUsage = database
          .prepare("SELECT COALESCE(SUM(size_bytes + COALESCE(thumbnail_size_bytes, 0)), 0) AS bytes FROM media WHERE owner_user_id = ?")
          .get(row.owner_user_id);
        if (Number(globalUsage.bytes) + info.size > globalLimit || Number(userUsage.bytes) + info.size > userLimit || !hasFreeSpace(0)) {
          skippedForCapacity += 1;
        } else {
          fs.linkSync(temporary, destination);
          const result = database
            .prepare(
              "UPDATE media SET thumbnail_path = ?, thumbnail_width = ?, thumbnail_height = ?, thumbnail_mime_type = 'image/webp', thumbnail_size_bytes = ? WHERE id = ? AND thumbnail_path IS NULL"
            )
            .run(destination, info.width, info.height, info.size, row.id);
          if (result.changes === 1) completed += 1;
          else fs.rmSync(destination, { force: true });
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        fs.rmSync(destination, { force: true });
        throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  database.close();
  console.log(JSON.stringify({ ok: true, scanned: rows.length, completed, skippedForCapacity }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Thumbnail backfill failed");
  process.exitCode = 1;
}
