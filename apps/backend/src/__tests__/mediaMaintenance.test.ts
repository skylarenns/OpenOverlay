import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import sharp from "sharp";
import { loadConfig } from "../config.js";
import { Database } from "../db.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it("backfills thumbnails only when global, user, and free-space policy permit it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-media-maintenance-"));
  directories.push(directory);
  const uploadDir = path.join(directory, "uploads");
  fs.mkdirSync(uploadDir);
  const source = path.join(uploadDir, "original.png");
  fs.writeFileSync(
    source,
    await sharp({ create: { width: 100, height: 100, channels: 3, background: "red" } })
      .png()
      .toBuffer()
  );
  const sourceBytes = fs.statSync(source).size;
  const databasePath = path.join(directory, "media.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE media (
    id TEXT PRIMARY KEY, owner_user_id TEXT, path TEXT, mime_type TEXT, created_at TEXT,
    size_bytes INTEGER, thumbnail_path TEXT, thumbnail_width INTEGER, thumbnail_height INTEGER,
    thumbnail_mime_type TEXT, thumbnail_size_bytes INTEGER
  )`);
  database
    .prepare("INSERT INTO media (id, owner_user_id, path, mime_type, created_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?)")
    .run("asset-1", "owner-1", source, "image/png", "2026-01-01", sourceBytes);
  database.close();

  const script = path.resolve(process.cwd(), "../../scripts/backfill-thumbnails.mjs");
  const run = (globalLimit: number, freeSpaceFloor: number) =>
    JSON.parse(
      execFileSync(process.execPath, [script], {
        cwd: path.resolve(process.cwd(), "../.."),
        env: {
          ...process.env,
          DATABASE_PATH: databasePath,
          UPLOAD_DIR: uploadDir,
          MEDIA_GLOBAL_MAX_BYTES: String(globalLimit),
          STORAGE_MINIMUM_FREE_BYTES: String(freeSpaceFloor)
        },
        encoding: "utf8"
      })
    );

  expect(run(sourceBytes + 1, 0)).toMatchObject({ completed: 0, skippedForCapacity: 1 });
  expect(run(1000000, Number.MAX_SAFE_INTEGER)).toMatchObject({ completed: 0, skippedForCapacity: 1 });
  const quotaDatabase = new DatabaseSync(databasePath);
  quotaDatabase.prepare("UPDATE media SET size_bytes = ? WHERE id = 'asset-1'").run(250 * 1024 * 1024 - 1);
  quotaDatabase.close();
  expect(run(1024 * 1024 * 1024, 0)).toMatchObject({ completed: 0, skippedForCapacity: 1 });
  const resetDatabase = new DatabaseSync(databasePath);
  resetDatabase.prepare("UPDATE media SET size_bytes = ? WHERE id = 'asset-1'").run(sourceBytes);
  resetDatabase.close();
  expect(run(1000000, 0)).toMatchObject({ completed: 1, skippedForCapacity: 0 });
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  const row = verified.prepare("SELECT thumbnail_path, thumbnail_size_bytes FROM media WHERE id = 'asset-1'").get() as {
    thumbnail_path: string;
    thumbnail_size_bytes: number;
  };
  expect(row.thumbnail_size_bytes).toBeGreaterThan(0);
  expect(fs.existsSync(row.thumbnail_path)).toBe(true);
  verified.close();
});

it("cleans seed media after an interrupted transaction and retries without duplicate assets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-seed-maintenance-"));
  directories.push(directory);
  const databasePath = path.join(directory, "seed.sqlite");
  const uploadDir = path.join(directory, "uploads");
  const config = loadConfig({ env: "test", databasePath, uploadDir });
  new Database(config).close();
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TRIGGER interrupt_seed BEFORE INSERT ON presets BEGIN SELECT RAISE(ABORT, 'interrupted seed'); END");
  database.close();

  const root = path.resolve(process.cwd(), "../..");
  const run = () =>
    execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/seed.ts"], {
      cwd: path.join(root, "apps/backend"),
      env: { ...process.env, NODE_ENV: "test", DATABASE_PATH: databasePath, UPLOAD_DIR: uploadDir, DEMO_EMAIL: "seed-retry@example.com" },
      encoding: "utf8",
      stdio: "pipe"
    });
  expect(run).toThrow();
  const inspect = new DatabaseSync(databasePath);
  expect(inspect.prepare("SELECT COUNT(*) AS count FROM media").get()).toMatchObject({ count: 0 });
  expect(fs.readdirSync(uploadDir)).toEqual([]);
  inspect.exec("DROP TRIGGER interrupt_seed");
  inspect.close();

  expect(run()).toContain("Seed complete");
  expect(run()).toContain("Seed complete");
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  const media = verified.prepare("SELECT path FROM media ORDER BY path").all() as { path: string }[];
  expect(media).toHaveLength(2);
  expect(new Set(media.map((item) => item.path)).size).toBe(2);
  expect(media.every((item) => fs.existsSync(item.path))).toBe(true);
  expect(verified.prepare("SELECT COUNT(*) AS count FROM presets").get()).toMatchObject({ count: 2 });
  verified.close();
});
