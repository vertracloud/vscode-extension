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

  describe("when the body stream never delivers the abort", () => {
    const HUNG = Symbol("hung");

    function deafBody(): (url: string, req: RequestInit) => Promise<Response> {
      return async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        });
        return new Response(body, { status: 200 });
      };
    }

    async function outcome(promise: Promise<unknown>, ms: number): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hung = new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(HUNG), ms);
      });
      const settled = promise.then(
        (value) => value,
        (error: unknown) => error,
      );
      try {
        return await Promise.race([settled, hung]);
      } finally {
        clearTimeout(timer);
      }
    }

    it("still ends with CANCELLED when the caller's token fires", async () => {
      vi.stubGlobal("fetch", deafBody());
      const source = new CancellationTokenSource();
      setTimeout(() => source.cancel(), 50);
      const result = await outcome(
        client().request<ArrayBuffer>("/v1/users/a/snapshots/s/download", { raw: true, inactivityMs: 5_000, token: source.token as never }),
        1_500,
      );
      assert.ok(result instanceof ApiError && result.code === "CANCELLED", `got ${String(result)}`);
    });

    it("still ends with TIMEOUT when no byte arrives within the inactivity window", async () => {
      vi.stubGlobal("fetch", deafBody());
      const result = await outcome(
        client().request<ArrayBuffer>("/v1/users/a/snapshots/s/download", { raw: true, inactivityMs: 100 }),
        1_500,
      );
      assert.ok(result instanceof ApiError && result.code === "TIMEOUT" && /no data/i.test(result.message), `got ${String(result)}`);
    });

    it("ends the sink download the same way", async () => {
      vi.stubGlobal("fetch", deafBody());
      const written: number[] = [];
      const result = await outcome(
        client().request("/v1/users/a/snapshots/s/download", {
          raw: true,
          inactivityMs: 100,
          sink: async (chunk) => void written.push(chunk.byteLength),
        }),
        1_500,
      );
      assert.ok(result instanceof ApiError && result.code === "TIMEOUT", `got ${String(result)}`);
      assert.deepEqual(written, [1]);
    });
  });
});
