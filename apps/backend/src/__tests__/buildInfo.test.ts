import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildCommit } from "../buildInfo.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("backend build identity", () => {
  it("records the archived release SHA without a Git checkout", () => {
    const directory = temporaryModuleDirectory("release");
    const output = path.join(directory, "dist");
    const sha = "a".repeat(40);
    const script = path.resolve(import.meta.dirname, "../../../../scripts/write-build-commit.mjs");
    const result = spawnSync(process.execPath, [script, output], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, OPENOVERLAY_GIT_SHA: sha, GIT_COMMIT_SHA: "", VERCEL_GIT_COMMIT_SHA: "" }
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(output, ".openoverlay-build-commit"), "utf8")).toBe(`${sha}\n`);
  });

  it("prefers the compiled artifact marker over a stale service environment", () => {
    const moduleDirectory = temporaryModuleDirectory("dist");
    fs.writeFileSync(path.join(moduleDirectory, ".openoverlay-build-commit"), "artifact-sha\n");

    expect(resolveBuildCommit(moduleDirectory, { OPENOVERLAY_GIT_SHA: "stale-service-sha" }, () => "mutable-checkout-sha")).toBe("artifact-sha");
  });

  it("does not describe an unmarked dist artifact using the mutable checkout", () => {
    const moduleDirectory = temporaryModuleDirectory("dist");

    expect(resolveBuildCommit(moduleDirectory, {}, () => "mutable-checkout-sha")).toBeNull();
  });
});

function temporaryModuleDirectory(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-build-info-"));
  temporaryDirectories.push(parent);
  const directory = path.join(parent, name);
  fs.mkdirSync(directory);
  return directory;
}
