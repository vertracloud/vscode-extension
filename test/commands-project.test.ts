import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import * as vscode from "vscode";
import { createFakeExtensionContext, registeredCommands, Uri } from "./vscode-mock";
import { createDeps } from "../src/commands/index";
import { fieldsFromConfig, registerProjectCommands } from "../src/commands/project";

let createImplementation: (...args: unknown[]) => Promise<unknown> = async () => ({});
let deployImplementation: typeof import("../src/deploy/deploy").deployToApp = async () => ({});
vi.mock("../src/deploy/deploy", () => ({
  deployToApp: (...args: Parameters<typeof deployImplementation>) => deployImplementation(...args),
  createAppFromFolder: (...args: unknown[]) => createImplementation(...args),
}));
import type { AppEntry, Store } from "../src/state";
import type { ProjectLinks } from "../src/project/link";

const FOLDER = { uri: Uri.file("/tmp/project"), name: "project", index: 0 };

let inputAnswer: string | undefined = "";

function setup(deployImpl: typeof deployImplementation, onRequest: (path: string) => unknown = () => ({})) {
  registeredCommands.clear();
  // A mensagem do deploy é uma caixa de texto: vazio = sem mensagem, undefined (Esc) = cancela.
  const originalInputBox = vscode.window.showInputBox;
  (vscode.window as { showInputBox: unknown }).showInputBox = () => Promise.resolve(inputAnswer);
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
      inputAnswer = "";
      (vscode.window as { showInputBox: unknown }).showInputBox = originalInputBox;
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

test("deploy sends the message typed in the box", async () => {
  const seen: Array<string | undefined> = [];
  inputAnswer = "fix: boot";
  const harness = setup(async (_client, opts) => {
    seen.push(opts.message);
    return {};
  });
  const restoreQuickPick = answerQuickPick("Yes");

  await vscode.commands.executeCommand("vertraCloud.project.deploy");

  restoreQuickPick();
  harness.restore();
  assert.deepEqual(seen, ["fix: boot"]);
});

test("Esc on the message box cancels the deploy", async () => {
  let called = false;
  inputAnswer = undefined;
  const harness = setup(async () => {
    called = true;
    return {};
  });
  const restoreQuickPick = answerQuickPick("Yes");

  await vscode.commands.executeCommand("vertraCloud.project.deploy");

  restoreQuickPick();
  harness.restore();
  assert.equal(called, false);
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

test("fieldsFromConfig turns AUTORESTART into a boolean and leaves it out otherwise", () => {
  const base = { NAME: "a", MAIN: "index.js", MEMORY: "256", VERSION: "recommended" };
  assert.equal(fieldsFromConfig({ ...base, AUTORESTART: "false" }).auto_restart, false);
  assert.equal(fieldsFromConfig({ ...base, AUTORESTART: "TRUE" }).auto_restart, true);
  assert.equal(fieldsFromConfig(base).auto_restart, undefined);
  assert.equal(fieldsFromConfig({ ...base, AUTORESTART: "" }).auto_restart, undefined);
});

async function createFromConfig(config: string): Promise<{ created: Array<Record<string, unknown>>; errors: unknown[] }> {
  const dir = await mkdtemp(join(tmpdir(), "vertra-create-"));
  await writeFile(join(dir, "vertracloud.config"), config, "utf8");
  const created: Array<Record<string, unknown>> = [];
  createImplementation = async (_client, opts) => {
    created.push((opts as { fields: Record<string, unknown> }).fields);
    return { id: "new-1", name: "a", status: "up" };
  };
  const harness = setup(async () => ({}));
  const restoreQuickPick = answerQuickPick("Create a new application");
  const originalOpen = vscode.window.showOpenDialog;
  (vscode.window as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve([Uri.file(dir)]);
  try {
    await vscode.commands.executeCommand("vertraCloud.project.deployFolder");
  } finally {
    (vscode.window as { showOpenDialog: unknown }).showOpenDialog = originalOpen;
    restoreQuickPick();
    harness.restore();
    createImplementation = async () => ({});
    await rm(dir, { recursive: true, force: true });
  }
  return { created, errors: harness.errors };
}

const BASE_CONFIG = "NAME=a\nMAIN=index.js\nMEMORY=256\nVERSION=recommended\n";

test("creating from a folder with an invalid AUTORESTART shows the error and creates nothing", async () => {
  const { created, errors } = await createFromConfig(`${BASE_CONFIG}AUTORESTART=maybe\n`);
  assert.deepEqual(created, []);
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /AUTORESTART must be true or false\./);
});

test("creating from a folder sends AUTORESTART=TRUE as true and omits it when absent", async () => {
  const upper = await createFromConfig(`${BASE_CONFIG}AUTORESTART=TRUE\n`);
  assert.equal(upper.created[0].auto_restart, true);
  const absent = await createFromConfig(BASE_CONFIG);
  assert.equal(absent.created[0].auto_restart, undefined);
  const empty = await createFromConfig(`${BASE_CONFIG}AUTORESTART=\n`);
  assert.equal(empty.errors.length, 0);
  assert.equal(empty.created[0].auto_restart, undefined);
});
