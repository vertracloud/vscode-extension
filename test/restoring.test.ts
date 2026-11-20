import assert from "node:assert/strict";
import { test } from "vitest";
import { isRestoring } from "../src/restoring";
import { appEffectiveStatus, appTreeItem, dbTreeItem } from "../src/views/items";
import type { AppEntry, DbEntry } from "../src/state";

function appEntry(status: Record<string, unknown> | undefined, appStatus = "up"): AppEntry {
  return {
    app: { id: "a1", name: "web", status: appStatus, ram: 512, domains: [], public_url: null, custom_image: null, language: "javascript" },
    status: status && { id: "a1", cpu: "1%", ram: "10 MB", running: true, uptime: 1, ...status },
    favorite: false,
  } as unknown as AppEntry;
}

function dbEntry(status: Record<string, unknown> | undefined): DbEntry {
  return {
    db: { id: "d1", name: "main", type: "postgresql", status: "up", ram: 256, host: "h", port: 5432 },
    status: status && { id: "d1", cpu: "1%", ram: "10 MB", storage: "1 MB", running: true, ...status },
    favorite: false,
  } as unknown as DbEntry;
}

test("isRestoring: only a filled restore_job_id counts; absent, null and empty do not", () => {
  assert.equal(isRestoring({ restore_job_id: "job-1" }), true);
  assert.equal(isRestoring({ restore_job_id: null }), false);
  assert.equal(isRestoring({ restore_job_id: "" }), false);
  assert.equal(isRestoring({}), false);
  assert.equal(isRestoring(undefined), false);
});

test("an app with a restore job shows as restoring, without breaking when the field is absent", () => {
  assert.equal(appEffectiveStatus(appEntry({ restore_job_id: "job-1" })), "restoring");
  assert.equal(appEffectiveStatus(appEntry({ restore_job_id: null })), "up");
  assert.equal(appEffectiveStatus(appEntry({})), "up");
  assert.equal(appEffectiveStatus(appEntry({ restore_job_id: "job-1" }, "building")), "building");
  assert.match(String(appTreeItem(appEntry({ restore_job_id: "job-1" })).description), /Restoring/);
});

test("a database with a restore job says so in the tree", () => {
  assert.match(String(dbTreeItem(dbEntry({ restore_job_id: "job-1" })).description), /Restoring/);
  assert.doesNotMatch(String(dbTreeItem(dbEntry({ restore_job_id: null })).description), /Restoring/);
  assert.doesNotMatch(String(dbTreeItem(dbEntry({})).description), /Restoring/);
});
