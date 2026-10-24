import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  collectImageContext,
  contextFileList,
  packImageContext,
  parseDockerignore,
  isDockerignored,
  IMAGE_CONTEXT_MAX_ENTRIES,
} from "../src/images/context";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-image-ctx-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content = "x"): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

const rels = (files: Array<{ rel: string }>): string[] => files.map((f) => f.rel).sort();

describe("parseDockerignore / isDockerignored", () => {
  const ignored = (content: string, rel: string): boolean => isDockerignored(parseDockerignore(content), rel);

  it("matches a directory and everything under it", () => {
    assert.equal(ignored("node_modules\n", "node_modules"), true);
    assert.equal(ignored("node_modules\n", "node_modules/pkg/index.js"), true);
    assert.equal(ignored("node_modules\n", "src/node_modules/x.js"), false);
  });

  it("follows Docker rules: a bare glob only matches at the root, ** matches at any depth", () => {
    assert.equal(ignored("*.md\n", "README.md"), true);
    assert.equal(ignored("*.md\n", "docs/README.md"), false);
    assert.equal(ignored("**/*.md\n", "docs/deep/README.md"), true);
  });

  it("lets the last matching line win and supports ! re-inclusion", () => {
    const content = "*.log\n!keep.log\n";
    assert.equal(ignored(content, "a.log"), true);
    assert.equal(ignored(content, "keep.log"), false);
    assert.equal(ignored("!keep.log\n*.log\n", "keep.log"), true);
  });

  it("ignores comments, blank lines, CRLF and malformed lines", () => {
    assert.equal(ignored("# comment\r\n\r\ntmp\r\n", "tmp"), true);
    assert.equal(ignored("# comment\n", "# comment"), false);
    assert.equal(ignored("[\n", "x"), false);
  });

  it("supports ?, character classes and escaped characters", () => {
    assert.equal(ignored("a?c\n", "abc"), true);
    assert.equal(ignored("a?c\n", "a/c"), false);
    assert.equal(ignored("[ab]x\n", "bx"), true);
    assert.equal(ignored("[!ab]x\n", "bx"), false);
    assert.equal(ignored("a\\*b\n", "a*b"), true);
    assert.equal(ignored("a\\*b\n", "aXb"), false);
  });

  it("normalizes leading slashes, trailing slashes and dot segments", () => {
    assert.equal(ignored("/build/\n", "build"), true);
    assert.equal(ignored("./build\n", "build/out.js"), true);
  });
});

describe("collectImageContext", () => {
  it("refuses a folder without a file named exactly Dockerfile", async () => {
    await write("index.js");
    await assert.rejects(collectImageContext(root), (err: unknown) => (err as { code: string }).code === "DOCKERFILE_NOT_FOUND");
  });

  it("does not accept other spellings of the name", async () => {
    await write("dockerfile", "FROM scratch\n");
    await assert.rejects(collectImageContext(root), (err: unknown) => (err as { code: string }).code === "DOCKERFILE_NOT_FOUND");
  });

  it("refuses a Dockerfile that is a symlink or a directory", async () => {
    await write("real", "FROM scratch\n");
    await fs.symlink(path.join(root, "real"), path.join(root, "Dockerfile"));
    await assert.rejects(collectImageContext(root), (err: unknown) => (err as { code: string }).code === "DOCKERFILE_NOT_FOUND");
  });

  it("refuses a Dockerfile above 1 MB before anything is sent", async () => {
    await write("Dockerfile", "#".repeat(1024 * 1024 + 1));
    await assert.rejects(collectImageContext(root), (err: unknown) => (err as { code: string }).code === "IMAGE_CONTEXT_TOO_LARGE");
  });

  it("collects the project and reads the Dockerfile", async () => {
    await write("Dockerfile", "FROM node:22\n");
    await write("src/index.js");
    const ctx = await collectImageContext(root);
    assert.deepEqual(rels(ctx.files), ["Dockerfile", "src/index.js"]);
    assert.equal(ctx.dockerfile, "FROM node:22\n");
  });

  it("applies .dockerignore but never drops the Dockerfile", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write(".dockerignore", "Dockerfile\nnode_modules\n*.tmp\n");
    await write("node_modules/p/i.js");
    await write("a.tmp");
    await write("b.txt");
    const ctx = await collectImageContext(root);
    assert.deepEqual(rels(ctx.files), [".dockerignore", "Dockerfile", "b.txt"]);
  });

  it("keeps node_modules and .git when no .dockerignore says otherwise (the Dockerfile may COPY them)", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("node_modules/p/i.js");
    const ctx = await collectImageContext(root);
    assert.deepEqual(rels(ctx.files), ["Dockerfile", "node_modules/p/i.js"]);
  });

  it("never includes .env files, even when .dockerignore re-includes them", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write(".env", "SECRET=1");
    await write(".env.production", "SECRET=2");
    await write("sub/.env.local", "SECRET=3");
    await write(".dockerignore", "!.env*\n!**/.env*\n");
    const ctx = await collectImageContext(root);
    assert.deepEqual(rels(ctx.files), [".dockerignore", "Dockerfile"]);
    assert.deepEqual([...ctx.envFiles].sort(), [".env", ".env.production", "sub/.env.local"]);
  });

  it("does not list a .env excluded by .dockerignore among the env files", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write(".env", "SECRET=1");
    await write(".dockerignore", ".env\n");
    const ctx = await collectImageContext(root);
    assert.deepEqual(ctx.envFiles, []);
  });

  it("skips symlinks and counts them", async () => {
    await write("Dockerfile", "FROM scratch\n");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-image-out-"));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "x");
      await fs.symlink(outside, path.join(root, "dir-link"));
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "file-link"));
      const ctx = await collectImageContext(root);
      assert.deepEqual(rels(ctx.files), ["Dockerfile"]);
      assert.equal(ctx.skippedSymlinks, 2);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("stops with IMAGE_CONTEXT_TOO_LARGE past the entry limit", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("a/b.txt");
    await assert.rejects(
      collectImageContext(root, { maxEntries: 1 }),
      (err: unknown) => (err as { code: string }).code === "IMAGE_CONTEXT_TOO_LARGE",
    );
    assert.equal(IMAGE_CONTEXT_MAX_ENTRIES, 50_000);
  });

  it("stops with IMAGE_CONTEXT_TOO_LARGE past the uncompressed size limit", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("big.bin", "x".repeat(100));
    await assert.rejects(
      collectImageContext(root, { maxBytes: 50 }),
      (err: unknown) => (err as { code: string }).code === "IMAGE_CONTEXT_TOO_LARGE",
    );
  });
});

describe("contextFileList", () => {
  it("lists what will be sent plus the .env files that were left out, without duplicates", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("src/a.js");
    await write(".env", "K=1");
    const ctx = await collectImageContext(root);
    assert.deepEqual(contextFileList(ctx).sort(), [".env", "Dockerfile", "src/a.js"]);
  });
});

describe("packImageContext", () => {
  it("keeps the executable bit, which a COPY'd entrypoint script needs", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("run.sh", "#!/bin/sh\n");
    await fs.chmod(path.join(root, "run.sh"), 0o755);
    const ctx = await collectImageContext(root);
    const zip = await packImageContext(ctx);
    try {
      const listing = execFileSync("unzip", ["-Z", zip.path]).toString();
      assert.match(listing, /-rwxr-xr-x.*run\.sh/);
    } finally {
      await zip.cleanup();
    }
  });

  it("zips the context with the Dockerfile at the root and no .env", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("src/a.js");
    await write(".env", "K=1");
    const ctx = await collectImageContext(root);
    const zip = await packImageContext(ctx);
    try {
      const listing = execFileSync("unzip", ["-Z1", zip.path]).toString().split("\n").filter(Boolean).sort();
      assert.deepEqual(listing, ["Dockerfile", "src/a.js"]);
    } finally {
      await zip.cleanup();
    }
  });
});

describe("names with a backslash (POSIX)", () => {
  it.skipIf(process.platform === "win32")("skips them, so a zip entry never turns cfg\\.env into cfg/.env", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("cfg\\.env", "K=1");
    await write("a\\..\\..\\b", "x");
    await write("ok.txt");
    const ctx = await collectImageContext(root);
    assert.deepEqual(rels(ctx.files), ["Dockerfile", "ok.txt"]);
    const zip = await packImageContext(ctx);
    await zip.cleanup();
  });
});

describe("packImageContext re-checks each file", () => {
  it.skipIf(process.platform === "win32")("refuses a file swapped for a symlink after the scan", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("a.txt", "x");
    const ctx = await collectImageContext(root);
    await fs.rm(path.join(root, "a.txt"));
    await fs.symlink("/etc/hosts", path.join(root, "a.txt"));
    await assert.rejects(packImageContext(ctx), /changed while|a\.txt/);
  });

  it("refuses a file whose size changed after the scan", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("a.txt", "x");
    const ctx = await collectImageContext(root);
    await fs.writeFile(path.join(root, "a.txt"), "much longer content");
    await assert.rejects(packImageContext(ctx), /changed while|a\.txt/);
  });

  it("removes the temporary directory when packing throws", async () => {
    await write("Dockerfile", "FROM scratch\n");
    await write("a.txt", "x");
    const ctx = await collectImageContext(root);
    await fs.rm(path.join(root, "a.txt"));
    const made: string[] = [];
    const real = fs.mkdtemp.bind(fs);
    const spy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix: string) => {
      const dir = await real(prefix);
      made.push(dir);
      return dir;
    });
    try {
      await assert.rejects(packImageContext(ctx));
    } finally {
      spy.mockRestore();
    }
    assert.equal(made.length, 1);
    await assert.rejects(fs.stat(made[0]));
  });
});
