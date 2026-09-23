import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import * as vscode from "vscode";
import { createFakeExtensionContext, registeredCommands } from "./vscode-mock";
import { activate, deactivate } from "../src/extension";
import { Store } from "../src/state";
import { RealtimeManager } from "../src/realtime";

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as { contributes: { commands: Array<{ command: string }> } };

const MANIFEST_COMMANDS = manifest.contributes.commands.map((entry) => entry.command);

const LEGACY_COMMANDS = [
  "vertraCloud.setApiKey",
  "vertraCloud.clearApiKey",
  "vertraCloud.project.viewLogs",
  "vertraCloud.project.startApp",
  "vertraCloud.project.stopApp",
  "vertraCloud.project.restartApp",
];

async function activateQuietly(): Promise<{
  context: ReturnType<typeof createFakeExtensionContext>;
  prompts: string[];
}> {
  registeredCommands.clear();
  const prompts: string[] = [];
  const originals = {
    showInputBox: vscode.window.showInputBox,
    showWarningMessage: vscode.window.showWarningMessage,
    showInformationMessage: vscode.window.showInformationMessage,
  };
  for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
    (vscode.window as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      prompts.push(name);
      return (originals[name] as (...a: unknown[]) => unknown)(...args);
    };
  }

  const context = createFakeExtensionContext();
  await activate(context as unknown as vscode.ExtensionContext);

  for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
    (vscode.window as unknown as Record<string, unknown>)[name] = originals[name];
  }
  return { context, prompts };
}

test("activate registers every command declared in the manifest", async () => {
  const { prompts } = await activateQuietly();

  for (const command of [...MANIFEST_COMMANDS, ...LEGACY_COMMANDS]) {
    assert.ok(registeredCommands.has(command), `expected command ${command} to be registered`);
  }
  const declared = new Set([...MANIFEST_COMMANDS, ...LEGACY_COMMANDS]);
  for (const command of registeredCommands.keys()) {
    assert.ok(declared.has(command), `command ${command} is registered but not declared in package.json`);
  }
  assert.deepEqual(prompts, [], "activate must not prompt the user");
  deactivate();
});

test("activate leaves the session disconnected when SecretStorage is empty", async () => {
  const { context } = await activateQuietly();
  assert.equal(await context.secrets.get("vertraCloudApiKey"), undefined);
  deactivate();
});

test("deactivate disposes the store and the realtime manager", async () => {
  const storeDispose = Store.prototype.dispose;
  const realtimeDispose = RealtimeManager.prototype.dispose;
  let storeDisposed = 0;
  let realtimeDisposed = 0;
  Store.prototype.dispose = function spyStoreDispose(this: Store) {
    storeDisposed++;
    storeDispose.call(this);
  };
  RealtimeManager.prototype.dispose = function spyRealtimeDispose(this: RealtimeManager) {
    realtimeDisposed++;
    realtimeDispose.call(this);
  };

  await activateQuietly();
  deactivate();

  Store.prototype.dispose = storeDispose;
  RealtimeManager.prototype.dispose = realtimeDispose;

  assert.equal(storeDisposed, 1);
  assert.equal(realtimeDisposed, 1);
});
