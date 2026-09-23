import { execFileSync } from "node:child_process";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [/^src\//, /^test\//, /\.map$/, /\.env/, /node_modules\//, /\.vsix$/];

function findVsix(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".vsix"));
  if (files.length === 0) {
    console.error(`no .vsix found in ${dir}`);
    process.exit(1);
  }
  return join(dir, files.sort().at(-1));
}

const target = process.argv[2] ?? findVsix("dist");
const size = statSync(target).size;
const output = execFileSync("unzip", ["-l", target], { encoding: "utf8" });

const entries = output
  .split("\n")
  .slice(3, -3)
  .map((line) => line.trim().split(/\s+/).slice(3).join(" "))
  .filter(Boolean);

const violations = entries.filter((entry) => FORBIDDEN.some((re) => re.test(entry)));

console.log(`${target} — ${(size / 1024).toFixed(1)} KB, ${entries.length} files`);
for (const entry of entries) console.log(`  ${entry}`);

if (violations.length > 0) {
  console.error(`\nforbidden entries found in vsix:\n${violations.map((v) => `  ${v}`).join("\n")}`);
  process.exit(1);
}
