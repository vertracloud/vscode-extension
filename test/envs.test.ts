import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as vscode from "vscode";
import { registeredCommands } from "./vscode-mock";
import { registerEnvsCommands } from "../src/commands/envs";
import type { CommandDeps } from "../src/commands/deps";
import type { AppEntry } from "../src/state";

type Call = { path: string; opts?: Record<string, unknown> };

function fakeDeps(handler: (path: string, opts?: Record<string, unknown>) => unknown): {
  deps: CommandDeps;
  calls: Call[];
  errors: unknown[];
} {
  const calls: Call[] = [];
  const errors: unknown[] = [];
  const entry: AppEntry = {
    app: { id: "app-1", name: "My App" } as AppEntry["app"],
    favorite: false,
  };
  const deps = {
    client: {
      request: async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ path, opts });
        return handler(path, opts);
      },
    },
    resolveApp: async () => entry,
    showError: (err: unknown) => {
      errors.push(err);
    },
    confirmDanger: async () => true,
    context: { subscriptions: [] },
  } as unknown as CommandDeps;
  return { deps, calls, errors };
}

const ENVS = [{ id: "e1", key: "SECRET", value: "super-secret-value", note: "a note", created_at: "2026-01-01" }];

async function runCommand(arg?: unknown): Promise<void> {
  const callback = registeredCommands.get("vertraCloud.app.manageEnvs");
  assert.ok(callback);
  await callback!(arg);
}

describe("envs commands", () => {
  beforeEach(() => {
    registeredCommands.clear();
  });

  afterEach(() => {
    (vscode.window as Record<string, unknown>).showQuickPick = async () => undefined;
    (vscode.window as Record<string, unknown>).showInputBox = async () => undefined;
    (vscode.window as Record<string, unknown>).showInformationMessage = async () => undefined;
  });

  it("lists envs from the right route and never exposes the real value in a QuickPick item", async () => {
    const { deps, calls } = fakeDeps((path) => {
      if (path === "/v1/apps/app-1/envs") {return ENVS;}
      throw new Error(`unexpected ${path}`);
    });
    let seenItems: unknown[] = [];
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: unknown[]) => {
      seenItems = items;
      return undefined;
    };

    registerEnvsCommands(deps);
    await runCommand();

    assert.equal(calls[0]?.path, "/v1/apps/app-1/envs");
    const serialized = JSON.stringify(seenItems);
    assert.ok(!serialized.includes("super-secret-value"));
  });

  it("add posts the correct upsert body", async () => {
    const { deps, calls } = fakeDeps((path) => {
      if (path === "/v1/apps/app-1/envs") {return [];}
      throw new Error(`unexpected ${path}`);
    });
    let pickCount = 0;
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ action: string }>) => {
      pickCount++;
      if (pickCount === 1) {return items.find((i) => i.action === "add");}
      return undefined;
    };
    let inputCount = 0;
    (vscode.window as Record<string, unknown>).showInputBox = async () => {
      inputCount++;
      return inputCount === 1 ? "MY_KEY" : "my-value";
    };

    registerEnvsCommands(deps);
    await runCommand();

    const post = calls.find((c) => c.path === "/v1/apps/app-1/envs" && c.opts?.method === "POST");
    assert.ok(post);
    assert.deepEqual(post!.opts?.body, { key: "MY_KEY", value: "my-value" });
  });

  it("edit value upserts by key, preserving the existing note", async () => {
    const { deps, calls } = fakeDeps((path) => {
      if (path === "/v1/apps/app-1/envs") {return ENVS;}
      throw new Error(`unexpected ${path}`);
    });
    let pickCount = 0;
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ action?: string; env?: unknown }>) => {
      pickCount++;
      if (pickCount === 1) {return items.find((i) => i.action === "select");}
      if (pickCount === 2) {return items.find((i) => i.action === "editValue");}
      return undefined;
    };
    (vscode.window as Record<string, unknown>).showInputBox = async () => "new-value";

    registerEnvsCommands(deps);
    await runCommand();

    const post = calls.find((c) => c.path === "/v1/apps/app-1/envs" && c.opts?.method === "POST");
    assert.ok(post);
    assert.deepEqual(post!.opts?.body, { key: "SECRET", value: "new-value", note: "a note" });
  });

  it("delete only calls the API after confirmation", async () => {
    let confirmed = false;
    const { deps, calls } = fakeDeps((path) => {
      if (path === "/v1/apps/app-1/envs") {return ENVS;}
      return undefined;
    });
    (deps as unknown as { confirmDanger: () => Promise<boolean> }).confirmDanger = async () => {
      confirmed = true;
      return false;
    };
    let pickCount = 0;
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ action?: string }>) => {
      pickCount++;
      if (pickCount === 1) {return items.find((i) => i.action === "select");}
      if (pickCount === 2) {return items.find((i) => i.action === "delete");}
      return undefined;
    };

    registerEnvsCommands(deps);
    await runCommand();

    assert.ok(confirmed);
    const del = calls.find((c) => c.opts?.method === "DELETE");
    assert.equal(del, undefined);
  });

  it("deletes after confirmation is accepted", async () => {
    const { deps, calls } = fakeDeps((path) => {
      if (path === "/v1/apps/app-1/envs") {return ENVS;}
      return undefined;
    });
    let pickCount = 0;
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ action?: string }>) => {
      pickCount++;
      if (pickCount === 1) {return items.find((i) => i.action === "select");}
      if (pickCount === 2) {return items.find((i) => i.action === "delete");}
      return undefined;
    };

    registerEnvsCommands(deps);
    await runCommand();

    const del = calls.find((c) => c.path === "/v1/apps/app-1/envs/e1" && c.opts?.method === "DELETE");
    assert.ok(del);
  });

  it("calls showError without throwing on API_KEY_SCOPE_DENIED", async () => {
    const { deps, errors } = fakeDeps(() => {
      const err = new Error("forbidden") as Error & { code: string };
      err.code = "API_KEY_SCOPE_DENIED";
      throw err;
    });

    registerEnvsCommands(deps);
    await assert.doesNotReject(runCommand());

    assert.equal(errors.length, 1);
    assert.equal((errors[0] as { code: string }).code, "API_KEY_SCOPE_DENIED");
  });
});
