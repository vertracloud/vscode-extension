import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import * as vscodeMock from "./vscode-mock";
import { registerReleasesCommands, releaseRef, releaseStatusKey } from "../src/commands/releases";
import type { CommandDeps } from "../src/commands/deps";
import type { APIApplicationRelease } from "@vertracloud/api-types/v1";

function release(overrides?: Partial<APIApplicationRelease>): APIApplicationRelease {
  return {
    id: "fe009c9a-1111-2222-3333-444444444444",
    app_id: "app1",
    source: "upload",
    status: "superseded",
    message: "fix: boot",
    author: "ana",
    github: null,
    files_changed: 2,
    rollback: { available: true, expires_at: "2026-11-11T12:00:00.000Z", from: null },
    has_log: false,
    build_duration_ms: 1200,
    first_started_at: "2026-10-11T12:01:00.000Z",
    created_at: "2026-10-11T12:00:00.000Z",
    ...overrides,
  };
}

interface Call {
  path: string;
  method?: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

let calls: Call[];
let errors: unknown[];
let polled: string[];
let confirm: boolean;

function makeDeps(onRequest: (call: Call) => unknown): CommandDeps {
  calls = [];
  errors = [];
  polled = [];
  return {
    context: { subscriptions: [] },
    client: {
      request: async (path: string, opts?: { method?: string; query?: Record<string, unknown>; body?: unknown }) => {
        const call = { path, method: opts?.method, query: opts?.query, body: opts?.body };
        calls.push(call);
        return onRequest(call);
      },
    },
    store: { pollAfterMutation: async (appId: string) => void polled.push(appId) },
    refresh: async () => {},
    showError: (err: unknown) => void errors.push(err),
    resolveApp: async () => ({ app: { id: "app1", name: "my-app" } }),
  } as unknown as CommandDeps;
}

/** Responde cada quick pick pela ordem: função que escolhe um item da lista recebida. */
function answerPicks(...choosers: Array<(items: unknown[]) => unknown>): void {
  let i = 0;
  vscodeMock.window.showQuickPick = (async (items: unknown[]) => choosers[i++]?.(items)) as unknown as typeof vscodeMock.window.showQuickPick;
}

const byRelease = (id: string) => (items: unknown[]) => items.find((it) => (it as { release?: APIApplicationRelease }).release?.id === id);
const byLabel = (text: string) => (items: unknown[]) => items.find((it) => (typeof it === "string" ? it : (it as { label: string }).label).includes(text));

async function run(deps: CommandDeps): Promise<void> {
  registerReleasesCommands(deps);
  const handler = vscodeMock.registeredCommands.get("vertraCloud.app.rollbacks");
  assert.ok(handler, "command not registered");
  await handler!(undefined);
}

beforeEach(() => {
  confirm = true;
  // Confirmação modal com botão: devolve o rótulo do botão quando confirmado.
  vscodeMock.window.showWarningMessage = (async (...args: unknown[]) => (confirm ? args[2] : undefined)) as unknown as typeof vscodeMock.window.showWarningMessage;
  vscodeMock.openedTextDocuments.length = 0;
});

test("releaseRef: GitHub shows the short SHA, other sources the start of the version id", () => {
  assert.equal(releaseRef(release()), "fe009c9a");
  assert.equal(
    releaseRef(release({ source: "github", github: { app_id: "app1", commit_id: "abc1234def", message: "m", pusher: "p", branch: "main", created_at: "2026-10-11T12:00:00.000Z" } })),
    "abc1234",
  );
});

test("releaseStatusKey: an active release that has not run yet awaits a restart", () => {
  assert.equal(releaseStatusKey(release({ status: "active", first_started_at: null })), "pending_restart");
  assert.equal(releaseStatusKey(release({ status: "active" })), "active");
  assert.equal(releaseStatusKey(release({ status: "superseded", first_started_at: null })), "superseded");
});

test("lists the app's releases, newest first, 50 per page", async () => {
  const deps = makeDeps(() => ({ data: [], total_count: 0, page: 1, limit: 50, total_pages: 0, has_next_page: false, has_previous_page: false }));
  answerPicks(() => undefined);
  await run(deps);
  assert.deepEqual(calls[0], { path: "/v1/apps/app1/releases", method: undefined, query: { page: 1, limit: 50 }, body: undefined });
});

test("rollback with variable changes: asks, confirms and sends restore_environment", async () => {
  const r = release();
  const deps = makeDeps((call) => {
    if (call.path.endsWith("/releases")) {return { data: [r], total_count: 1, page: 1, limit: 50, total_pages: 1, has_next_page: false, has_previous_page: false };}
    if (call.path.endsWith("/rollback") && !call.method) {return { environment_changes: [{ key: "API_URL", change: "modified" }] };}
    return release({ id: "new", source: "rollback", status: "active" });
  });
  answerPicks(byRelease(r.id), byLabel("Roll back"), byLabel("Restore"));
  await run(deps);
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, `/v1/apps/app1/releases/${r.id}/rollback`);
  assert.deepEqual(post?.body, { restore_environment: true });
  assert.deepEqual(polled, ["app1"]);
  assert.deepEqual(errors, []);
});

test("rollback without variable changes skips the question and keeps the current variables", async () => {
  const r = release();
  const deps = makeDeps((call) => {
    if (call.path.endsWith("/releases")) {return { data: [r], total_count: 1, page: 1, limit: 50, total_pages: 1, has_next_page: false, has_previous_page: false };}
    if (call.path.endsWith("/rollback") && !call.method) {return { environment_changes: [] };}
    return release({ id: "new", source: "rollback", status: "active" });
  });
  answerPicks(byRelease(r.id), byLabel("Roll back"));
  await run(deps);
  assert.deepEqual(calls.find((c) => c.method === "POST")?.body, { restore_environment: false });
});

test("no confirmation, no rollback", async () => {
  confirm = false;
  const r = release();
  const deps = makeDeps((call) => {
    if (call.path.endsWith("/releases")) {return { data: [r], total_count: 1, page: 1, limit: 50, total_pages: 1, has_next_page: false, has_previous_page: false };}
    return { environment_changes: [] };
  });
  answerPicks(byRelease(r.id), byLabel("Roll back"));
  await run(deps);
  assert.equal(calls.find((c) => c.method === "POST"), undefined);
});

test("a version that can't be restored offers no rollback action", async () => {
  const r = release({ rollback: { available: false, expires_at: null, from: null } });
  let offered: unknown[] = [];
  const deps = makeDeps(() => ({ data: [r], total_count: 1, page: 1, limit: 50, total_pages: 1, has_next_page: false, has_previous_page: false }));
  answerPicks(byRelease(r.id), (items) => {
    offered = items;
    return undefined;
  });
  await run(deps);
  assert.equal(offered.some((it) => String(typeof it === "string" ? it : (it as { label: string }).label).includes("Roll back")), false);
});

test("view log opens the crash log as a read-only document; an expired log says so", async () => {
  const r = release({ status: "failed", has_log: true, rollback: { available: false, expires_at: null, from: null } });
  let log: string | null = "Error: boom";
  const deps = makeDeps((call) => {
    if (call.path.endsWith("/releases")) {return { data: [r], total_count: 1, page: 1, limit: 50, total_pages: 1, has_next_page: false, has_previous_page: false };}
    return { content: log };
  });
  answerPicks(byRelease(r.id), byLabel("log"));
  await run(deps);
  assert.equal(calls[1].path, `/v1/apps/app1/releases/${r.id}/log`);
  assert.equal(vscodeMock.openedTextDocuments[0]?.content, "Error: boom");

  log = null;
  let info = "";
  vscodeMock.window.showInformationMessage = (async (msg: string) => {
    info = msg;
    return undefined;
  }) as unknown as typeof vscodeMock.window.showInformationMessage;
  answerPicks(byRelease(r.id), byLabel("log"));
  await run(deps);
  assert.ok(info.toLowerCase().includes("expired"), info);
});
