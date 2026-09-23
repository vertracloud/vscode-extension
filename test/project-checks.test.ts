import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import * as vscode from "vscode";
import { runProjectChecks } from "../src/project/checks";

let dir: string;

function folder(d: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(d), name: "proj", index: 0 } as vscode.WorkspaceFolder;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vertra-checks-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("detects .env present with a reserved key", async () => {
  await fsWriteFile(join(dir, ".env"), "PORT=3000\nFOO=bar\n");
  const results = await runProjectChecks(folder(dir));
  assert.ok(results.some((r) => r.severity === "warning" && /\.env/.test(r.message)));
  assert.ok(results.some((r) => r.severity === "warning" && /PORT/.test(r.message)));
});

test("detects a missing package-lock.json for a Node project", async () => {
  await fsWriteFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  const results = await runProjectChecks(folder(dir));
  assert.ok(results.some((r) => /package-lock/.test(r.message)));
});

test("warns about a missing vertracloud.config", async () => {
  const results = await runProjectChecks(folder(dir));
  assert.ok(results.some((r) => r.severity === "warning" && /vertracloud.config/.test(r.message)));
});

test("reports config validation errors when vertracloud.config is invalid", async () => {
  await fsWriteFile(join(dir, "vertracloud.config"), "MEMORY=10\n");
  const results = await runProjectChecks(folder(dir));
  assert.ok(results.some((r) => r.severity === "error" && /MEMORY/.test(r.message)));
});

test("flags a large project over the 50MB warning threshold", async () => {
  await fsWriteFile(join(dir, "big.bin"), Buffer.alloc(51 * 1024 * 1024));
  const results = await runProjectChecks(folder(dir));
  assert.ok(results.some((r) => r.severity === "warning" && /large/i.test(r.message)));
});
