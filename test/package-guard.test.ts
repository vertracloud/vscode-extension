import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import yazl from "yazl";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "inspect-vsix.mjs");

const SHIPPED = ["extension/package.json", "extension/out/extension.js", "extension/readme.md"];

async function writeVsix(extra: string[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vertra-vsix-"));
  const file = path.join(dir, "test.vsix");
  const zip = new yazl.ZipFile();
  for (const name of [...SHIPPED, ...extra]) {zip.addBuffer(Buffer.from("x"), name);}
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    zip.outputStream.pipe(out);
    out.on("close", resolve);
    out.on("error", reject);
  });
  return file;
}

function inspect(file: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

describe("inspect-vsix", () => {
  it("passes a package with only shipped files", async () => {
    assert.equal(inspect(await writeVsix([])).status, 0);
  });

  for (const forbidden of [
    "extension/AGENTS.md",
    "extension/AGENT.md",
    "extension/CLAUDE.md",
    "extension/.claude/rules/area.md",
    "extension/src/extension.ts",
    "extension/test/network.test.ts",
    "extension/out/extension.js.map",
    "extension/.env",
  ]) {
    it(`rejects ${forbidden}`, async () => {
      const result = inspect(await writeVsix([forbidden]));
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(forbidden));
    });
  }
});

describe(".vscodeignore", () => {
  const lines = fs
    .readFileSync(path.join(ROOT, ".vscodeignore"), "utf8")
    .split("\n")
    .map((line) => line.trim());

  for (const entry of ["AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/**"]) {
    it(`excludes ${entry}`, () => {
      assert.ok(lines.includes(entry));
    });
  }
});
