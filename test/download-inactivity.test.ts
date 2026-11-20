import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import "./vscode-mock";
import { CancellationTokenSource } from "./vscode-mock";
import { ApiClient, ApiError } from "../src/api/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Resposta 200 cujo corpo manda `chunks` pedaços, um a cada `everyMs`, e só então fecha (ou nunca, com `stallAfter`). */
function slowBody(init: { chunks: number; everyMs: number; stallAfter?: number }): (url: string, req: RequestInit) => Promise<Response> {
  return async (_url, req) => {
    let sent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = () => {
          clearTimeout(timer);
          controller.error(new DOMException("aborted", "AbortError"));
        };
        req.signal?.addEventListener("abort", onAbort, { once: true });
        const tick = () => {
          if (init.stallAfter !== undefined && sent >= init.stallAfter) {return;}
          if (sent >= init.chunks) {
            controller.close();
            return;
          }
          sent++;
          controller.enqueue(new Uint8Array([sent]));
          timer = setTimeout(tick, init.everyMs);
        };
        tick();
      },
    });
    return new Response(body, { status: 200 });
  };
}

const client = () => new ApiClient(async () => "t", "ua");

describe("download read with an inactivity deadline", () => {
  it("finishes a download that takes longer than the old total deadline while bytes keep arriving", async () => {
    vi.stubGlobal("fetch", slowBody({ chunks: 12, everyMs: 100 }));
    const started = Date.now();
    const buffer = await client().request<ArrayBuffer>("/v1/users/a/snapshots/s/download", {
      raw: true,
      timeoutMs: 300,
      inactivityMs: 200,
    });
    assert.ok(Date.now() - started > 1000, "the body must outlast the old total deadline");
    assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("fails with a clear message when the body stops in the middle", async () => {
    vi.stubGlobal("fetch", slowBody({ chunks: 12, everyMs: 50, stallAfter: 3 }));
    await assert.rejects(
      client().request<ArrayBuffer>("/v1/users/a/snapshots/s/download", { raw: true, inactivityMs: 200 }),
      (e: unknown) => e instanceof ApiError && e.code === "TIMEOUT" && /no data/i.test(e.message),
    );
  });

  it("still cancels through the caller's token", async () => {
    vi.stubGlobal("fetch", slowBody({ chunks: 100, everyMs: 50 }));
    const source = new CancellationTokenSource();
    setTimeout(() => source.cancel(), 120);
    await assert.rejects(
      client().request<ArrayBuffer>("/v1/users/a/snapshots/s/download", { raw: true, inactivityMs: 5_000, token: source.token as never }),
      (e: unknown) => e instanceof ApiError && e.code === "CANCELLED",
    );
  });

  it("keeps the request deadline for the headers", async () => {
    vi.stubGlobal("fetch", (_url: string, req: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    );
    await assert.rejects(
      client().request<ArrayBuffer>("/v1/users/a/snapshots/s/download", { raw: true, timeoutMs: 150, inactivityMs: 5_000 }),
      (e: unknown) => e instanceof ApiError && e.code === "TIMEOUT",
    );
  });
});
