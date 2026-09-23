import assert from "node:assert/strict";
import { test } from "vitest";
import * as vscodeMock from "./vscode-mock";
import { registerAppsExtraCommands } from "../src/commands/apps-extra";
import type { CommandDeps } from "../src/commands/deps";

interface RequestCall {
  path: string;
  method?: string;
  body?: unknown;
}

const APP = {
  id: "app1",
  name: "my-app",
  description: "desc",
  main_file: "index.js",
  version: "recommended",
  start_command: null,
  build_command: null,
  ram: 512,
  github: null,
};

function makeDeps(onRequest: (call: RequestCall) => unknown): {
  deps: CommandDeps;
  calls: RequestCall[];
  wasRefreshed(): boolean;
} {
  const calls: RequestCall[] = [];
  let refreshed = false;
  const client = {
    request: async (path: string, opts?: { method?: string; body?: unknown }) => {
      const call: RequestCall = { path, method: opts?.method, body: opts?.body };
      calls.push(call);
      return onRequest(call);
    },
  };
  const deps = {
    context: { subscriptions: [] },
    client,
    refresh: async () => {
      refreshed = true;
    },
    showError: () => {},
    resolveApp: async () => ({ app: APP }),
  } as unknown as CommandDeps;
  return { deps, calls, wasRefreshed: () => refreshed };
}

async function runCommand(deps: CommandDeps, commandId: string): Promise<void> {
  registerAppsExtraCommands(deps);
  const handler = vscodeMock.registeredCommands.get(commandId);
  assert.ok(handler, `command ${commandId} not registered`);
  await handler!(undefined);
}

test("showDeploys tolerates a 403 on the webhook lookup and still lists deploys", async () => {
  const deploy = {
    app_id: "app1",
    commit_id: "abc1234567",
    message: "fix bug",
    pusher: "someone",
    branch: "main",
    created_at: "2026-09-01T10:00:00.000Z",
  };
  const { deps, calls } = makeDeps((call) => {
    if (call.path.endsWith("/deploys")) {return [deploy];}
    if (call.path.endsWith("/deploys/webhook")) {throw { code: "ACCESS_DENIED", status: 403 };}
    if (call.path === "/v1/activities") {return [];}
    return undefined;
  });
  let shownItems: Array<{ label: string; description?: string; detail?: string }> = [];
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string }>) => {
    shownItems = items;
    return undefined;
  }) as unknown as typeof vscodeMock.window.showQuickPick;

  await runCommand(deps, "vertraCloud.app.showDeploys");

  assert.ok(calls.some((c) => c.path === "/v1/apps/app1/deploys"));
  assert.ok(
    shownItems.some(
      (item: { description?: string; detail?: string }) =>
        item.description?.includes("main") || item.detail?.includes("fix bug"),
    ),
  );
});

test("editConfig sends only the changed field, ram as a number", async () => {
  const { deps, calls, wasRefreshed } = makeDeps((call) => (call.path.endsWith("/config") ? "success" : undefined));
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string; detail?: string }>) =>
    items.find((item) => item.detail === "512")) as unknown as typeof vscodeMock.window.showQuickPick;
  vscodeMock.window.showInputBox = (async () => "1024") as unknown as typeof vscodeMock.window.showInputBox;

  await runCommand(deps, "vertraCloud.app.editConfig");

  const patchCall = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patchCall?.body, { ram: 1024 });
  assert.equal(typeof (patchCall?.body as { ram: unknown }).ram, "number");
  assert.equal(wasRefreshed(), true);
});

test("editConfig sends null for an emptied nullable field", async () => {
  const appWithBuild = { ...APP, build_command: "npm run build" };
  const { deps, calls } = makeDeps((call) => (call.path.endsWith("/config") ? "success" : undefined));
  const deps2 = { ...deps, resolveApp: async () => ({ app: appWithBuild }) } as unknown as CommandDeps;
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string; detail?: string }>) =>
    items.find((item) => item.detail === "npm run build")) as unknown as typeof vscodeMock.window.showQuickPick;
  vscodeMock.window.showInputBox = (async () => "") as unknown as typeof vscodeMock.window.showInputBox;
  vscodeMock.window.showWarningMessage = (async () =>
    vscodeMock.l10n.t("Continue")) as unknown as typeof vscodeMock.window.showWarningMessage;

  await runCommand(deps2, "vertraCloud.app.editConfig");

  const patchCall = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patchCall?.body, { build_command: null });
});

test("editConfig validation blocks ram below 100 without calling the API", async () => {
  const { deps, calls } = makeDeps((call) => (call.path.endsWith("/config") ? "success" : undefined));
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string; detail?: string }>) =>
    items.find((item) => item.detail === "512")) as unknown as typeof vscodeMock.window.showQuickPick;
  vscodeMock.window.showInputBox = (async (opts?: { validateInput?: (value: string) => string | undefined }) => {
    const error = opts?.validateInput?.("50");
    assert.ok(error, "expected validation error for ram=50");
    return undefined;
  }) as unknown as typeof vscodeMock.window.showInputBox;

  await runCommand(deps, "vertraCloud.app.editConfig");

  assert.equal(calls.some((c) => c.method === "PATCH"), false);
});

test("download source writes the buffer to the chosen path", async () => {
  const buffer = new TextEncoder().encode("zip-content").buffer;
  const { deps } = makeDeps((call) => {
    if (call.path.endsWith("/deploys")) {return [];}
    if (call.path === "/v1/activities") {return [];}
    if (call.path.endsWith("/download")) {return buffer;}
    return undefined;
  });
  vscodeMock.window.showQuickPick = (async (items: Array<{ label: string; action?: string }>) =>
    items.find((item) => item.action === "download")) as unknown as typeof vscodeMock.window.showQuickPick;

  let written: Uint8Array | undefined;
  const target = vscodeMock.Uri.file("/tmp/my-app.zip");
  vscodeMock.window.showSaveDialog = (async () => target) as unknown as typeof vscodeMock.window.showSaveDialog;
  const originalWriteFile = vscodeMock.workspace.fs.writeFile;
  vscodeMock.workspace.fs.writeFile = async (_uri: unknown, content: Uint8Array) => {
    written = content;
  };

  try {
    await runCommand(deps, "vertraCloud.app.showDeploys");
  } finally {
    vscodeMock.workspace.fs.writeFile = originalWriteFile;
  }

  assert.ok(written);
  assert.equal(new TextDecoder().decode(written), "zip-content");
});
