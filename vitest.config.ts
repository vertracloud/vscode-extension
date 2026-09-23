import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/vscode-mock.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
