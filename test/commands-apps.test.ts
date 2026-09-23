import assert from "node:assert/strict";
import { test } from "vitest";
import * as vscode from "vscode";
import { createFakeExtensionContext, registeredCommands } from "./vscode-mock";
import { createDeps } from "../src/commands/index";
import { registerAppsCommands, summarize } from "../src/commands/apps";
import type { AppEntry, Store } from "../src/state";
import type { ApiClient } from "../src/api/client";

function appEntry(overrides: Partial<AppEntry["app"]> = {}): AppEntry {
  return {
    app: {
      id: "app-1",
      name: "my-app",
      ram: 512,
      status: "up",
      public_url: null,
      ...overrides,
    } as AppEntry["app"],
    status: { id: "app-1", running: true, ram: "100", cpu: "1", installing: false } as AppEntry["status"],
    favorite: false,
  };
}

interface Harness {
  calls: Array<{ path: string; method: string }>;
  polls: Array<{ id: string; expect: string }>;
  store: Store;
}

function setup(entries: AppEntry[], responder?: (path: string) => unknown): Harness {
  registeredCommands.clear();
  const calls: Array<{ path: string; method: string }> = [];
  const polls: Array<{ id: string; expect: string }> = [];

  const client = {
    request: async (path: string, opts?: { method?: string }) => {
      calls.push({ path, method: opts?.method ?? "GET" });
      return responder?.(path) ?? {};
    },
  } as unknown as ApiClient;

  const store = {
    apps: entries,
    databases: [],
    async pollAfterMutation(id: string, expect: string) {
      polls.push({ id, expect });
    },
    async refresh() {},
    async toggleFavorite() {},
  } as unknown as Store;

  const context = createFakeExtensionContext();
  const deps = createDeps(context as unknown as vscode.ExtensionContext, {
    client,
    session: {} as never,
    store,
    links: { links: [], async refresh() {} } as never,
    realtime: {} as never,
    refreshViews: () => {},
  });
  registerAppsCommands(deps);

  return { calls, polls, store };
}

test("start calls the endpoint and then polls, without writing an optimistic status", async () => {
  const entry = appEntry();
  const before = entry.status;
  const harness = setup([entry]);

  await vscode.commands.executeCommand("vertraCloud.app.start", "app-1");

  assert.deepEqual(harness.calls, [{ path: "/v1/apps/app-1/start", method: "POST" }]);
  assert.deepEqual(harness.polls, [{ id: "app-1", expect: "up" }]);
  assert.equal(entry.status, before, "the command must not mutate the cached status");
});

test("stop polls for the down state", async () => {
  const harness = setup([appEntry()]);
  await vscode.commands.executeCommand("vertraCloud.app.stop", "app-1");
  assert.deepEqual(harness.polls, [{ id: "app-1", expect: "down" }]);
});

test("delete does nothing when the name isn't typed back", async () => {
  const harness = setup([appEntry()]);
  const original = vscode.window.showInputBox;
  (vscode.window as { showInputBox: unknown }).showInputBox = () => Promise.resolve("wrong-name");

  await vscode.commands.executeCommand("vertraCloud.app.delete", "app-1");

  (vscode.window as { showInputBox: unknown }).showInputBox = original;
  assert.deepEqual(harness.calls, []);
});

test("delete calls the endpoint once the name matches", async () => {
  const harness = setup([appEntry()]);
  const original = vscode.window.showInputBox;
  (vscode.window as { showInputBox: unknown }).showInputBox = () => Promise.resolve("my-app");

  await vscode.commands.executeCommand("vertraCloud.app.delete", "app-1");

  (vscode.window as { showInputBox: unknown }).showInputBox = original;
  assert.deepEqual(harness.calls, [{ path: "/v1/apps/app-1", method: "DELETE" }]);
});

test("showMetrics summarizes the last point plus the average and peak", () => {
  const lines = summarize([
    { cpu: 10, ram: 1024, storage: 2048, date: "2026-09-19T00:00:00Z", network: [100, 200] },
    { cpu: 30, ram: 3072, storage: 4096, date: "2026-09-19T00:01:00Z", network: [300, 400] },
  ]);

  assert.ok(lines[0].includes("30.00"), "CPU now comes from the last point");
  assert.ok(lines[4].includes("20.00") && lines[4].includes("30.00"), "CPU average and peak");
  assert.ok(lines[5].includes("2.0 KB") && lines[5].includes("3.0 KB"), "RAM average and peak");
});
