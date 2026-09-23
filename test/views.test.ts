import assert from "node:assert/strict";
import { test } from "vitest";
import * as vscode from "vscode";
import { FakeMemento, EventEmitter } from "./vscode-mock";
import { Store, type SessionLike, type SessionStateLike, type StoreApi } from "../src/state";
import { ApplicationsProvider } from "../src/views/applications";
import { DatabasesProvider } from "../src/views/databases";
import { ProjectProvider } from "../src/views/project";
import type { APIUserInfoResponse, APIApplicationStatusShort, APIDatabaseStatusShort, APIWorkspace, APIStatus, APIWorkspaceResourceOrganization } from "@vertracloud/api-types/v1";

function fakeUser(): APIUserInfoResponse {
  return {
    id: "1",
    name: "Ana",
    email: "ana@example.com",
    plan_id: 1,
    language: "pt-br",
    workspace_invites_enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    plan: { id: 1, name: "Free", expires_at: null, duration: 0, memory: { limit: 512, used: 128 } },
    applications: [
      {
        id: "app1",
        cluster: 1,
        type: 2,
        name: "my-app",
        owner_id: "1",
        owner_plan_id: 1,
        language: "javascript",
        ram: 256,
        status: "up",
        subdomain: "my-app",
        public_url: "https://my-app.vertraweb.app",
        custom_domain: null,
        last_snapshot: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        main_file: "index.js",
        version: "recommended",
        auto_restart: true,
        start_command: null,
        build_command: null,
        offline_since: null,
        shield_cooldown: null,
      },
      {
        id: "app2",
        cluster: 1,
        type: 2,
        name: "secret-app",
        owner_id: "1",
        owner_plan_id: 1,
        language: "python",
        ram: 256,
        status: "down",
        subdomain: null,
        public_url: null,
        custom_domain: null,
        last_snapshot: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        main_file: "main.py",
        version: "recommended",
        auto_restart: true,
        start_command: "super-secret-token=abc123",
        build_command: null,
        offline_since: null,
        shield_cooldown: null,
      },
    ] as unknown as APIUserInfoResponse["applications"],
    databases: [] as unknown as APIUserInfoResponse["databases"],
    connections: [],
    resource_organization: { scope: "personal", user_id: "1", workspace_id: null, folders: [], favorites: [] },
  };
}

class FakeSession implements SessionLike {
  private emitter = new EventEmitter<SessionStateLike>();
  state: SessionStateLike = { status: "disconnected" };
  get onDidChange() {
    return this.emitter.event;
  }
  setState(state: SessionStateLike): void {
    this.state = state;
    this.emitter.fire(state);
  }
}

function fakeApi(): StoreApi {
  return {
    async getMe() {
      return fakeUser();
    },
    async getAppsStatus() {
      return [{ id: "app1", cpu: "1%", ram: "10MB", running: true, uptime: 60 }] as APIApplicationStatusShort[];
    },
    async getDatabasesStatus() {
      return [] as APIDatabaseStatusShort[];
    },
    async getWorkspaces() {
      return [] as APIWorkspace[];
    },
    async getServiceStatus() {
      return { status: "healthy", message: "" } as APIStatus;
    },
    async setFavorite(_scope, resource, favorite) {
      return {
        scope: "personal",
        user_id: "1",
        workspace_id: null,
        folders: [],
        favorites: favorite ? [{ ...resource, position: 0, created_at: "2026-01-01T00:00:00.000Z" }] : [],
      } as APIWorkspaceResourceOrganization;
    },
  };
}

test("disconnected store yields no application children", () => {
  const session = new FakeSession();
  const store = new Store(session, fakeApi(), new FakeMemento());
  const provider = new ApplicationsProvider(store);
  assert.deepEqual(provider.getChildren(), []);
  store.dispose();
});

test("disconnected store hides the linked project so the welcome actions can show", () => {
  const session = new FakeSession();
  const store = new Store(session, fakeApi(), new FakeMemento());
  const links = {
    links: [{
      folder: { index: 0, name: "next-build", uri: vscode.Uri.file("/tmp/next-build") },
      appId: "app1",
      source: "workspaceState" as const,
    }],
    onDidChange: new EventEmitter<void>().event,
  };
  const provider = new ProjectProvider(store, links);

  assert.deepEqual(provider.getChildren(), []);
  session.setState({ status: "connected", user: fakeUser() });
  assert.equal(provider.getChildren().length, 1);
  store.dispose();
});

test("empty databases yield no children", () => {
  const session = new FakeSession();
  const store = new Store(session, fakeApi(), new FakeMemento());
  const provider = new DatabasesProvider(store);
  assert.deepEqual(provider.getChildren(), []);
  store.dispose();
});

test("Favorites group only appears when there is a favorite", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const store = new Store(session, fakeApi(), new FakeMemento());
  const provider = new ApplicationsProvider(store);
  await store.refresh();

  const groupsBefore = provider.getChildren().filter((n) => (n as { kind?: string }).kind === "group");
  assert.equal(groupsBefore.length, 0);

  await store.toggleFavorite("application", "app1");
  const groupsAfter = provider.getChildren().filter((n) => (n as { kind?: string }).kind === "group");
  assert.equal(groupsAfter.length, 1);
  store.dispose();
});

test("there is no All group; apps sit directly at the root", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const store = new Store(session, fakeApi(), new FakeMemento());
  const provider = new ApplicationsProvider(store);
  await store.refresh();

  const roots = provider.getChildren();
  assert.equal(roots.some((n) => (n as { label?: string }).label === "All"), false);
  assert.deepEqual(roots, [
    { kind: "app", appId: "app1" },
    { kind: "app", appId: "app2" },
  ]);
  store.dispose();
});

test("favorites appear in their own group, ahead of the rest", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const store = new Store(session, fakeApi(), new FakeMemento());
  const provider = new ApplicationsProvider(store);
  await store.refresh();
  await store.toggleFavorite("application", "app2");

  const roots = provider.getChildren();
  assert.deepEqual(roots[0], { kind: "group", group: "favorites" });
  const favoriteChildren = provider.getChildren(roots[0]);
  assert.deepEqual(favoriteChildren, [{ kind: "app", appId: "app2" }]);
  assert.deepEqual(roots.slice(1), [{ kind: "app", appId: "app1" }]);
  store.dispose();
});

test("contextValue and icon reflect app status", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const store = new Store(session, fakeApi(), new FakeMemento());
  const provider = new ApplicationsProvider(store);
  await store.refresh();

  const roots = provider.getChildren();
  const upItem = provider.getTreeItem(roots[0]) as { contextValue?: string; iconPath?: { id: string; color?: { id: string } } };
  assert.equal(upItem.contextValue, "app:up:published");
  assert.equal(upItem.iconPath?.color?.id, "charts.green");

  const downItem = provider.getTreeItem(roots[1]) as { contextValue?: string; iconPath?: { id: string; color?: { id: string } } };
  assert.equal(downItem.contextValue, "app:down");
  assert.equal(downItem.iconPath?.color?.id, "charts.red");
  store.dispose();
});

test("app is expandable with information rows (status, ram, uptime, domain, id)", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const store = new Store(session, fakeApi(), new FakeMemento());
  const provider = new ApplicationsProvider(store);
  await store.refresh();

  const roots = provider.getChildren();
  const infoRows = provider.getChildren(roots[0]) as Array<{ field: string }>;
  assert.deepEqual(infoRows.map((r) => r.field), ["status", "ram", "cpu", "uptime", "domain", "id"]);
  store.dispose();
});

test("app tooltip never leaks the start command or any secret-shaped value", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const store = new Store(session, fakeApi(), new FakeMemento());
  const provider = new ApplicationsProvider(store);
  await store.refresh();

  const roots = provider.getChildren();
  for (const child of roots) {
    const item = provider.getTreeItem(child) as { tooltip?: { value: string } };
    assert.equal(item.tooltip?.value.includes("super-secret-token"), false);
  }
  store.dispose();
});
