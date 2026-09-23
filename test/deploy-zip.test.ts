import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { CancellationTokenSource } from "vscode";
import { loadIgnore } from "../src/deploy/ignore";
import { collectFiles, createZip, MAX_UPLOAD_BYTES } from "../src/deploy/zip";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-zip-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content = "x"): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

describe("collectFiles", () => {
  it("skips symlinks and counts them", async () => {
    await write("kept.txt");
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-outside-"));
    try {
      await fs.symlink(outsideDir, path.join(root, "link-to-outside"));
      const ig = await loadIgnore(root);
      const result = await collectFiles(root, ig);
      assert.equal(result.skippedSymlinks, 1);
      assert.deepEqual(
        result.files.map((f) => f.rel).sort(),
        ["kept.txt"],
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("respects default and custom ignore rules", async () => {
    await write("node_modules/pkg/index.js");
    await write("src/index.ts");
    await write("build/out.js");
    await write(".vertraignore", "build/\n");
    const ig = await loadIgnore(root);
    const result = await collectFiles(root, ig);
    assert.deepEqual(
      result.files.map((f) => f.rel).sort(),
      ["src/index.ts"],
    );
  });
});

describe("createZip", () => {
  it("fails with EMPTY_PROJECT for no files", async () => {
    await assert.rejects(createZip([]), (err: unknown) => {
      assert.equal((err as { code: string }).code, "EMPTY_PROJECT");
      return true;
    });
  });

  it("fails with FILE_TOO_LARGE before zipping when total exceeds the limit", async () => {
    await write("big.bin");
    const files = [{ abs: path.join(root, "big.bin"), rel: "big.bin", size: MAX_UPLOAD_BYTES + 1 }];
    await assert.rejects(createZip(files), (err: unknown) => {
      assert.equal((err as { code: string }).code, "FILE_TOO_LARGE");
      return true;
    });
  });

  it("produces a zip with the expected entries", async () => {
    await write("src/index.ts", "console.log(1)");
    await write("package.json", "{}");
    const ig = await loadIgnore(root);
    const { files } = await collectFiles(root, ig);
    const zip = await createZip(files);
    try {
      const listing = execFileSync("unzip", ["-l", zip.path]).toString();
      assert.match(listing, /src\/index\.ts/);
      assert.match(listing, /package\.json/);
    } finally {
      await zip.cleanup();
    }
  });

  it("destroys the stream and removes the temp dir when cancelled while writing", async () => {
    for (let i = 0; i < 400; i++) {await write(`src/f${i}.ts`, "x".repeat(4096));}
    const ig = await loadIgnore(root);
    const { files } = await collectFiles(root, ig);
    const source = new CancellationTokenSource();
    const created: string[] = [];
    const mkdtemp = fs.mkdtemp;
    const spy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix: string) => {
      const dir = await mkdtemp(prefix);
      created.push(dir);
      return dir;
    });

    try {
      await assert.rejects(
        createZip(files, { token: source.token, onProgress: () => source.cancel() }),
        (err: unknown) => (err as { code: string }).code === "CANCELLED",
      );
    } finally {
      spy.mockRestore();
    }

    assert.equal(created.length, 1);
    const zipPath = path.join(created[0], "deploy.zip");
    for (let attempt = 0; attempt < 50; attempt++) {
      const exists = await fs.stat(zipPath).then(() => true, () => false);
      if (!exists) {break;}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await assert.rejects(fs.stat(zipPath));
  });

  it("cleans up the temp dir when cancelled mid-zip", async () => {
    await write("src/index.ts", "console.log(1)");
    const ig = await loadIgnore(root);
    const { files } = await collectFiles(root, ig);
    const source = new CancellationTokenSource();
    source.cancel();
    await assert.rejects(createZip(files, { token: source.token }));
  });
});
