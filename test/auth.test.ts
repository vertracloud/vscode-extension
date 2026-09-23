import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import * as vscode from "vscode";
import { ApiClient } from "../src/api/client";
import { Session } from "../src/auth";

const realFetch = globalThis.fetch.bind(globalThis);
const BASE = "https://api.vertracloud.app";
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

function stubOAuth(opts: { onAuthorize: (url: URL) => Promise<void> }): { tokenBody: () => string } {
  let tokenBody = "";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: BASE,
        authorization_endpoint: `${BASE}/v1/oauth/authorize`,
        token_endpoint: `${BASE}/v1/oauth/token`,
        registration_endpoint: `${BASE}/v1/oauth/register`,
      });
    }
    if (url.endsWith("/v1/oauth/register")) {
      return json({ client_id: "client-uuid" }, 201);
    }
    if (url.endsWith("/v1/oauth/token")) {
      tokenBody = String(init.body);
      return json({ access_token: "oauth-token", token_type: "bearer" });
    }
    if (url.endsWith("/v1/users/me")) {
      return json({ response: { id: "user-1" } });
    }
    throw new Error(`unexpected request to ${url}`);
  });

  (vscode.env as { openExternal: (uri: vscode.Uri) => Thenable<boolean> }).openExternal = async (uri) => {
    await opts.onAuthorize(new URL(uri.toString()));
    return true;
  };

  return { tokenBody: () => tokenBody };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("completes the OAuth flow over a real loopback callback and binds the PKCE pair", async () => {
  const secrets = new FakeSecrets();
  let authorizeUrl: URL | undefined;
  const oauth = stubOAuth({
    onAuthorize: async (url) => {
      authorizeUrl = url;
      const redirect = new URL(url.searchParams.get("redirect_uri") as string);
      redirect.searchParams.set("code", "auth-code");
      redirect.searchParams.set("state", url.searchParams.get("state") as string);
      const page = await realFetch(redirect.toString());
      assert.equal(page.status, 200);
    },
  });

  const auth = session(secrets);
  await auth.connectWithOAuth();

  assert.equal(secrets.data.get(SECRET_KEY), "oauth-token");
  assert.equal(auth.state.status, "connected");

  const redirectUri = authorizeUrl?.searchParams.get("redirect_uri") as string;
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(authorizeUrl?.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl?.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizeUrl?.searchParams.get("client_id"), "client-uuid");

  const body = new URLSearchParams(oauth.tokenBody());
  const verifier = body.get("code_verifier") as string;
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("redirect_uri"), redirectUri);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    authorizeUrl?.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
});

test("rejects a callback whose state does not match and stores nothing", async () => {
  const secrets = new FakeSecrets();
  stubOAuth({
    onAuthorize: async (url) => {
      const redirect = new URL(url.searchParams.get("redirect_uri") as string);
      redirect.searchParams.set("code", "auth-code");
      redirect.searchParams.set("state", "forged-state");
      await realFetch(redirect.toString());
    },
  });

  const auth = session(secrets);
  await assert.rejects(auth.connectWithOAuth(), (error: { code: string }) => error.code === "OAUTH_STATE_MISMATCH");
  assert.equal(secrets.data.has(SECRET_KEY), false);
  assert.equal(auth.state.status, "disconnected");
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
