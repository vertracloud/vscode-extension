import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import * as vscode from "vscode";
import { ApiClient, ApiError } from "../src/api/client";

const BASE = "https://api.vertracloud.app";

function client(): ApiClient {
  return new ApiClient(async () => "secret-token", "vertra-cloud-vscode/1.2.3");
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("unwraps the success envelope and sends auth, accept and user agent", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    seen = { url, init };
    return json({ response: { id: "app-1" } });
  });

  const result = await client().request<{ id: string }>("/v1/apps/app-1", { query: { workspace_id: "w1" } });

  assert.deepEqual(result, { id: "app-1" });
  assert.equal(seen?.url, `${BASE}/v1/apps/app-1?workspace_id=w1`);
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer secret-token");
  assert.equal(headers["User-Agent"], "vertra-cloud-vscode/1.2.3");
  assert.equal(headers.Accept, "application/json");
});

test("maps an error envelope with details.retry_after", async () => {
  vi.stubGlobal("fetch", async () =>
    json(
      { code: "DEPLOY_RATE_LIMITED", message: "slow down", details: { limit: 20, retry_after: 42 } },
      { status: 429 },
    ),
  );

  const error = await client()
    .request("/v1/apps/x/restart", { method: "POST" })
    .then(() => undefined)
    .catch((err: unknown) => err);

  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 429);
  assert.equal(error.code, "DEPLOY_RATE_LIMITED");
  assert.equal(error.retryAfter, 42);
  assert.deepEqual(error.details, { limit: 20, retry_after: 42 });
});

test("falls back to the retry-after header when the body has none", async () => {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ code: "RATE_LIMIT_EXCEEDED" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "7" },
    }),
  );

  const error = (await client()
    .request("/v1/users/me", { retryIdempotent: false })
    .catch((err: unknown) => err)) as ApiError;

  assert.equal(error.retryAfter, 7);
});

test("uses HTTP_<status> when the error body is not JSON", async () => {
  vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 500 }));

  const error = (await client()
    .request("/v1/users/me", { retryIdempotent: false })
    .catch((err: unknown) => err)) as ApiError;

  assert.equal(error.code, "HTTP_500");
  assert.equal(error.status, 500);
});

test("aborts on timeout", async () => {
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );

  const error = (await client()
    .request("/v1/users/me", { timeoutMs: 10, retryIdempotent: false })
    .catch((err: unknown) => err)) as ApiError;

  assert.equal(error.code, "TIMEOUT");
  assert.equal(error.status, 0);
});

test("aborts when the cancellation token fires", async () => {
  const source = new vscode.CancellationTokenSource();
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => source.cancel(), 5);
      }),
  );

  const error = (await client()
    .request("/v1/users/me", { token: source.token, retryIdempotent: false })
    .catch((err: unknown) => err)) as ApiError;

  assert.equal(error.code, "CANCELLED");
  assert.equal(error.status, 0);
});

test("retries a GET once on 503 and never retries a mutation", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return calls === 1 ? json({ code: "UNAVAILABLE" }, { status: 503 }) : json({ response: "ok" });
  });
  assert.equal(await client().request("/v1/users/me"), "ok");
  assert.equal(calls, 2);

  calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return json({ code: "UNAVAILABLE" }, { status: 503 });
  });
  await assert.rejects(
    client().request("/v1/apps/x/start", { method: "POST", retryIdempotent: true }),
    (err: ApiError) => err.status === 503,
  );
  assert.equal(calls, 1);
});

test("captures rate limit and quota headers", async () => {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ response: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-limit": "120",
        "x-ratelimit-remaining": "119",
        "x-ratelimit-reset": "30",
        "x-quota-remaining": "19000",
        "x-quota-reset": "3600",
      },
    }),
  );

  const api = client();
  await api.request("/v1/users/me");

  assert.deepEqual(api.lastRateLimit, {
    limit: 120,
    remaining: 119,
    reset: 30,
    quotaRemaining: 19000,
    quotaReset: 3600,
  });
});

test("onUnauthorized fires only for auth codes on 401", async () => {
  const api = client();
  const seen: string[] = [];
  api.onUnauthorized((error) => seen.push(error.code));

  vi.stubGlobal("fetch", async () => json({ code: "API_KEY_INVALID" }, { status: 401 }));
  await api.request("/v1/users/me", { retryIdempotent: false }).catch(() => undefined);
  assert.deepEqual(seen, ["API_KEY_INVALID"]);

  vi.stubGlobal("fetch", async () => json({ code: "USER_NOT_FOUND" }, { status: 401 }));
  await api.request("/v1/users/me", { retryIdempotent: false }).catch(() => undefined);
  assert.deepEqual(seen, ["API_KEY_INVALID"]);
});

test("stream asks for text/event-stream and throws the envelope error", async () => {
  let accept: string | undefined;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    accept = (init.headers as Record<string, string>).Accept;
    return json({ code: "APP_NOT_FOUND" }, { status: 404 });
  });

  const error = (await client()
    .stream("/v1/apps/x/realtime", { signal: new AbortController().signal })
    .catch((err: unknown) => err)) as ApiError;

  assert.equal(accept, "text/event-stream");
  assert.equal(error.code, "APP_NOT_FOUND");
});

test("a 401 on an anonymous route never fires onUnauthorized", async () => {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ code: "API_KEY_INVALID" }), { status: 401 }),
  );
  const api = client();
  let fired = 0;
  api.onUnauthorized(() => {
    fired++;
  });

  await assert.rejects(api.request("/v1/oauth/token", { method: "POST", anonymous: true }));
  assert.equal(fired, 0);

  await assert.rejects(api.request("/v1/users/me"));
  assert.equal(fired, 1);
});
