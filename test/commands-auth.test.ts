import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import * as vscode from "vscode";
import { createFakeExtensionContext, registeredCommands } from "./vscode-mock";
import { activate, deactivate } from "../src/extension";

const SECRET_KEY = "vertraCloudApiKey";

const USER = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
  plan: { name: "Pro", memory: { used: 0, limit: 1024 } },
  applications: [],
  databases: [],
};

type Fetch = typeof globalThis.fetch;
let originalFetch: Fetch;
let originalShowInputBox: typeof vscode.window.showInputBox;
let originalShowWarningMessage: typeof vscode.window.showWarningMessage;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(validKeys: Set<string>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/status")) {return jsonResponse({ response: { status: "healthy", message: "ok" } });}
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const key = auth.replace(/^Bearer /, "");
    if (!validKeys.has(key)) {
      return jsonResponse({ code: "API_KEY_INVALID" }, 401);
    }
    if (url.includes("/v1/users/me")) {return jsonResponse({ response: USER });}
    return jsonResponse({ response: [] });
  }) as Fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalShowInputBox = vscode.window.showInputBox;
  originalShowWarningMessage = vscode.window.showWarningMessage;
  registeredCommands.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (vscode.window as { showInputBox: unknown }).showInputBox = originalShowInputBox;
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalShowWarningMessage;
  deactivate();
});

async function activateWith(validKeys: Set<string>) {
  stubFetch(validKeys);
  const context = createFakeExtensionContext();
  await activate(context as unknown as vscode.ExtensionContext);
  return context;
}

function answerInputBox(value: string | undefined): void {
  (vscode.window as { showInputBox: unknown }).showInputBox = () => Promise.resolve(value);
}

test("useApiKey stores a valid key only in SecretStorage", async () => {
  const context = await activateWith(new Set(["good-key"]));
  answerInputBox("good-key");
  await vscode.commands.executeCommand("vertraCloud.useApiKey");

  assert.equal(await context.secrets.get(SECRET_KEY), "good-key");
  const leaked = [...context.globalState.keys(), ...context.workspaceState.keys()].some((key) =>
    JSON.stringify(context.globalState.get(key) ?? context.workspaceState.get(key)).includes("good-key"),
  );
  assert.equal(leaked, false, "the API key must never reach a Memento");
});

test("useApiKey does not store an invalid key", async () => {
  const context = await activateWith(new Set(["good-key"]));
  answerInputBox("bad-key");

  await vscode.commands.executeCommand("vertraCloud.useApiKey");

  assert.equal(await context.secrets.get(SECRET_KEY), undefined);
});

test("disconnect clears the stored key after confirmation", async () => {
  const context = await activateWith(new Set(["good-key"]));
  answerInputBox("good-key");
  await vscode.commands.executeCommand("vertraCloud.useApiKey");
  assert.equal(await context.secrets.get(SECRET_KEY), "good-key");

  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (
    _message: string,
    _options: unknown,
    confirm: string,
  ) => Promise.resolve(confirm);

  await vscode.commands.executeCommand("vertraCloud.disconnect");
  assert.equal(await context.secrets.get(SECRET_KEY), undefined);
});

test("disconnect keeps the key when the confirmation is dismissed", async () => {
  const context = await activateWith(new Set(["good-key"]));
  answerInputBox("good-key");
  await vscode.commands.executeCommand("vertraCloud.useApiKey");

  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = () => Promise.resolve(undefined);
  await vscode.commands.executeCommand("vertraCloud.disconnect");

  assert.equal(await context.secrets.get(SECRET_KEY), "good-key");
});

test("legacy ids delegate to the current commands", async () => {
  const context = await activateWith(new Set(["good-key"]));

  answerInputBox("good-key");
  await vscode.commands.executeCommand("vertraCloud.setApiKey");
  assert.equal(await context.secrets.get(SECRET_KEY), "good-key");

  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (
    _message: string,
    _options: unknown,
    confirm: string,
  ) => Promise.resolve(confirm);
  await vscode.commands.executeCommand("vertraCloud.clearApiKey");
  assert.equal(await context.secrets.get(SECRET_KEY), undefined);
});
