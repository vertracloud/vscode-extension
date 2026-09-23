import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import yazl from "yazl";
import { extractInto } from "../src/deploy/pull";

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) {zip.addBuffer(Buffer.from(content), name);}
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

describe("extractInto", () => {
  it("writes zip files into the folder, keeps unrelated local files and skips ignored entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-pull-"));
    await fs.writeFile(path.join(root, "keep.txt"), "local");
    await fs.writeFile(path.join(root, "index.js"), "old");
    await fs.writeFile(path.join(root, "vertracloud.config"), "ID=app-1\n");
    const buffer = await zipOf({
      "index.js": "new",
      "src/app.js": "app",
      "node_modules/x/index.js": "dep",
      "vertracloud.config": "NAME=remote\n",
      ".vertracloud/logs/last.log": "log",
    });

    const result = await extractInto(buffer, root);

    assert.equal(await fs.readFile(path.join(root, "index.js"), "utf8"), "new");
    assert.equal(await fs.readFile(path.join(root, "src", "app.js"), "utf8"), "app");
    assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "local");
    await assert.rejects(fs.stat(path.join(root, "node_modules")));
    await assert.rejects(fs.stat(path.join(root, ".vertracloud")));
    assert.equal(await fs.readFile(path.join(root, "vertracloud.config"), "utf8"), "ID=app-1\n");
    assert.deepEqual(result, { written: 2, skipped: 3 });
    await fs.rm(root, { recursive: true, force: true });
  });
});
