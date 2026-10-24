import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EventEmitter, FakeMemento, registeredCommands } from "./vscode-mock";
import pkg from "../package.json";
import nls from "../package.nls.json";
import { registerImages } from "../src/images/commands";
import type { CommandDeps } from "../src/commands/deps";

type MenuEntry = { command: string; when?: string; group?: string };

describe("Docker images contribution", () => {
  it("declares exactly the commands the extension registers", () => {
    registeredCommands.clear();
    registerImages({
      context: { subscriptions: [], workspaceState: new FakeMemento() },
      client: {},
      session: { onDidChange: new EventEmitter<void>().event },
      store: { workspaces: [], onDidChange: new EventEmitter<void>().event },
    } as unknown as CommandDeps);
    const registered = [...registeredCommands.keys()].filter((id) => id.startsWith("vertraCloud.images.")).sort();
    const declared = pkg.contributes.commands.map((c) => c.command).filter((id) => id.startsWith("vertraCloud.images.")).sort();
    assert.deepEqual(declared, registered);
    assert.equal(registered.length, 12);
  });

  it("has the Docker images view, shown only when connected, and an empty-state welcome", () => {
    const view = pkg.contributes.views.vertraCloud.find((v) => v.id === "vertraCloudImages");
    assert.ok(view);
    assert.equal(view.when, "vertraCloud.connected");
    const welcome = pkg.contributes.viewsWelcome.find((w) => w.view === "vertraCloudImages");
    assert.ok(welcome);
    assert.equal(welcome.contents, "%welcome.images.empty%");
    assert.match((nls as Record<string, string>)["welcome.images.empty"], /command:vertraCloud\.images\.create/);
    assert.match((nls as Record<string, string>)["welcome.images.empty"], /Enterprise 28, 30 and 32/);
  });

  const menu = (id: string): MenuEntry[] => (pkg.contributes.menus["view/item/context"] as MenuEntry[]).filter((e) => e.command === id);

  it("never offers rename, edit description, rebuild, delete, context download or GitHub link on a platform image", () => {
    for (const id of ["rename", "editDescription", "rebuild", "delete", "downloadContext", "linkGithub", "unlinkGithub"]) {
      const entries = menu(`vertraCloud.images.${id}`);
      assert.ok(entries.length > 0, id);
      for (const entry of entries) {
        const re = new RegExp(entry.when!.replace(/^viewItem =~ \//, "").replace(/\/$/, ""));
        assert.equal(re.test("image:success:system"), false, `${id} must hide on system images`);
        assert.equal(re.test(id === "unlinkGithub" ? "image:success:github" : "image:success"), true, `${id} must show on your own images`);
      }
    }
  });

  it("offers 'create application' only for a ready image", () => {
    const entries = menu("vertraCloud.images.createApp");
    for (const entry of entries) {
      const re = new RegExp(entry.when!.replace(/^viewItem =~ \//, "").replace(/\/$/, ""));
      assert.equal(re.test("image:success"), true);
      assert.equal(re.test("image:building"), false);
      assert.equal(re.test("image:failed"), false);
    }
  });

  it("hides the dependency and build restarts on applications that run from an image", () => {
    for (const id of ["restartReinstall", "restartForceBuild"]) {
      const entry = menu(`vertraCloud.app.${id}`)[0];
      const re = new RegExp(entry.when!.replace(/^viewItem =~ \//, "").replace(/\/$/, ""));
      assert.equal(re.test("app:up:published"), true);
      assert.equal(re.test("app:up:published:image"), false);
      assert.equal(re.test("app:up:favorite:image"), false);
    }
  });
});
