import assert from "node:assert/strict";
import { describe, it } from "vitest";
import "./vscode-mock";
import type { ApiClient } from "../src/api/client";
import { deleteDatabase } from "../src/api/databases";
import { deleteApp } from "../src/api/endpoints";
import { restoreSnapshot } from "../src/api/snapshots";

interface Sent {
  path: string;
  opts?: { method?: string; query?: Record<string, unknown>; body?: unknown; timeoutMs?: number };
}

function recordingClient(answer: unknown) {
  const sent: Sent[] = [];
  const client = {
    request: async (path: string, opts?: Sent["opts"]) => {
      sent.push({ path, opts });
      return answer;
    },
  } as unknown as ApiClient;
  return { client, sent };
}

describe("ações destrutivas rodam na hora, sem parâmetro extra", () => {
  it("delete app só manda o escopo do workspace", async () => {
    const { client, sent } = recordingClient(null);
    await deleteApp(client, "app-1");
    assert.equal(sent[0].path, "/v1/apps/app-1");
    assert.equal(sent[0].opts?.method, "DELETE");
    assert.deepEqual(Object.values(sent[0].opts?.query ?? {}).filter((value) => value !== undefined), []);
    assert.equal(sent[0].opts?.timeoutMs, undefined);
  });

  it("delete database devolve o id do response", async () => {
    const { client, sent } = recordingClient("db-1");
    const id = await deleteDatabase(client, "db-1", { workspaceId: "ws-1" });
    assert.equal(id, "db-1");
    assert.equal(sent[0].opts?.method, "DELETE");
    assert.deepEqual(sent[0].opts?.query, { workspace_id: "ws-1" });
    assert.equal(sent[0].opts?.timeoutMs, undefined);
  });

  it("restore manda restore_image_version só quando pedido e devolve o job", async () => {
    const { client, sent } = recordingClient({ job_id: "j1", warning: "IMAGE_VERSION_NOT_FOUND" });
    const accepted = await restoreSnapshot(client, "app-1", "s1", "applications", { restoreImageVersion: true });
    assert.deepEqual(accepted, { job_id: "j1", warning: "IMAGE_VERSION_NOT_FOUND" });
    assert.deepEqual(sent[0].opts?.body, { restore_image_version: true });
    await restoreSnapshot(client, "app-1", "s1", "applications");
    assert.equal(sent[1].opts?.body, undefined);
  });
});
