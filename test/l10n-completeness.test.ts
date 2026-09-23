import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import pkg from "../package.json";

const ROOT = path.resolve(__dirname, "..");

function readJson(relPath: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}

test("package.nls.* files share the same key set", () => {
  const en = readJson("package.nls.json");
  const ptbr = readJson("package.nls.pt-br.json");
  const es = readJson("package.nls.es.json");
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(Object.keys(ptbr).sort(), enKeys);
  assert.deepEqual(Object.keys(es).sort(), enKeys);
});

test("every %key% referenced in package.json exists in package.nls.json", () => {
  const en = readJson("package.nls.json");
  const raw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  const matches = raw.matchAll(/%([a-zA-Z0-9_.-]+)%/g);
  const missing: string[] = [];
  for (const match of matches) {
    if (!(match[1] in en)) {missing.push(match[1]);}
  }
  assert.deepEqual(missing, []);
});

test("l10n bundles share the same key set", () => {
  const en = readJson("l10n/bundle.l10n.json");
  const ptbr = readJson("l10n/bundle.l10n.pt-br.json");
  const es = readJson("l10n/bundle.l10n.es.json");
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(Object.keys(ptbr).sort(), enKeys);
  assert.deepEqual(Object.keys(es).sort(), enKeys);
});

function collectL10nCalls(dir: string, out: Set<string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectL10nCalls(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) {continue;}
    const text = fs.readFileSync(full, "utf8");
    const regex = /(?:vscode\.l10n|l10n)\.t\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      out.add(match[2].replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c)));
    }
  }
}

test("every vscode.l10n.t(...) literal in src/ has an entry in the English bundle", () => {
  const literals = new Set<string>();
  collectL10nCalls(path.join(ROOT, "src"), literals);
  const en = readJson("l10n/bundle.l10n.json");
  const missing = [...literals].filter((key) => !(key in en));
  assert.deepEqual(missing, [], `missing l10n keys: ${missing.join(", ")}`);
});

test("package.json identity is untouched", () => {
  assert.equal(pkg.name, "vertra-cloud");
  assert.equal(pkg.l10n, "./l10n");
});
