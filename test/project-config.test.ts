import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import * as vscode from "vscode";
import {
  parseConfig,
  serializeSet,
  readConfig,
  writeConfigKey,
  validateConfig,
} from "../src/project/config";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vertra-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("parseConfig ignores comments, blank lines and casing, trims values", () => {
  const text = ["# comment", "; also a comment", "", "  id = abc123  ", "name=My App"].join("\n");
  const { values, lines } = parseConfig(text);
  assert.equal(values.ID, "abc123");
  assert.equal(values.NAME, "My App");
  assert.equal(lines.length, 5);
  const idLine = lines.find((l) => l.key === "ID");
  assert.ok(idLine);
  assert.equal(idLine?.line, 3);
});

test("serializeSet updates an existing key without duplicating it", () => {
  const text = "ID=old\nNAME=App\n";
  const next = serializeSet(text, "ID", "new");
  assert.equal(next, "ID=new\nNAME=App\n");
});

test("serializeSet appends a new key with trailing newline", () => {
  const text = "NAME=App\n";
  const next = serializeSet(text, "ID", "abc");
  assert.equal(next, "NAME=App\nID=abc\n");
});

test("serializeSet appends into an empty file", () => {
  const next = serializeSet("", "ID", "abc");
  assert.equal(next, "ID=abc\n");
});

test("readConfig and writeConfigKey round-trip via vscode.workspace.fs", async () => {
  const folderUri = vscode.Uri.file(dir);
  await writeConfigKey(folderUri, "ID", "app-1");
  await writeConfigKey(folderUri, "NAME", "My App");
  const parsed = await readConfig(folderUri);
  assert.equal(parsed?.values.ID, "app-1");
  assert.equal(parsed?.values.NAME, "My App");
});

test("readConfig returns undefined when the file doesn't exist", async () => {
  const parsed = await readConfig(vscode.Uri.file(dir));
  assert.equal(parsed, undefined);
});

test("validateConfig: MEMORY must be an integer >= 100", async () => {
  const ctx = { fileExists: async () => true };
  const tooLow = await validateConfig({ MEMORY: "50" }, ctx);
  assert.ok(tooLow.some((i) => i.key === "MEMORY" && i.severity === "error"));

  const notInt = await validateConfig({ MEMORY: "100.5" }, ctx);
  assert.ok(notInt.some((i) => i.key === "MEMORY" && i.severity === "error"));

  const ok = await validateConfig({ MEMORY: "256" }, ctx);
  assert.equal(ok.length, 0);
});

test("validateConfig: MAIN must exist in the project", async () => {
  const missing = await validateConfig({ MAIN: "index.js" }, { fileExists: async () => false });
  assert.ok(missing.some((i) => i.key === "MAIN" && i.severity === "error"));

  const present = await validateConfig({ MAIN: "index.js" }, { fileExists: async () => true });
  assert.equal(present.length, 0);
});

test("validateConfig: SUBDOMAIN must match the slug pattern", async () => {
  const ctx = { fileExists: async () => true };
  const bad = await validateConfig({ SUBDOMAIN: "-bad-" }, ctx);
  assert.ok(bad.some((i) => i.key === "SUBDOMAIN" && i.severity === "error"));
  const good = await validateConfig({ SUBDOMAIN: "my-app-1" }, ctx);
  assert.equal(good.length, 0);
});

test("validateConfig: VERSION accepts known aliases or the runtimes list", async () => {
  const ctx = { fileExists: async () => true, runtimes: ["22.18.0"] };
  const alias = await validateConfig({ VERSION: "recommended" }, ctx);
  assert.equal(alias.length, 0);
  const known = await validateConfig({ VERSION: "22.18.0" }, ctx);
  assert.equal(known.length, 0);
  const unknown = await validateConfig({ VERSION: "9.9.9" }, ctx);
  assert.ok(unknown.some((i) => i.key === "VERSION" && i.severity === "warning"));
});

test("validateConfig: unknown keys warn, NAME/START/BUILD have length limits", async () => {
  const ctx = { fileExists: async () => true };
  const unknown = await validateConfig({ FOO: "bar" }, ctx);
  assert.ok(unknown.some((i) => i.key === "FOO" && i.severity === "warning"));

  const longName = await validateConfig({ NAME: "x".repeat(51) }, ctx);
  assert.ok(longName.some((i) => i.key === "NAME" && i.severity === "error"));

  const longStart = await validateConfig({ START: "x".repeat(513) }, ctx);
  assert.ok(longStart.some((i) => i.key === "START" && i.severity === "error"));

  const longBuild = await validateConfig({ BUILD: "x".repeat(513) }, ctx);
  assert.ok(longBuild.some((i) => i.key === "BUILD" && i.severity === "error"));
});
