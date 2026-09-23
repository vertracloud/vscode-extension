import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import * as vscode from "vscode";
import { ApiClient } from "../src/api/client";
import { Session } from "../src/auth";

const SECRET_KEY = "vertraCloudApiKey";

class FakeSecrets {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function session(secrets: FakeSecrets): Session {
  const client = new ApiClient(() => secrets.get(SECRET_KEY), "vertra-cloud-vscode/1.0.0");
  return new Session(secrets as unknown as vscode.SecretStorage, client);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("an invalid API key never replaces the stored one", async () => {
  const secrets = new FakeSecrets();
  await secrets.store(SECRET_KEY, "good-key");
  vi.stubGlobal("fetch", async () => json({ code: "API_KEY_INVALID" }, 401));

  const auth = session(secrets);
  await assert.rejects(auth.connectWithApiKey("bad-key"));
  assert.equal(secrets.data.get(SECRET_KEY), "good-key");
});

test("restore deletes the secret on 401 and keeps it on a network failure", async () => {
  const secrets = new FakeSecrets();
  await secrets.store(SECRET_KEY, "stale-key");
  vi.stubGlobal("fetch", async () => json({ code: "API_KEY_INVALID" }, 401));
  const revoked = session(secrets);
  await revoked.restore();
  assert.equal(secrets.data.has(SECRET_KEY), false);
  assert.equal(revoked.state.status, "disconnected");

  await secrets.store(SECRET_KEY, "good-key");
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const offline = session(secrets);
  await offline.restore();
  assert.equal(secrets.data.get(SECRET_KEY), "good-key");
  assert.deepEqual(offline.state, { status: "disconnected", reason: "network" });
});

test("disconnect deletes the secret", async () => {
  const secrets = new FakeSecrets();
  await secrets.store(SECRET_KEY, "key");
  const auth = session(secrets);
  await auth.disconnect();
  assert.equal(secrets.data.has(SECRET_KEY), false);
  assert.equal(auth.state.status, "disconnected");
});
