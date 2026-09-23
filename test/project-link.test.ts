import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import * as vscode from "vscode";
import type { Memento } from "vscode";
import { FakeMemento } from "./vscode-mock";
import { readLinks, link, unlink, pickFolder } from "../src/project/link";

function memento(): Memento {
  return new FakeMemento() as unknown as Memento;
}

let dirA: string;
let dirB: string;

function folder(dir: string, name: string, index: number): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(dir), name, index } as vscode.WorkspaceFolder;
}

beforeEach(async () => {
  dirA = await mkdtemp(join(tmpdir(), "vertra-link-a-"));
  dirB = await mkdtemp(join(tmpdir(), "vertra-link-b-"));
});

afterEach(async () => {
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
  (vscode.workspace as unknown as { workspaceFolders?: unknown[] }).workspaceFolders = undefined;
});

test("readLinks: config ID= takes precedence over workspaceState", async () => {
  const f = folder(dirA, "a", 0);
  const state = memento();
  await state.update("vertraCloud.links", { [f.uri.toString()]: "from-state" });
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(f.uri, "vertracloud.config"), Buffer.from("ID=from-config\n"));

  const links = await readLinks([f], state);
  assert.equal(links.length, 1);
  assert.equal(links[0].appId, "from-config");
  assert.equal(links[0].source, "config");
});

test("readLinks: falls back to workspaceState when there's no config", async () => {
  const f = folder(dirA, "a", 0);
  const state = memento();
  await state.update("vertraCloud.links", { [f.uri.toString()]: "from-state" });

  const links = await readLinks([f], state);
  assert.equal(links.length, 1);
  assert.equal(links[0].appId, "from-state");
  assert.equal(links[0].source, "workspaceState");
});

test("readLinks: single vs multi-root", async () => {
  const fa = folder(dirA, "a", 0);
  const fb = folder(dirB, "b", 1);
  const state = memento();
  await state.update("vertraCloud.links", { [fa.uri.toString()]: "app-a", [fb.uri.toString()]: "app-b" });

  const single = await readLinks([fa], state);
  assert.equal(single.length, 1);

  const multi = await readLinks([fa, fb], state);
  assert.equal(multi.length, 2);
});

test("link with writeConfig writes the full vertracloud.config from the app", async () => {
  const f = folder(dirA, "a", 0);
  const state = memento();
  const app = {
    id: "app-1", name: "my-app", ram: 512, main_file: "index.js", version: "recommended",
    start_command: null, build_command: "npm run build", subdomain: "my-app.vertraweb.app", description: undefined,
  };
  await link(f, "app-1", { writeConfig: true, app }, state);

  const text = await readFile(join(dirA, "vertracloud.config"), "utf8");
  assert.equal(text, "ID=app-1\nNAME=my-app\nMEMORY=512\nMAIN=index.js\nVERSION=recommended\nSUBDOMAIN=my-app\nBUILD=npm run build\n");
  const links = await readLinks([f], state);
  assert.equal(links[0].source, "config");
});

test("link keeps an existing vertracloud.config and only updates ID", async () => {
  const f = folder(dirA, "a", 0);
  const state = memento();
  await link(f, "app-1", { writeConfig: true, app: { id: "app-1", name: "x", ram: 256, main_file: "a.js", version: "auto", start_command: null, build_command: null, subdomain: null } }, state);
  await link(f, "app-2", { writeConfig: true, app: { id: "app-2", name: "y", ram: 1024, main_file: "b.js", version: "auto", start_command: null, build_command: null, subdomain: null } }, state);

  const text = await readFile(join(dirA, "vertracloud.config"), "utf8");
  assert.ok(text.startsWith("ID=app-2\n"));
  assert.ok(text.includes("NAME=x\n"));
});

test("link without writeConfig only stores in the memento", async () => {
  const f = folder(dirA, "a", 0);
  const state = memento();
  await link(f, "app-1", { writeConfig: false }, state);

  const links = await readLinks([f], state);
  assert.equal(links[0].source, "workspaceState");
  assert.equal(links[0].appId, "app-1");
});

test("unlink clears both config and memento", async () => {
  const f = folder(dirA, "a", 0);
  const state = memento();
  await link(f, "app-1", { writeConfig: true }, state);
  await unlink(f, state);

  const links = await readLinks([f], state);
  assert.equal(links.length, 0);
  const text = await readFile(join(dirA, "vertracloud.config"), "utf8");
  assert.ok(!text.includes("ID="));
});

test("pickFolder returns the only folder without prompting", async () => {
  const f = folder(dirA, "a", 0);
  (vscode.workspace as unknown as { workspaceFolders?: unknown[] }).workspaceFolders = [f];
  const picked = await pickFolder();
  assert.equal(picked, f);
});

test("pickFolder returns undefined when there are no folders", async () => {
  (vscode.workspace as unknown as { workspaceFolders?: unknown[] }).workspaceFolders = [];
  const picked = await pickFolder();
  assert.equal(picked, undefined);
});

test("pickFolder opens a QuickPick when multi-root", async () => {
  const fa = folder(dirA, "a", 0);
  const fb = folder(dirB, "b", 1);
  (vscode.workspace as unknown as { workspaceFolders?: unknown[] }).workspaceFolders = [fa, fb];

  const original = vscode.window.showQuickPick;
  let receivedItems: Array<{ folder: vscode.WorkspaceFolder }> = [];
  (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: unknown) => {
    receivedItems = items as Array<{ folder: vscode.WorkspaceFolder }>;
    return receivedItems[1];
  };

  const picked = await pickFolder();
  assert.equal(picked, fb);
  assert.equal(receivedItems.length, 2);

  (vscode.window as { showQuickPick: unknown }).showQuickPick = original;
});
