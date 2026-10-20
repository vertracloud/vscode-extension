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

function domain(id: string, hostname: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    hostname,
    apex: false,
    companion_of: null,
    redirect_to: null,
    redirect_status: 308,
    path_prefix: null,
    port: 80,
    status: "active",
    ssl_status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
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
      if (path === "/v1/apps/app-1/network/publish") {return { subdomain: "random-x", domains: [], type: 2 };}
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
    const { deps, calls } = fakeDeps(() => ({ subdomain: null, domains: [], type: 2 }));
    (vscode.window as Record<string, unknown>).showWarningMessage = async () => undefined;

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.unpublish");

    assert.equal(calls.length, 0);
  });

  it("unpublish warns that custom domains are removed when the app has any", async () => {
    const { deps, calls } = fakeDeps(() => ({}));
    const entry = await deps.resolveApp(undefined);
    (entry!.app as unknown as Record<string, unknown>).domains = [domain("d1", "my-app.com.br")];
    const messages: string[] = [];
    (vscode.window as Record<string, unknown>).showWarningMessage = async (msg: string) => {
      messages.push(msg);
      return undefined;
    };

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.unpublish");

    assert.equal(calls.length, 0);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /custom domains/i);
    assert.match(messages[0], /DNS/);
  });

  it("unpublish keeps the plain message when the app has no custom domains", async () => {
    const { deps } = fakeDeps(() => ({}));
    const messages: string[] = [];
    (vscode.window as Record<string, unknown>).showWarningMessage = async (msg: string) => {
      messages.push(msg);
      return undefined;
    };

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.unpublish");

    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0], /custom domains/i);
  });

  it("unpublish calls DELETE after confirmation is accepted", async () => {
    const { deps, calls } = fakeDeps(() => ({ subdomain: null, domains: [], type: 2 }));
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

  it("publish reports the platform subdomain", async () => {
    const { deps } = fakeDeps(() => ({ subdomain: "x.vertracloud.app", domains: [], type: 2 }));
    (vscode.window as Record<string, unknown>).showInputBox = async () => "";
    const shown: string[] = [];
    (vscode.window as Record<string, unknown>).showInformationMessage = async (msg: string) => {
      shown.push(msg);
      return undefined;
    };

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.publish");

    assert.ok(shown.some((m) => m.includes("https://x.vertracloud.app")));
  });

  it("showDns picks a domain and lists its DNS records", async () => {
    const records = [{ type: "CNAME", name: "app.example.com", value: "edge.vertracloud.app", status: "active" }];
    const { deps, calls } = fakeDeps((path) => {
      if (path === "/v1/apps/app-1/domains") {return [domain("d1", "app.example.com")];}
      if (path === "/v1/apps/app-1/domains/d1/dns") {return records;}
      throw new Error(`unexpected ${path}`);
    });
    const seen: Array<Array<{ label: string; detail?: string }>> = [];
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ label: string; detail?: string }>) => {
      seen.push(items);
      return seen.length === 1 ? items[0] : undefined;
    };

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.showDns");

    assert.ok(calls.some((c) => c.path === "/v1/apps/app-1/domains/d1/dns"));
    assert.ok(seen[1].some((item) => item.label.includes("CNAME") && item.detail === "edge.vertracloud.app"));
  });

  it("showDns with no domains never asks for the DNS records", async () => {
    const { deps, calls } = fakeDeps(() => []);

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.showDns");

    assert.deepEqual(calls.map((c) => c.path), ["/v1/apps/app-1/domains"]);
  });

  it("addDomain posts hostname, www and the optional port and prefix", async () => {
    const created = [domain("d1", "example.com"), domain("d2", "www.example.com", { companion_of: "d1" })];
    const { deps, calls } = fakeDeps((path, opts) => {
      if (path === "/v1/apps/app-1/domains" && opts?.method === "POST") {return created;}
      if (path === "/v1/apps/app-1/domains/d1/dns") {return [];}
      throw new Error(`unexpected ${path}`);
    });
    const answers = ["example.com", "8080", "/api"];
    (vscode.window as Record<string, unknown>).showInputBox = async () => answers.shift();
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ label: string; value?: boolean }>) =>
      items.find((i) => i.value === true);

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.addDomain");

    const post = calls.find((c) => c.opts?.method === "POST");
    assert.deepEqual(post!.opts?.body, { hostname: "example.com", www: true, port: 8080, path_prefix: "/api" });
  });

  it("addDomain omits empty port and prefix and sends www false", async () => {
    const { deps, calls } = fakeDeps((path, opts) => {
      if (opts?.method === "POST") {return [domain("d1", "example.com")];}
      return [];
    });
    const answers = ["example.com", "", ""];
    (vscode.window as Record<string, unknown>).showInputBox = async () => answers.shift();
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ label: string; value?: boolean }>) =>
      items.find((i) => i.value === false);

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.addDomain");

    const post = calls.find((c) => c.opts?.method === "POST");
    assert.deepEqual(post!.opts?.body, { hostname: "example.com", www: false });
  });

  it("addDomain validates port and prefix", async () => {
    const { deps } = fakeDeps(() => []);
    type Validator = (v: string) => string | undefined;
    const validators: Validator[] = [];
    const answers = ["example.com", "", ""];
    (vscode.window as Record<string, unknown>).showInputBox = async (opts: { validateInput: Validator }) => {
      validators.push(opts.validateInput);
      return answers.shift();
    };
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ value?: boolean }>) => items[0];

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.addDomain");

    const [, port, prefix] = validators;
    assert.equal(port(""), undefined);
    assert.equal(port("8080"), undefined);
    assert.ok(port("0"));
    assert.ok(port("70000"));
    assert.ok(port("abc"));
    assert.equal(prefix(""), undefined);
    assert.equal(prefix("/api"), undefined);
    assert.ok(prefix("api"));
    assert.ok(prefix("/api/"));
    assert.equal(prefix("/api/v1"), undefined);
    assert.equal(prefix("/a.b_c~d-e"), undefined);
    for (const bad of ["/", "/a b", "/a//b", "/a/./b", "/a/../b", "/..", "/.", "/a?x", "/ação", `/${"a".repeat(128)}`]) {
      assert.ok(prefix(bad), bad);
    }
    assert.equal(prefix(`/${"a".repeat(127)}`), undefined);
  });

  it("removeDomain deletes the chosen domain after confirmation", async () => {
    const { deps, calls } = fakeDeps((path, opts) => {
      if (opts?.method === "DELETE") {return null;}
      return [domain("d1", "a.example.com"), domain("d2", "b.example.com")];
    });
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ label: string }>) => items[1];
    (vscode.window as Record<string, unknown>).showWarningMessage = async (_m: string, _o: unknown, label: string) => label;

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.removeDomain");

    assert.ok(calls.some((c) => c.path === "/v1/apps/app-1/domains/d2" && c.opts?.method === "DELETE"));
  });

  it("removeDomain mentions the companion only when the target is not one", async () => {
    const messages: string[] = [];
    (vscode.window as Record<string, unknown>).showWarningMessage = async (message: string) => {
      messages.push(message);
      return undefined;
    };
    const list = [domain("d1", "example.com"), domain("d2", "www.example.com", { companion_of: "d1" })];

    for (const index of [0, 1]) {
      const { deps } = fakeDeps(() => list);
      (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ label: string }>) => items[index];
      registerNetworkCommands(deps);
      await runCommand("vertraCloud.app.removeDomain");
    }

    assert.equal(messages.length, 2);
    assert.match(messages[0], /companion is removed too/);
    assert.doesNotMatch(messages[1], /companion/);
  });

  it("removeDomain does nothing without confirmation", async () => {
    const { deps, calls } = fakeDeps(() => [domain("d1", "a.example.com")]);
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ label: string }>) => items[0];
    (vscode.window as Record<string, unknown>).showWarningMessage = async () => undefined;

    registerNetworkCommands(deps);
    await runCommand("vertraCloud.app.removeDomain");

    assert.ok(!calls.some((c) => c.opts?.method === "DELETE"));
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
