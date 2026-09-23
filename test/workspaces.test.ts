import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as vscode from "vscode";
import { registeredCommands } from "./vscode-mock";
import { inviteTokenFrom, registerWorkspacesCommands } from "../src/commands/workspaces";
import type { CommandDeps } from "../src/commands/deps";
import type { APIWorkspace } from "@vertracloud/api-types/v1";

type Call = { path: string; opts?: Record<string, unknown> };

function fakeDeps(
  handler: (path: string, opts?: Record<string, unknown>) => unknown,
  overrides: Partial<CommandDeps> = {},
): { deps: CommandDeps; calls: Call[]; errors: unknown[] } {
  const calls: Call[] = [];
  const errors: unknown[] = [];
  const deps = {
    client: {
      request: async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ path, opts });
        return handler(path, opts);
      },
    },
    store: { workspaces: [], apps: [], databases: [] },
    refresh: async () => {},
    showError: (err: unknown) => {
      errors.push(err);
    },
    pickApp: async () => undefined,
    pickDatabase: async () => undefined,
    context: { subscriptions: [] },
    ...overrides,
  } as unknown as CommandDeps;
  return { deps, calls, errors };
}

async function runCommand(id: string, arg?: unknown): Promise<void> {
  const callback = registeredCommands.get(id);
  assert.ok(callback);
  await callback!(arg);
}

const WORKSPACE: APIWorkspace = {
  id: "w1",
  name: "Team",
  description: null,
} as APIWorkspace;

describe("workspaces commands", () => {
  beforeEach(() => {
    registeredCommands.clear();
  });

  afterEach(() => {
    (vscode.window as Record<string, unknown>).showQuickPick = async () => undefined;
    (vscode.window as Record<string, unknown>).showInputBox = async () => undefined;
    (vscode.window as Record<string, unknown>).showInformationMessage = async () => undefined;
    (vscode.window as Record<string, unknown>).showWarningMessage = async () => undefined;
  });

  it("workspace.create sends the correct body", async () => {
    const inputs = ["Team", "A team workspace"];
    (vscode.window as Record<string, unknown>).showInputBox = async () => inputs.shift();
    const { deps, calls } = fakeDeps(() => WORKSPACE);
    let refreshed = 0;
    (deps as { refresh: () => Promise<void> }).refresh = async () => {
      refreshed++;
    };

    registerWorkspacesCommands(deps);
    await runCommand("vertraCloud.workspace.create");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/v1/workspaces");
    assert.equal(calls[0].opts?.method, "POST");
    assert.deepEqual(calls[0].opts?.body, { name: "Team", description: "A team workspace" });
    assert.equal(refreshed, 1);
  });

  it("a 403 PLAN_RESTRICTED_FEATURE error goes to showError without throwing", async () => {
    const inputs = ["Team", ""];
    (vscode.window as Record<string, unknown>).showInputBox = async () => inputs.shift();
    const { deps, errors } = fakeDeps(() => {
      throw { code: "PLAN_RESTRICTED_FEATURE", message: "nope" };
    });

    registerWorkspacesCommands(deps);
    await assert.doesNotReject(() => runCommand("vertraCloud.workspace.create"));

    assert.equal(errors.length, 1);
    assert.equal((errors[0] as { code: string }).code, "PLAN_RESTRICTED_FEATURE");
  });

  it("workspace.edit sends only the changed field", async () => {
    (vscode.window as Record<string, unknown>).showQuickPick = async (
      items: Array<{ field: string }>,
    ) => items.find((i) => i.field === "description");
    (vscode.window as Record<string, unknown>).showInputBox = async () => "New description";

    const { deps, calls } = fakeDeps(() => WORKSPACE, {
      store: { workspaces: [WORKSPACE], apps: [], databases: [] } as unknown as CommandDeps["store"],
    });

    registerWorkspacesCommands(deps);
    await runCommand("vertraCloud.workspace.edit", WORKSPACE);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/v1/workspaces/w1");
    assert.equal(calls[0].opts?.method, "PUT");
    assert.deepEqual(calls[0].opts?.body, { description: "New description" });
  });

  it("workspace.linkApp uses the workspace id and the picked app id", async () => {
    const { deps, calls } = fakeDeps(() => WORKSPACE, {
      store: { workspaces: [WORKSPACE], apps: [], databases: [] } as unknown as CommandDeps["store"],
      pickApp: async () => ({ app: { id: "a1", name: "App" } }) as never,
    });

    registerWorkspacesCommands(deps);
    await runCommand("vertraCloud.workspace.linkApp", WORKSPACE);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/v1/workspaces/w1/apps/a1");
    assert.equal(calls[0].opts?.method, "POST");
  });

  it("workspace.linkDatabase uses the workspace id and the picked database id", async () => {
    const { deps, calls } = fakeDeps(() => WORKSPACE, {
      store: { workspaces: [WORKSPACE], apps: [], databases: [] } as unknown as CommandDeps["store"],
      pickDatabase: async () => ({ db: { id: "d1", name: "Db" } }) as never,
    });

    registerWorkspacesCommands(deps);
    await runCommand("vertraCloud.workspace.linkDatabase", WORKSPACE);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/v1/workspaces/w1/databases/d1");
    assert.equal(calls[0].opts?.method, "POST");
  });
  it("workspace.delete only calls DELETE after the typed confirmation", async () => {
    const { deps, calls } = fakeDeps(() => undefined, {
      store: { workspaces: [WORKSPACE], apps: [], databases: [] } as unknown as CommandDeps["store"],
      confirmDanger: async () => false,
    });
    registerWorkspacesCommands(deps);
    await runCommand("vertraCloud.workspace.delete", WORKSPACE);
    assert.equal(calls.length, 0);

    deps.confirmDanger = async () => true;
    await runCommand("vertraCloud.workspace.delete", WORKSPACE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/v1/workspaces/w1");
    assert.equal(calls[0].opts?.method, "DELETE");
  });

  it("workspace.manageInvites revokes the picked pending invite", async () => {
    const invites = [
      { id: "i1", email: "a@x.com", role_name: "Dev", expires_at: "2026-10-01T00:00:00Z", accepted_at: null, revoked_at: null },
      { id: "i2", email: null, role_name: "Dev", expires_at: "2026-10-01T00:00:00Z", accepted_at: "2026-09-01T00:00:00Z", revoked_at: null },
    ];
    let offered: unknown[] = [];
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: unknown[]) => {
      offered = items;
      return items[0];
    };
    (vscode.window as Record<string, unknown>).showWarningMessage = async (_m: string, _o: unknown, confirm: string) => confirm;
    const { deps, calls } = fakeDeps((path) => (path.endsWith("/invites") ? invites : undefined), {
      store: { workspaces: [WORKSPACE], apps: [], databases: [] } as unknown as CommandDeps["store"],
    });
    registerWorkspacesCommands(deps);
    await runCommand("vertraCloud.workspace.manageInvites", WORKSPACE);

    assert.equal(offered.length, 1);
    assert.equal(calls[0].path, "/v1/workspaces/w1/invites");
    assert.equal(calls[1].path, "/v1/workspaces/w1/invites/i1");
    assert.equal(calls[1].opts?.method, "DELETE");
  });

  it("inviteTokenFrom accepts a raw token or the invite URL", () => {
    assert.equal(inviteTokenFrom(" abc123 "), "abc123");
    assert.equal(inviteTokenFrom("https://vertracloud.app/pt-br/invite/abc123?x=1"), "abc123");
    assert.equal(inviteTokenFrom("https://vertracloud.app/en-us/invite/abc123/"), "abc123");
  });

  it("workspace.openInvite previews then accepts or declines by token", async () => {
    const preview = { workspace: { id: "w2", name: "Other" }, inviter: { display_name: "Ana" }, role_name: "Dev", kind: "link", expires_at: "2026-10-01T00:00:00Z" };
    for (const [button, suffix] of [["Accept", "/accept"], ["Decline", "/decline"]] as const) {
      (vscode.window as Record<string, unknown>).showInputBox = async () => "https://vertracloud.app/pt-br/invite/tok1";
      (vscode.window as Record<string, unknown>).showInformationMessage = async () => button;
      const { deps, calls } = fakeDeps((path) => (path === "/v1/workspaces/invites/tok1" ? preview : WORKSPACE));
      registerWorkspacesCommands(deps);
      await runCommand("vertraCloud.workspace.openInvite");

      assert.equal(calls.length, 2);
      assert.equal(calls[0].path, "/v1/workspaces/invites/tok1");
      assert.equal(calls[1].path, `/v1/workspaces/invites/tok1${suffix}`);
      assert.equal(calls[1].opts?.method, "POST");
    }
  });

  it("workspace.actionRequests sends the picked status filter", async () => {
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ status?: string }>) =>
      items.find((i) => i.status === "pending");
    const { deps, calls } = fakeDeps(() => [], {
      store: { workspaces: [WORKSPACE], apps: [], databases: [] } as unknown as CommandDeps["store"],
    });
    registerWorkspacesCommands(deps);
    await runCommand("vertraCloud.workspace.actionRequests", WORKSPACE);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/v1/workspaces/w1/action-requests");
    assert.deepEqual(calls[0].opts?.query, { status: "pending" });
  });

  it("workspace.requestAction sends snapshot_restore with the picked snapshot id", async () => {
    const workspace = { ...WORKSPACE, applications: [{ id: "a1", name: "App" }], databases: [] };
    (vscode.window as Record<string, unknown>).showQuickPick = async (items: Array<{ action?: string }>) =>
      items.find((i) => i.action === "snapshot_restore") ?? items[0];
    const { deps, calls } = fakeDeps((path) => (path.includes("/snapshots") ? [{ id: "s1", date: "2026-09-01T00:00:00Z" }] : {}), {
      store: { workspaces: [workspace], apps: [], databases: [] } as unknown as CommandDeps["store"],
    });
    registerWorkspacesCommands(deps);
    await runCommand("vertraCloud.workspace.requestAction", workspace);

    const create = calls[calls.length - 1];
    assert.equal(create.path, "/v1/workspaces/w1/action-requests");
    assert.equal(create.opts?.method, "POST");
    assert.deepEqual(create.opts?.body, { action: "snapshot_restore", resource_id: "a1", params: { snapshot_id: "s1" } });
  });
});
