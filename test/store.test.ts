import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { FakeMemento, EventEmitter } from "./vscode-mock";
import { Store, type SessionLike, type SessionStateLike, type StoreApi } from "../src/state";
import type { APIUserInfoResponse, APIApplicationStatusShort, APIDatabaseStatusShort, APIWorkspace, APIStatus, APIWorkspaceResourceOrganization } from "@vertracloud/api-types/v1";

function fakeUser(overrides?: Partial<APIUserInfoResponse>): APIUserInfoResponse {
  return {
    id: "1",
    name: "Ana",
    email: "ana@example.com",
    plan_id: 1,
    language: "pt-BR",
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
    ] as unknown as APIUserInfoResponse["applications"],
    databases: [] as unknown as APIUserInfoResponse["databases"],
    connections: [],
    resource_organization: { scope: "personal", user_id: "1", workspace_id: null, folders: [], favorites: [] },
    ...overrides,
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

function fakeApi(overrides?: Partial<StoreApi>): StoreApi & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  return {
    calls,
    async getMe() {
      count("getMe");
      return fakeUser();
    },
    async getAppsStatus() {
      count("getAppsStatus");
      return [{ id: "app1", cpu: "1.0%", ram: "50MB", running: true, uptime: 120 }] as APIApplicationStatusShort[];
    },
    async getDatabasesStatus() {
      count("getDatabasesStatus");
      return [] as APIDatabaseStatusShort[];
    },
    async getWorkspaces() {
      count("getWorkspaces");
      return [] as APIWorkspace[];
    },
    async getServiceStatus() {
      count("getServiceStatus");
      return { status: "healthy", message: "" } as APIStatus;
    },
    async setFavorite(_scope, resource, favorite) {
      count("setFavorite");
      return {
        scope: "personal",
        user_id: "1",
        workspace_id: null,
        folders: [],
        favorites: favorite ? [{ ...resource, position: 0, created_at: "2026-01-01T00:00:00.000Z" }] : [],
      } as APIWorkspaceResourceOrganization;
    },
    ...overrides,
  };
}

test("single load calls getMe exactly once", async () => {
  const session = new FakeSession();
  const api = fakeApi();
  const store = new Store(session, api, new FakeMemento());
  session.setState({ status: "connected", user: fakeUser() });
  await store.refresh();
  assert.equal(api.calls.getMe, 1);
  assert.equal(store.apps.length, 1);
  assert.equal(store.apps[0].status?.running, true);
  store.dispose();
});

test("coalesced refresh: 3 concurrent calls trigger getMe once", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const api = fakeApi();
  const store = new Store(session, api, new FakeMemento());
  await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
  assert.equal(api.calls.getMe, 1);
  store.dispose();
});

test("error preserves previous data and sets lastError", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  let fail = false;
  const api = fakeApi({
    async getMe() {
      if (fail) {throw { code: "NETWORK_ERROR", message: "boom" };}
      return fakeUser();
    },
  });
  const store = new Store(session, api, new FakeMemento());
  await store.refresh();
  assert.equal(store.apps.length, 1);

  fail = true;
  await store.refresh();
  assert.equal(store.apps.length, 1, "previous data must survive an error");
  assert.equal(store.lastError?.code, "NETWORK_ERROR");
  store.dispose();
});

test("tolerates 403 on workspaces without dropping the rest", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const api = fakeApi({
    async getWorkspaces() {
      throw { code: "API_KEY_SCOPE_DENIED" };
    },
  });
  const store = new Store(session, api, new FakeMemento());
  await store.refresh();
  assert.equal(store.lastError, undefined);
  assert.equal(store.workspaces.length, 0);
  assert.equal(store.apps.length, 1);
  store.dispose();
});

test("pollAfterMutation never writes optimistic state and stops once confirmed", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const api = fakeApi();
  const store = new Store(session, api, new FakeMemento());
  await store.refresh();
  store.mutationPollIntervalMs = 0;

  let running = true;
  let calls = 0;
  api.getAppsStatus = async () => {
    calls++;
    if (calls >= 2) {running = false;}
    return [{ id: "app1", cpu: "1%", ram: "10MB", running, uptime: 10 }] as APIApplicationStatusShort[];
  };

  await store.pollAfterMutation("app1", "down");
  assert.equal(store.apps[0].status?.running, false);
  assert.equal(calls, 2, "should stop as soon as the API confirms the expected state");
  store.dispose();
});

test("polling does not run without window focus", async () => {
  vi.useFakeTimers();
  try {
    const session = new FakeSession();
    const api = fakeApi();
    const store = new Store(session, api, new FakeMemento());
    session.setState({ status: "connected", user: fakeUser() });
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterInitial = api.calls.getMe ?? 0;
    store.setWindowFocus(false);
    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(api.calls.getMe, callsAfterInitial, "no refresh should happen while unfocused");
    store.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("old memento favorites do not drive the remote organization", async () => {
  const memento = new FakeMemento();
  await memento.update("vertraCloud.favorites", ["app1"]);
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const api = fakeApi();
  const store = new Store(session, api, memento);
  await store.refresh();
  assert.equal(store.apps[0].favorite, false);
  await store.toggleFavorite("application", "app1");
  assert.equal(store.apps[0].favorite, true);
  assert.equal(memento.get("vertraCloud.favorites"), undefined);

  const store2 = new Store(session, api, memento);
  await store2.refresh();
  assert.equal(store2.apps[0].favorite, false);
  store.dispose();
  store2.dispose();
});

test("personal and workspace favorites stay isolated", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const workspaceOrganization: APIWorkspaceResourceOrganization = {
    scope: "workspace",
    user_id: "1",
    workspace_id: "w1",
    folders: [],
    favorites: [],
  };
  const api = fakeApi({
    async getWorkspaces() {return [{ id: "w1", name: "Team", owner: { display_name: "Ana" } } as never];},
    async getWorkspace() {
      return { id: "w1", name: "Team", applications: fakeUser().applications, databases: [], resource_organization: workspaceOrganization } as never;
    },
    async setFavorite(scope, resource, favorite) {
      const current = scope.workspaceId ? workspaceOrganization : fakeUser().resource_organization;
      const organization = {
        ...current,
        favorites: favorite ? [{ ...resource, position: 0, created_at: "2026-01-01T00:00:00.000Z" }] : [],
      };
      if (scope.workspaceId) {Object.assign(workspaceOrganization, organization);}
      return organization;
    },
  });
  const store = new Store(session, api, new FakeMemento());
  await store.refresh();
  await store.toggleFavorite("application", "app1");
  await store.toggleFavorite("application", "app1", "w1");
  assert.equal(store.isFavorite("application", "app1"), true);
  assert.equal(store.isFavorite("application", "app1", "w1"), true);
  store.dispose();
});

test("remote favorite failure rolls back the optimistic cache", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const api = fakeApi({ async setFavorite() {throw { code: "NETWORK_ERROR" };} });
  const store = new Store(session, api, new FakeMemento());
  await store.refresh();
  await assert.rejects(() => store.toggleFavorite("application", "app1"));
  assert.equal(store.isFavorite("application", "app1"), false);
  assert.equal(store.apps[0].favorite, false);
  store.dispose();
});

test("disconnect clears data", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const api = fakeApi();
  const store = new Store(session, api, new FakeMemento());
  await store.refresh();
  assert.equal(store.apps.length, 1);

  session.setState({ status: "disconnected" });
  assert.equal(store.apps.length, 0);
  assert.equal(store.user, undefined);
  store.dispose();
});

test("disconnect during a refresh does not leave a stale error", async () => {
  const session = new FakeSession();
  session.setState({ status: "connected", user: fakeUser() });
  const api = fakeApi({
    async getAppsStatus() {
      session.setState({ status: "disconnected" });
      throw Object.assign(new Error("revoked"), { code: "API_KEY_INVALID" });
    },
  });
  const store = new Store(session, api, new FakeMemento());

  await store.refresh();

  assert.equal(store.lastError, undefined);
  store.dispose();
});
