import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { isIgnored, loadIgnore } from "../src/deploy/ignore";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-ignore-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("loadIgnore", () => {
  it("ignores defaults like node_modules and .git", async () => {
    const ig = await loadIgnore(root);
    assert.equal(isIgnored(ig, "node_modules", true), true);
    assert.equal(isIgnored(ig, "node_modules/pkg/index.js", false), true);
    assert.equal(isIgnored(ig, ".git", true), true);
    assert.equal(isIgnored(ig, "src/index.ts", false), false);
  });

  it("keeps .env included by default", async () => {
    const ig = await loadIgnore(root);
    assert.equal(isIgnored(ig, ".env", false), false);
  });

  it("applies .vertraignore glob patterns", async () => {
    await fs.writeFile(path.join(root, ".vertraignore"), "*.log\nbuild/\n");
    const ig = await loadIgnore(root);
    assert.equal(isIgnored(ig, "debug.log", false), true);
    assert.equal(isIgnored(ig, "build", true), true);
    assert.equal(isIgnored(ig, "build/output.js", false), true);
    assert.equal(isIgnored(ig, "keep.txt", false), false);
  });

  it("uses .vertracloudignore only when .vertraignore is absent", async () => {
    await fs.writeFile(path.join(root, ".vertraignore"), "*.log\n");
    await fs.writeFile(path.join(root, ".vertracloudignore"), "*.tmp\n");
    const ig = await loadIgnore(root);
    assert.equal(isIgnored(ig, "a.log", false), true);
    assert.equal(isIgnored(ig, "a.tmp", false), false);
  });

  it("falls back to .vertracloudignore when .vertraignore is missing", async () => {
    await fs.writeFile(path.join(root, ".vertracloudignore"), "*.tmp\n");
    const ig = await loadIgnore(root);
    assert.equal(isIgnored(ig, "a.tmp", false), true);
  });

  it("never reads .gitignore as ignore rules", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "*.secret\n");
    const ig = await loadIgnore(root);
    assert.equal(isIgnored(ig, "a.secret", false), false);
  });
});
