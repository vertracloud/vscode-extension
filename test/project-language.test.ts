import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import * as vscode from "vscode";
import {
  createFakeTextDocument,
  registeredCompletionProviders,
  registeredHoverProviders,
} from "./vscode-mock";
import { registerConfigLanguage } from "../src/project/language";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vertra-lang-"));
  registeredCompletionProviders.length = 0;
  registeredHoverProviders.length = 0;
  (vscode.workspace as unknown as { workspaceFolders?: unknown[] }).workspaceFolders = [
    { uri: vscode.Uri.file(dir), name: "proj", index: 0 },
  ];
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(): { subscriptions: vscode.Disposable[] } {
  const context = { subscriptions: [] as vscode.Disposable[] };
  registerConfigLanguage(context, {});
  return context;
}

test("completion suggests known keys at the start of a line", async () => {
  setup();
  const provider = registeredCompletionProviders[0];
  const doc = createFakeTextDocument(vscode.Uri.file(join(dir, "vertracloud.config")), "");
  const items = (await provider.provideCompletionItems(
    doc as never,
    new vscode.Position(0, 0) as never,
  )) as vscode.CompletionItem[];
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("MEMORY"));
  assert.ok(labels.includes("MAIN"));
});

test("completion after MAIN= lists real files in the folder", async () => {
  await fsWriteFile(join(dir, "index.js"), "");
  await fsWriteFile(join(dir, "vertracloud.config"), "MAIN=");
  setup();
  const provider = registeredCompletionProviders[0];
  const doc = createFakeTextDocument(vscode.Uri.file(join(dir, "vertracloud.config")), "MAIN=");
  const items = (await provider.provideCompletionItems(
    doc as never,
    new vscode.Position(0, 5) as never,
  )) as vscode.CompletionItem[];
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes("index.js"));
});

test("diagnostics flag an invalid MEMORY with the value's range", async () => {
  const uri = vscode.Uri.file(join(dir, "vertracloud.config"));
  await fsWriteFile(uri.fsPath, "MEMORY=10\n");
  const doc = createFakeTextDocument(uri, "MEMORY=10\n");

  let captured: vscode.DiagnosticCollection | undefined;
  const originalCreate = vscode.languages.createDiagnosticCollection;
  (vscode.languages as { createDiagnosticCollection: unknown }).createDiagnosticCollection = (name?: string) => {
    captured = originalCreate(name);
    return captured;
  };

  const openHandlers: Array<(d: unknown) => void> = [];
  const originalOpen = vscode.workspace.onDidOpenTextDocument;
  (vscode.workspace as { onDidOpenTextDocument: unknown }).onDidOpenTextDocument = (
    listener: (d: unknown) => void,
  ) => {
    openHandlers.push(listener);
    return { dispose: () => {} };
  };

  const context = { subscriptions: [] as vscode.Disposable[] };
  registerConfigLanguage(context, {});
  for (const handler of openHandlers) {handler(doc);}
  await new Promise((r) => setTimeout(r, 20));

  const diagnostics = captured?.get(uri) ?? [];
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /MEMORY/);
  assert.equal(diagnostics[0].range.start.line, 0);
  assert.equal(diagnostics[0].range.start.character, "MEMORY=".length);

  (vscode.languages as { createDiagnosticCollection: unknown }).createDiagnosticCollection = originalCreate;
  (vscode.workspace as { onDidOpenTextDocument: unknown }).onDidOpenTextDocument = originalOpen;
});

test("hover returns documentation for a known key", () => {
  setup();
  const provider = registeredHoverProviders[0];
  const doc = createFakeTextDocument(vscode.Uri.file(join(dir, "vertracloud.config")), "MEMORY=256");
  const hover = provider.provideHover(doc as never, new vscode.Position(0, 2) as never) as vscode.Hover | undefined;
  assert.ok(hover);
  const content = (Array.isArray(hover?.contents) ? hover?.contents[0] : hover?.contents) as vscode.MarkdownString;
  assert.match(content.value, /Memory in MB/);
});
