import assert from "node:assert/strict";
import { test, vi } from "vitest";
import * as vscode from "vscode";
import { createFakeExtensionContext, registeredCommands, Uri } from "./vscode-mock";
import { createDeps } from "../src/commands/index";
import { registerProjectCommands } from "../src/commands/project";

let deployImplementation: typeof import("../src/deploy/deploy").deployToApp = async () => ({});
vi.mock("../src/deploy/deploy", () => ({
  deployToApp: (...args: Parameters<typeof deployImplementation>) => deployImplementation(...args),
  createAppFromFolder: async () => ({}),
}));
import type { AppEntry, Store } from "../src/state";
import type { ProjectLinks } from "../src/project/link";

const FOLDER = { uri: Uri.file("/tmp/project"), name: "project", index: 0 };

function setup(deployImpl: typeof deployImplementation, onRequest: (path: string) => unknown = () => ({})) {
  registeredCommands.clear();
  const polls: Array<{ id: string; expect: string }> = [];
  deployImplementation = deployImpl;

  const entry = {
    app: { id: "app-1", name: "my-app", ram: 512, status: "up", public_url: null },
    favorite: false,
  } as unknown as AppEntry;

  const store = {
    apps: [entry],
    databases: [],
    async pollAfterMutation(id: string, expect: string) {
      polls.push({ id, expect });
    },
    async refresh() {},
  } as unknown as Store;

  const links = {
    links: [{ folder: FOLDER, appId: "app-1", source: "config" }],
    async refresh() {},
  } as unknown as ProjectLinks;

  const context = createFakeExtensionContext();
  const deps = createDeps(context as unknown as vscode.ExtensionContext, {
    client: { request: async (path: string) => onRequest(path) } as never,
    session: {} as never,
    store,
    links,
    realtime: {} as never,
    refreshViews: () => {},
  });
  const errors: unknown[] = [];
  deps.showError = (err) => {
    errors.push(err);
  };
  registerProjectCommands(deps);

  return {
    polls,
    errors,
    restore: () => {
      deployImplementation = async () => ({});
    },
  };
}

function answerQuickPick(value: unknown): () => void {
  const original = vscode.window.showQuickPick;
  (vscode.window as { showQuickPick: unknown }).showQuickPick = () => Promise.resolve(value);
  return () => ((vscode.window as { showQuickPick: unknown }).showQuickPick = original);
}

test("deploy uses the linked app id and the chosen restart flag", async () => {
  const seen: Array<{ appId: string; restart: boolean; root: string }> = [];
  const harness = setup(async (_client, opts) => {
    seen.push({ appId: opts.appId, restart: opts.restart, root: opts.root });
    return {};
  });
  const restoreQuickPick = answerQuickPick("Yes");

  await vscode.commands.executeCommand("vertraCloud.project.deploy");

  restoreQuickPick();
  harness.restore();
  assert.deepEqual(seen, [{ appId: "app-1", restart: true, root: FOLDER.uri.fsPath }]);
  assert.deepEqual(harness.polls, [{ id: "app-1", expect: "up" }]);
});

test("deploy answers No without restarting", async () => {
  const seen: boolean[] = [];
  const harness = setup(async (_client, opts) => {
    seen.push(opts.restart);
    return {};
  });
  const restoreQuickPick = answerQuickPick("No");

  await vscode.commands.executeCommand("vertraCloud.project.deploy");

  restoreQuickPick();
  harness.restore();
  assert.deepEqual(seen, [false]);
});

test("deploy routes an API error through showError without throwing", async () => {
  const harness = setup(async () => {
    throw Object.assign(new Error("nope"), { code: "PLAN_RESTRICTED_FEATURE" });
  });
  const restoreQuickPick = answerQuickPick("Yes");

  await vscode.commands.executeCommand("vertraCloud.project.deploy");

  restoreQuickPick();
  harness.restore();

  assert.equal(harness.errors.length, 1);
  assert.deepEqual(harness.polls, []);
});
