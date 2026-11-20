import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import "./vscode-mock";
import type { ApiClient } from "../src/api/client";
import {
  createSnapshot,
  downloadApp,
  downloadAppToFile,
  downloadSnapshot,
  downloadSnapshotToFile,
  getSnapshotJob,
  listSnapshots,
  restoreSnapshot,
  waitForSnapshotJob,
} from "../src/api/snapshots";

const WS = "33333333-3333-3333-3333-333333333333";
const noSleep = async () => {};

function recordingClient(responses: unknown[]) {
  const calls: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const queue = [...responses];
  const client = {
    request: async (path: string, opts?: { query?: Record<string, unknown>; sink?: (chunk: Uint8Array) => Promise<void> }) => {
      calls.push({ path, query: opts?.query });
      if (opts?.sink) {await opts.sink(new Uint8Array([80, 75]));}
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const flow = () => [
  { job_id: "j1" },
  { id: "j1", kind: "snapshot", resource_id: "app-1", status: "ready", snapshot_id: "s1" },
  new ArrayBuffer(2),
];

describe("workspaceId nas chamadas de snapshot", () => {
  it("downloadApp e downloadAppToFile mandam workspace_id em todas as chamadas do fluxo", async () => {
    for (const run of ["buffer", "file"] as const) {
      const { client, calls } = recordingClient(flow());
      const scratch = await mkdtemp(join(tmpdir(), "vertra-ext-ws-"));
      try {
        if (run === "buffer") {await downloadApp(client, "app-1", { workspaceId: WS, sleep: noSleep });}
        else {await downloadAppToFile(client, "app-1", join(scratch, "a.zip"), { workspaceId: WS, sleep: noSleep });}
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      assert.equal(calls.length, 3, run);
      for (const call of calls) {assert.equal(call.query?.workspace_id, WS, `${run}: ${call.path}`);}
    }
  });

  it("cada função da API leva workspace_id quando informado e o omite quando não", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vertra-ext-ws-"));
    try {
      const { client, calls } = recordingClient([{ id: "j1", status: "ready", kind: "snapshot", resource_id: "a" }]);
      await listSnapshots(client, "app-1", "applications", { workspaceId: WS });
      await createSnapshot(client, "app-1", "applications", undefined, { workspaceId: WS });
      await restoreSnapshot(client, "app-1", "s1", "applications", { workspaceId: WS });
      await getSnapshotJob(client, "app-1", "j1", "applications", undefined, { workspaceId: WS });
      await waitForSnapshotJob(client, "app-1", "j1", "applications", { workspaceId: WS, sleep: noSleep });
      await downloadSnapshot(client, "app-1", "s1", "applications", undefined, { workspaceId: WS });
      await downloadSnapshotToFile(client, "app-1", "s1", "applications", join(scratch, "s.zip"), undefined, { workspaceId: WS });
      assert.equal(calls.length, 7);
      for (const call of calls) {assert.equal(call.query?.workspace_id, WS, call.path);}
      await listSnapshots(client, "app-1", "applications");
      assert.equal(calls.at(-1)?.query?.workspace_id, undefined);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
