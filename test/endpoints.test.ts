import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import {
  getAppMetrics,
  getAppsStatus,
  getDatabase,
  getServiceStatus,
  getWorkspace,
  getWorkspaces,
  restartApp,
} from "../src/api/endpoints";
import { addResourceToFolder, createFolder, setFavorite, updateFolder } from "../src/api/organization";

const BASE = "https://api.vertracloud.app";

interface Call {
  url: string;
  init: RequestInit;
}

function stub(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ response: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const client = () => new ApiClient(async () => "tok", "vertra-cloud-vscode/1.0.0");

afterEach(() => {
  vi.unstubAllGlobals();
});

test("service status is requested without authorization", async () => {
  const calls = stub();
  await getServiceStatus(client());
  assert.equal(calls[0].url, `${BASE}/v1/status`);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, undefined);
});

test("restart sends the optional body as JSON", async () => {
  const calls = stub();
  await restartApp(client(), "app-1", { reinstall_dependencies: true });
  assert.equal(calls[0].url, `${BASE}/v1/apps/app-1/restart`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify({ reinstall_dependencies: true }));
});

test("metrics carry the range and the workspace", async () => {
  const calls = stub();
  await getAppMetrics(client(), "app-1", "30m", { workspaceId: "w1" });
  assert.equal(calls[0].url, `${BASE}/v1/apps/app-1/metrics?range=30m&workspace_id=w1`);
});

test("batch status and database detail build the expected routes", async () => {
  const calls = stub();
  await getAppsStatus(client());
  await getDatabase(client(), "db-1", { workspaceId: "w2" });
  await getWorkspaces(client());
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${BASE}/v1/apps/status`, `${BASE}/v1/databases/db-1?workspace_id=w2`, `${BASE}/v1/workspaces`],
  );
});

test("resource organization routes preserve the personal/workspace scope", async () => {
  const calls = stub();
  await getWorkspace(client(), "w/1");
  await createFolder(client(), { name: "Backend", color: "blue" });
  await updateFolder(client(), "f/1", { name: "API" }, { workspaceId: "w/1" });
  await addResourceToFolder(client(), "f/1", "application", "app/1", { workspaceId: "w/1" });
  await setFavorite(client(), { resource_type: "database", resource_id: "db-1" }, true);
  assert.deepEqual(calls.map((call) => [call.init.method ?? "GET", call.url]), [
    ["GET", `${BASE}/v1/workspaces/w%2F1`],
    ["POST", `${BASE}/v1/users/me/folders`],
    ["PATCH", `${BASE}/v1/workspaces/w%2F1/folders/f%2F1`],
    ["PUT", `${BASE}/v1/workspaces/w%2F1/folders/f%2F1/resources/application/app%2F1`],
    ["PUT", `${BASE}/v1/users/me/favorites/database/db-1`],
  ]);
});
