import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const deployHelper = path.join(repositoryRoot, "scripts/openoverlay-deploy");
const archiveCommit = "a".repeat(40);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("release archive validation", () => {
  it("reads Git identity from a release larger than the pipe buffer", () => {
    expect(validateArchive([{ name: "large.txt", content: randomBytes(256 * 1024).toString("base64") }]).status).toBe(0);
  });

  it("accepts bounded regular files and rejects traversal and links", () => {
    expect(validateArchive([{ name: "package.json", content: "{}" }]).status).toBe(0);

    const traversal = validateArchive([{ name: "../escape", content: "owned" }]);
    expect(traversal.status).toBe(1);
    expect(traversal.stderr).toMatch(/path traversal|unsafe path/);

    const link = validateArchive([{ name: "outside-link", content: "../outside", type: "2" }]);
    expect(link.status).toBe(1);
    expect(link.stderr).toMatch(/links, devices/);
  });
});

function validateArchive(entries: TarEntry[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-archive-test-"));
  directories.push(directory);
  const archive = path.join(directory, "release.tar.gz");
  fs.writeFileSync(archive, gzipSync(createTar(entries)));
  return spawnSync("bash", [deployHelper, "verify-archive", archive, archiveCommit], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, OPENOVERLAY_DEPLOY_LIBRARY_ONLY: "1" }
  });
}

interface TarEntry {
  name: string;
  content: string;
  type?: "0" | "2" | "g";
}

function createTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  // Git archives carry the commit in a global PAX comment. Keep the test
  // archive realistic so safety checks reach path and link validation.
  for (const entry of [{ name: "pax_global_header", content: `52 comment=${archiveCommit}\n`, type: "g" as const }, ...entries]) {
    const content = Buffer.from(entry.content);
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.type === "2" ? 0 : content.length);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156);
    header[156] = (entry.type || "0").charCodeAt(0);
    if (entry.type === "2") writeString(header, 157, 100, entry.content);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, value) => sum + value, 0);
    writeOctal(header, 148, 8, checksum);
    blocks.push(header);
    if (entry.type !== "2") {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  buffer.write(`${encoded}\0`, offset, length, "ascii");
}
