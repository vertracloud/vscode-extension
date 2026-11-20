import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import "./vscode-mock";
import { ApiClient, ApiError } from "../src/api/client";
import { downloadApp, waitForSnapshotJob, type SnapshotJob } from "../src/api/snapshots";
import { describeError } from "../src/l10n";

afterEach(() => {
  vi.unstubAllGlobals();
});

const noSleep = async () => {};

function fakeClient(responder: (path: string, query?: Record<string, unknown>) => unknown) {
  const calls: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const client = {
    request: async (path: string, opts?: { query?: Record<string, unknown> }) => {
      calls.push({ path, query: opts?.query });
      const out = responder(path, opts?.query);
      if (out instanceof Error) {throw out;}
      return out;
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const job = (status: SnapshotJob["status"], reason?: string): SnapshotJob => ({
  id: "j1",
  kind: "restore",
  resource_id: "app-1",
  status,
  reason,
});

describe("waitForSnapshotJob", () => {
  it("polls until ready, reporting each status", async () => {
    const states = [job("queued"), job("running"), job("ready")];
    const { client, calls } = fakeClient(() => states.shift());
    const seen: string[] = [];
    const done = await waitForSnapshotJob(client, "app-1", "j1", "applications", {
      sleep: noSleep,
      onStatus: (s) => seen.push(s),
    });
    assert.equal(done.status, "ready");
    assert.deepEqual(seen, ["queued", "running", "ready"]);
    assert.equal(calls[0].path, "/v1/users/app-1/snapshots/jobs/j1");
    assert.equal(calls[0].query?.scope, "applications");
  });

  it("turns a failed job into an ApiError carrying the public reason", async () => {
    const { client } = fakeClient(() => job("failed", "SNAPSHOT_CORRUPTED"));
    await assert.rejects(
      waitForSnapshotJob(client, "db-1", "j1", "databases", { sleep: noSleep }),
      (e: unknown) => e instanceof ApiError && e.code === "SNAPSHOT_CORRUPTED",
    );
  });

  it("keeps the details of the reason, so the message can say how much space is missing", async () => {
    const details = { required_bytes: 900, available_bytes: 100, required_ram_mb: 512 };
    const { client } = fakeClient(() => ({ ...job("failed", "SNAPSHOT_EXCEEDS_STORAGE"), details }));
    await assert.rejects(
      waitForSnapshotJob(client, "db-1", "j1", "databases", { sleep: noSleep }),
      (e: unknown) =>
        e instanceof ApiError &&
        e.code === "SNAPSHOT_EXCEEDS_STORAGE" &&
        (e.details as { required_bytes?: number; job_id?: string }).required_bytes === 900 &&
        (e.details as { job_id?: string }).job_id === "j1",
    );
  });

  it("falls back to a generic code when a failed job has no reason", async () => {
    const { client } = fakeClient(() => job("failed"));
    await assert.rejects(
      waitForSnapshotJob(client, "app-1", "j1", "applications", { sleep: noSleep }),
      (e: unknown) => e instanceof ApiError && e.code === "SNAPSHOT_RESTORE_FAILED",
    );
  });

  it("stops when the user cancels", async () => {
    const { client, calls } = fakeClient(() => job("running"));
    await assert.rejects(
      waitForSnapshotJob(client, "app-1", "j1", "applications", {
        sleep: noSleep,
        token: { isCancellationRequested: true } as never,
      }),
      (e: unknown) => e instanceof ApiError && e.code === "CANCELLED",
    );
    assert.equal(calls.length, 0);
  });

  it("gives up after the wait ceiling", async () => {
    const { client } = fakeClient(() => job("running"));
    await assert.rejects(
      waitForSnapshotJob(client, "app-1", "j1", "applications", { sleep: noSleep, maxWaitMs: -1 }),
      (e: unknown) => e instanceof ApiError && e.code === "TIMEOUT",
    );
  });
});

describe("downloadApp", () => {
  const zip = new ArrayBuffer(4);
  const snapshot = { id: "snap-1", date: "2026-11-18T00:00:00.000Z", size: "10" };

  function flow(answers: Record<string, unknown[]>) {
    return fakeClient((path) => {
      const queue = answers[path];
      if (!queue) {throw new Error(`unexpected ${path}`);}
      return queue.shift();
    });
  }

  it("creates a manual snapshot and downloads it (201)", async () => {
    const { client, calls } = flow({
      "/v1/users/app-1/snapshots": [snapshot],
      "/v1/users/app-1/snapshots/snap-1/download": [zip],
    });
    let preparing = 0;
    const result = await downloadApp(client, "app-1", { sleep: noSleep, onPreparing: () => preparing++ });
    assert.equal(result, zip);
    assert.equal(preparing, 0);
    assert.deepEqual(calls.map((c) => c.path), ["/v1/users/app-1/snapshots", "/v1/users/app-1/snapshots/snap-1/download"]);
    assert.equal(calls[0].query?.scope, "applications");
    assert.equal(calls[1].query?.scope, "applications");
  });

  it("on 202 follows the job and downloads the snapshot it produced", async () => {
    const { client, calls } = flow({
      "/v1/users/app-1/snapshots": [{ job_id: "j1" }],
      "/v1/users/app-1/snapshots/jobs/j1": [
        { ...job("running"), kind: "snapshot" },
        { ...job("ready"), kind: "snapshot", snapshot_id: "snap-9" },
      ],
      "/v1/users/app-1/snapshots/snap-9/download": [zip],
    });
    let preparing = 0;
    const result = await downloadApp(client, "app-1", { sleep: noSleep, onPreparing: () => preparing++ });
    assert.equal(result, zip);
    assert.ok(preparing >= 1);
    assert.equal(calls[calls.length - 1].path, "/v1/users/app-1/snapshots/snap-9/download");
  });

  it("does not swallow other errors", async () => {
    const { client } = fakeClient(() => new ApiError(403, "API_KEY_SCOPE_DENIED", undefined, { required: "snapshots:write" }));
    await assert.rejects(downloadApp(client, "app-1", { sleep: noSleep }), (e: unknown) => (e as ApiError).code === "API_KEY_SCOPE_DENIED");
  });

  it("fails when a ready job carries no snapshot", async () => {
    const { client } = flow({
      "/v1/users/app-1/snapshots": [{ job_id: "j1" }],
      "/v1/users/app-1/snapshots/jobs/j1": [{ ...job("ready"), kind: "snapshot" }],
    });
    await assert.rejects(downloadApp(client, "app-1", { sleep: noSleep }), (e: unknown) => (e as ApiError).code === "SNAPSHOT_NOT_FOUND");
  });

  it("a failed snapshot job surfaces SNAPSHOT_FAILED, not a restore code", async () => {
    const { client } = flow({
      "/v1/users/app-1/snapshots": [{ job_id: "j1" }],
      "/v1/users/app-1/snapshots/jobs/j1": [{ ...job("failed"), kind: "snapshot" }],
    });
    await assert.rejects(downloadApp(client, "app-1", { sleep: noSleep }), (e: unknown) => (e as ApiError).code === "SNAPSHOT_FAILED");
  });
});

describe("getSnapshotJob", () => {
  it("does not send a scope when none is given", async () => {
    const { client, calls } = fakeClient(() => job("ready"));
    await waitForSnapshotJob(client, "app-1", "j1", undefined, { sleep: noSleep });
    assert.equal(calls[0].query?.scope, undefined);
  });
});

describe("snapshot error texts", () => {
  it("RESTORE_IN_PROGRESS and OPERATION_IN_PROGRESS are specific", () => {
    assert.match(describeError({ code: "RESTORE_IN_PROGRESS" }), /restored/);
    assert.match(describeError({ code: "OPERATION_IN_PROGRESS" }), /snapshot/);
  });

  it("SNAPSHOT_EXCEEDS_STORAGE carries the numbers and the memory hint", () => {
    const text = describeError({
      code: "SNAPSHOT_EXCEEDS_STORAGE",
      details: { required_bytes: 2 * 1024 ** 3, available_bytes: 1024 ** 3, required_ram_mb: 2048 },
    });
    assert.match(text, /2\.0 GB/);
    assert.match(text, /1\.0 GB/);
    assert.match(text, /2 GB/);
    assert.match(describeError({ code: "SNAPSHOT_EXCEEDS_STORAGE" }), /doesn't fit/);
  });

  it("never leaks the code of an internal error as the text of a known one", () => {
    for (const code of ["SNAPSHOT_CORRUPTED", "SNAPSHOT_IMPORT_FAILED", "SNAPSHOT_ENGINE_MISMATCH", "SNAPSHOT_RESTORE_FAILED", "SNAPSHOT_NOT_FOUND"]) {
      assert.notEqual(describeError({ code }), code);
    }
  });
});
