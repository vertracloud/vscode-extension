import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

rmSync("out", { recursive: true, force: true });

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["vscode"],
  outfile: "out/extension.js",
  sourcemap: !production,
  minify: production,
  define: {
    "process.env.VERTRA_API_URL": JSON.stringify(process.env.VERTRA_API_URL ?? ""),
  },
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
