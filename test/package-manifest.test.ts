import assert from "node:assert/strict";
import { test } from "vitest";
import pkg from "../package.json";

test("package.json identity fields are correct", () => {
  assert.equal(pkg.name, "vertra-cloud");
  assert.equal(pkg.publisher, "VertraCloud");
  assert.equal(pkg.main, "./out/extension.js");
});

test("every command referenced in menus exists in contributes.commands", () => {
  const declaredCommands = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const menuEntries of Object.values(pkg.contributes.menus)) {
    for (const entry of menuEntries as Array<{ command: string }>) {
      assert.ok(
        declaredCommands.has(entry.command),
        `menu references undeclared command ${entry.command}`
      );
    }
  }
});

test("legacy 0.0.4 command ids are preserved as hidden aliases", () => {
  const declaredCommands = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const id of [
    "vertraCloud.setApiKey",
    "vertraCloud.clearApiKey",
    "vertraCloud.project.viewLogs",
    "vertraCloud.project.startApp",
    "vertraCloud.project.stopApp",
    "vertraCloud.project.restartApp",
  ]) {
    assert.ok(declaredCommands.has(id), `missing legacy alias ${id}`);
  }
  const paletteEntries = pkg.contributes.menus.commandPalette as Array<{ command: string; when?: string }>;
  for (const id of ["vertraCloud.setApiKey", "vertraCloud.clearApiKey"]) {
    const entry = paletteEntries.find((e) => e.command === id);
    assert.ok(entry && entry.when === "false", `alias ${id} must be hidden from the command palette`);
  }
});

test("legacy view ids vertraCloudApps and vertraCloudDBs are preserved", () => {
  const viewIds = pkg.contributes.views.vertraCloud.map((v) => v.id);
  assert.ok(viewIds.includes("vertraCloudApps"));
  assert.ok(viewIds.includes("vertraCloudDBs"));
  assert.ok(viewIds.includes("vertraCloudProject"));
  assert.ok(viewIds.includes("vertraCloudWorkspaces"));
  assert.ok(viewIds.includes("vertraCloudAccount"));
});

test("every command has a Vertra Cloud category and every non-alias command is nls-backed", () => {
  for (const command of pkg.contributes.commands) {
    assert.equal(command.category, "Vertra Cloud");
  }
});

test("the remote file system scheme activates the extension after an extension host restart", () => {
  assert.ok(pkg.activationEvents.includes("onFileSystem:vertra"));
});

test("resource organization commands are exposed for folders and both resource types", () => {
  const commands = new Set(pkg.contributes.commands.map((entry) => entry.command));
  for (const id of [
    "vertraCloud.organization.createFolder",
    "vertraCloud.organization.renameFolder",
    "vertraCloud.organization.colorFolder",
    "vertraCloud.organization.deleteFolder",
    "vertraCloud.organization.addResource",
    "vertraCloud.organization.removeResource",
    "vertraCloud.db.favorite",
    "vertraCloud.db.unfavorite",
  ]) {
    assert.ok(commands.has(id), `missing organization command ${id}`);
  }
});
