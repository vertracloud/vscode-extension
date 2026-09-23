import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as vscodeMock from "vscode";
import { ApiError } from "../src/api/client";
import { createAppFromFolder, deployToApp, type UploadClient } from "../src/deploy/deploy";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vertra-deploy-"));
  await fs.writeFile(path.join(root, "index.js"), "console.log(1)");
  (vscodeMock.workspace as { isTrusted: boolean }).isTrusted = true;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function fakeClient(handler: (path: string, opts: unknown) => unknown): UploadClient {
  return {
    request: async <T>(path: string, opts?: unknown) => handler(path, opts) as T,
  };
}

async function trackTempDirs(action: () => Promise<void>): Promise<string[]> {
  const created: string[] = [];
  const originalMkdtemp = fs.mkdtemp;
  const spy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix) => {
    const dir = await originalMkdtemp(prefix);
    created.push(dir);
    return dir;
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return created;
}

async function assertTempDirsRemoved(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await assert.rejects(fs.access(dir));
  }
}

describe("deployToApp", () => {
  it("posts to the upload route with restart in the query and a file field", async () => {
    let capturedPath = "";
    let capturedQuery: Record<string, unknown> = {};
    let capturedForm: FormData | undefined;
    const client = fakeClient((p, opts) => {
      capturedPath = p;
      const o = opts as { query?: Record<string, unknown>; form?: FormData };
      capturedQuery = o.query ?? {};
      capturedForm = o.form;
      return { ok: true };
    });

    const result = await deployToApp(client, {
      appId: "app-1",
      appName: "My App",
      root,
      restart: true,
    });

    assert.equal(capturedPath, "/v1/apps/app-1/files/upload");
    assert.equal(capturedQuery.restart, "true");
    assert.ok(capturedForm);
    assert.ok(capturedForm!.get("file"));
    assert.deepEqual(result, { ok: true });
  });

  it("cleans up the temp zip after a successful upload", async () => {
    const client = fakeClient(() => ({ ok: true }));
    const created = await trackTempDirs(async () => {
      await deployToApp(client, { appId: "app-1", appName: "App", root, restart: false });
    });
    await assertTempDirsRemoved(created);
  });

  it("cleans up the temp zip when the client throws", async () => {
    const client = fakeClient(() => {
      throw new ApiError(500, "UPLOAD_FAILED");
    });
    const created = await trackTempDirs(async () => {
      await assert.rejects(deployToApp(client, { appId: "app-1", appName: "App", root, restart: false }));
    });
    await assertTempDirsRemoved(created);
  });

  it("refuses when the workspace is not trusted", async () => {
    (vscodeMock.workspace as { isTrusted: boolean }).isTrusted = false;
    const client = fakeClient(() => ({ ok: true }));
    await assert.rejects(
      deployToApp(client, { appId: "app-1", appName: "App", root, restart: false }),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "WORKSPACE_NOT_TRUSTED");
        return true;
      },
    );
  });
});

describe("createAppFromFolder", () => {
  it("posts to /v1/apps with text fields and a file", async () => {
    let capturedPath = "";
    let capturedForm: FormData | undefined;
    const client = fakeClient((p, opts) => {
      capturedPath = p;
      capturedForm = (opts as { form?: FormData }).form;
      return { id: "1" };
    });

    const result = await createAppFromFolder(client, {
      root,
      fields: { name: "app", memory: 100, main: "index.js", version: "recommended" },
    });

    assert.equal(capturedPath, "/v1/apps");
    assert.equal(capturedForm!.get("name"), "app");
    assert.equal(capturedForm!.get("memory"), "100");
    assert.ok(capturedForm!.get("file"));
    assert.deepEqual(result, { id: "1" });
  });
});
