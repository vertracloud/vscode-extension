import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as vscode from "vscode";
import { registeredCommands } from "./vscode-mock";
import { registerNetworkCommands } from "../src/commands/network";
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
    refresh: async () => {},
    context: { subscriptions: [] },
  } as unknown as CommandDeps;
  return { deps, calls, errors };
}

function runCommand(id: string, arg?: unknown): Promise<void> {
  const callback = registeredCommands.get(id);
  assert.ok(callback, `command ${id} not registered`);
  return Promise.resolve(callback!(arg)) as Promise<void>;
}

describe("network commands", () => {
  beforeEach(() => {
    registeredCommands.clear();
  });

  afterEach(() => {
    (vscode.window as Record<string, unknown>).showQuickPick = async () => undefined;
    (vscode.window as Record<string, unknown>).showInputBox = async () => undefined;
    (vscode.window as Record<string, unknown>).showInformationMessage = async () => undefined;
    (vscode.window as Record<string, unknown>).showWarningMessage = async () => undefined;
  });

  it("publish without a subdomain sends a body without the field", async () => {
    const { deps, calls } = fakeDeps((path) => {
      if (path === "/v1/apps/app-1/network/publish") {return { subdomain: "random-x", custom_domain: null, type: 2 };}
      throw new Error(`unexpected ${path}`);
    });
    (vscode.window as Record<string, unknown>).showInputBox = async () => "";

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.publish");

    const post = calls.find((c) => c.path === "/v1/apps/app-1/network/publish" && c.opts?.method === "POST");
    assert.ok(post);
    assert.deepEqual(post!.opts?.body, {});
  });

  it("publish with an invalid subdomain never calls the API", async () => {
    const { deps, calls } = fakeDeps(() => {
      throw new Error("should not be called");
    });
    (vscode.window as Record<string, unknown>).showInputBox = async (opts: { validateInput?: (v: string) => string | undefined }) => {
      const invalid = "Not Valid!";
      if (opts.validateInput?.(invalid)) {return undefined;}
      return undefined;
    };

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.publish");

    assert.equal(calls.length, 0);
  });

  it("unpublish only calls the API after confirmation", async () => {
    const { deps, calls } = fakeDeps(() => ({ subdomain: null, custom_domain: null, type: 2 }));
    (vscode.window as Record<string, unknown>).showWarningMessage = async () => undefined;

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.unpublish");

    assert.equal(calls.length, 0);
  });

  it("unpublish calls DELETE after confirmation is accepted", async () => {
    const { deps, calls } = fakeDeps(() => ({ subdomain: null, custom_domain: null, type: 2 }));
    (vscode.window as Record<string, unknown>).showWarningMessage = async (
      _msg: string,
      _opts: unknown,
      confirmLabel: string,
    ) => confirmLabel;

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.unpublish");

    const del = calls.find((c) => c.path === "/v1/apps/app-1/network/publish" && c.opts?.method === "DELETE");
    assert.ok(del);
  });

  it("setSubdomain sends the correct PATCH", async () => {
    const { deps, calls } = fakeDeps(() => ({ subdomain: "new-name" }));
    (vscode.window as Record<string, unknown>).showInputBox = async () => "new-name";

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.setSubdomain");

    const patch = calls.find((c) => c.path === "/v1/apps/app-1/network/subdomain" && c.opts?.method === "PATCH");
    assert.ok(patch);
    assert.deepEqual(patch!.opts?.body, { subdomain: "new-name" });
  });

  it("showDns lists the DNS records", async () => {
    const records = [{ type: "CNAME", name: "app.example.com", value: "edge.vertracloud.app", status: "active" }];
    const { deps } = fakeDeps((path) => {
      if (path === "/v1/apps/app-1/network/dns") {return records;}
      if (path === "/v1/apps/app-1/network/custom") {throw Object.assign(new Error("no domain"), { code: "NO_CUSTOM_DOMAIN" });}
      throw new Error(`unexpected ${path}`);
    });
    let seenItems: Array<{ label: string; detail?: string }> = [];
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: typeof seenItems) => {
      seenItems = items;
      return undefined;
    };

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.showDns");

    assert.ok(seenItems.some((item) => item.label.includes("CNAME") && item.detail === "edge.vertracloud.app"));
  });

  it("purgeCache sends an empty body after confirmation", async () => {
    const { deps, calls } = fakeDeps(() => ({}));
    (vscode.window as Record<string, unknown>).showWarningMessage = async (
      _msg: string,
      _opts: unknown,
      confirmLabel: string,
    ) => confirmLabel;

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.purgeCache");

    const post = calls.find((c) => c.path === "/v1/apps/app-1/network/purge-cache" && c.opts?.method === "POST");
    assert.ok(post);
    assert.deepEqual(post!.opts?.body, {});
  });

  it("PLAN_DOES_NOT_SUPPORT_WEB_PUBLISH goes to showError", async () => {
    const { deps, errors } = fakeDeps(() => {
      const err = new Error("forbidden") as Error & { code: string };
      err.code = "PLAN_DOES_NOT_SUPPORT_WEB_PUBLISH";
      throw err;
    });
    (vscode.window as Record<string, unknown>).showInputBox = async () => "";

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.publish");

    assert.equal(errors.length, 1);
    assert.equal((errors[0] as { code: string }).code, "PLAN_DOES_NOT_SUPPORT_WEB_PUBLISH");
  });
});
