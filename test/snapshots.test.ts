import assert from "node:assert/strict";
import { test } from "vitest";
import * as vscodeMock from "./vscode-mock";
import { registerSnapshotsCommands } from "../src/commands/snapshots";
import type { CommandDeps } from "../src/commands/deps";
import type { APIResourceSnapshot } from "@vertracloud/api-types/v1";

function fakeSnapshot(overrides?: Partial<APIResourceSnapshot>): APIResourceSnapshot {
  return {
    id: "snap1",
    resource_id: "app1",
    author_id: "user1",
    resource_type: 1,
    size: "1024",
    date: "2026-09-01T10:00:00.000Z",
    resource_name: "my-app",
    ...overrides,
  };
}

interface RequestCall {
  path: string;
  method?: string;
  query?: Record<string, unknown>;
}

function makeDeps(opts: {
  onRequest: (call: RequestCall) => unknown;
  confirmDanger?: boolean;
}): { deps: CommandDeps; calls: RequestCall[]; refreshed: boolean; polled: string[] } {
  const calls: RequestCall[] = [];
  let refreshed = false;
  const polled: string[] = [];

  const client = {
    request: async (path: string, requestOpts?: { method?: string; query?: Record<string, unknown> }) => {
      const call: RequestCall = { path, method: requestOpts?.method, query: requestOpts?.query };
      calls.push(call);
      return opts.onRequest(call);
    },
  };

  const deps = {
    context: { subscriptions: [] },
    client,
    store: {
      pollAfterMutation: async (appId: string, _expect: "up" | "down") => {
        polled.push(appId);
      },
    },
    refresh: async () => {
      refreshed = true;
    },
    showError: (_err: unknown) => {
      lastError = _err;
    },
    resolveApp: async () => ({ app: { id: "app1", name: "my-app" } }),
    resolveDatabase: async () => ({ db: { id: "db1", name: "my-db" } }),
    confirmDanger: async () => opts.confirmDanger ?? true,
  } as unknown as CommandDeps;

  return { deps, calls, get refreshed() { return refreshed; }, polled } as unknown as {
    deps: CommandDeps;
    calls: RequestCall[];
    refreshed: boolean;
    polled: string[];
  };
}

let lastError: unknown;

async function runCommand(deps: CommandDeps, commandId: string): Promise<void> {
  registerSnapshotsCommands(deps);
  const handler = vscodeMock.registeredCommands.get(commandId);
  assert.ok(handler, `command ${commandId} not registered`);
  await handler!(undefined);
}

test("list uses scope=applications for app command", async () => {
  lastError = undefined;
  const { deps, calls } = makeDeps({ onRequest: (call) => ((call.method ?? "GET") === "GET" ? [] : undefined) });
  vscodeMock.window.showQuickPick = async () => undefined;
  await runCommand(deps, "vertraCloud.app.manageSnapshots");
  const listCall = calls.find((c) => c.path === "/v1/users/app1/snapshots");
  assert.equal(listCall?.query?.scope, "applications");
});

test("list uses scope=databases for db command", async () => {
  lastError = undefined;
  const { deps, calls } = makeDeps({ onRequest: (call) => ((call.method ?? "GET") === "GET" ? [] : undefined) });
  vscodeMock.window.showQuickPick = async () => undefined;
  await runCommand(deps, "vertraCloud.db.manageSnapshots");
  const listCall = calls.find((c) => c.path === "/v1/users/db1/snapshots");
  assert.equal(listCall?.query?.scope, "databases");
});

test("choosing create issues a POST", async () => {
  lastError = undefined;
  const { deps, calls } = makeDeps({
    onRequest: (call) => ((call.method ?? "GET") === "GET" ? [] : fakeSnapshot()),
  });
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string }>) =>
    items.find((item) => item.label.includes("Create snapshot"))) as unknown as typeof vscodeMock.window.showQuickPick;
  await runCommand(deps, "vertraCloud.app.manageSnapshots");
  const createCall = calls.find((c) => c.method === "POST" && c.path === "/v1/users/app1/snapshots");
  assert.ok(createCall);
});

test("restore without confirmation never calls the restore API", async () => {
  lastError = undefined;
  const snapshot = fakeSnapshot();
  const { deps, calls } = makeDeps({
    onRequest: (call) => ((call.method ?? "GET") === "GET" ? [snapshot] : { message: "ok" }),
    confirmDanger: false,
  });
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string; snapshot?: unknown } | string>) => {
    const withSnapshot = items.find((item) => typeof item !== "string" && item.snapshot);
    if (withSnapshot) {return withSnapshot;}
    return items.find((item) => item === "Restore" || (typeof item !== "string" && item.label === "Restore"));
  }) as unknown as typeof vscodeMock.window.showQuickPick;
  await runCommand(deps, "vertraCloud.app.manageSnapshots");
  const restoreCall = calls.find((c) => c.path.includes("/restore"));
  assert.equal(restoreCall, undefined);
});

test("download writes the buffer to the chosen path", async () => {
  lastError = undefined;
  const snapshot = fakeSnapshot();
  const buffer = new TextEncoder().encode("zip-content").buffer;
  const { deps } = makeDeps({
    onRequest: (call) => {
      if ((call.method ?? "GET") === "GET" && call.path.endsWith("/snapshots")) {return [snapshot];}
      if (call.path.endsWith("/download")) {return buffer;}
      return undefined;
    },
  });
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string; snapshot?: unknown } | string>) => {
    const withSnapshot = items.find((item) => typeof item !== "string" && item.snapshot);
    if (withSnapshot) {return withSnapshot;}
    return items.find((item) => item === "Download" || (typeof item !== "string" && item.label === "Download"));
  }) as unknown as typeof vscodeMock.window.showQuickPick;

  const targetUri = vscodeMock.Uri.file("/tmp/out/my-app-2026-09-01.zip");
  vscodeMock.window.showSaveDialog = (async () => targetUri) as unknown as typeof vscodeMock.window.showSaveDialog;
  vscodeMock.workspace.workspaceFolders = undefined;
  vscodeMock.workspace.isTrusted = true;
  let written: { uri: unknown; content: Uint8Array } | undefined;
  vscodeMock.workspace.fs.writeFile = async (uri: unknown, content: Uint8Array) => {
    written = { uri, content };
  };

  await runCommand(deps, "vertraCloud.app.manageSnapshots");

  assert.ok(written);
  assert.equal(written?.uri, targetUri);
  assert.equal(Buffer.from(written!.content).toString(), "zip-content");
});

test("untrusted workspace with destination inside it refuses without writing", async () => {
  lastError = undefined;
  const snapshot = fakeSnapshot();
  const buffer = new TextEncoder().encode("zip-content").buffer;
  const { deps } = makeDeps({
    onRequest: (call) => {
      if ((call.method ?? "GET") === "GET" && call.path.endsWith("/snapshots")) {return [snapshot];}
      if (call.path.endsWith("/download")) {return buffer;}
      return undefined;
    },
  });
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string; snapshot?: unknown } | string>) => {
    const withSnapshot = items.find((item) => typeof item !== "string" && item.snapshot);
    if (withSnapshot) {return withSnapshot;}
    return items.find((item) => item === "Download" || (typeof item !== "string" && item.label === "Download"));
  }) as unknown as typeof vscodeMock.window.showQuickPick;

  const folder = { uri: vscodeMock.Uri.file("/workspace/project"), name: "project", index: 0 };
  const targetUri = vscodeMock.Uri.file("/workspace/project/my-app.zip");
  vscodeMock.window.showSaveDialog = (async () => targetUri) as unknown as typeof vscodeMock.window.showSaveDialog;
  vscodeMock.workspace.workspaceFolders = [folder];
  vscodeMock.workspace.isTrusted = false;
  let wrote = false;
  vscodeMock.workspace.fs.writeFile = async () => {
    wrote = true;
  };

  await runCommand(deps, "vertraCloud.app.manageSnapshots");

  assert.equal(wrote, false);

  vscodeMock.workspace.isTrusted = true;
  vscodeMock.workspace.workspaceFolders = undefined;
});

test("PLAN_NOT_ALLOWED from create goes to showError", async () => {
  lastError = undefined;
  const { deps, calls } = makeDeps({
    onRequest: (call) => {
      if ((call.method ?? "GET") === "GET") {return [];}
      const error = new Error("plan not allowed") as Error & { code: string };
      error.code = "PLAN_NOT_ALLOWED";
      throw error;
    },
  });
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string }>) =>
    items.find((item) => item.label.includes("Create snapshot"))) as unknown as typeof vscodeMock.window.showQuickPick;
  await runCommand(deps, "vertraCloud.app.manageSnapshots");
  assert.equal((calls.find((c) => c.method === "POST") ? true : false), true);
  assert.equal((lastError as { code?: string } | undefined)?.code, "PLAN_NOT_ALLOWED");
});
