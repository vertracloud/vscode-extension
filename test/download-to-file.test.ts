import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import "./vscode-mock";
import { CancellationTokenSource } from "./vscode-mock";
import type * as vscode from "vscode";
import { ApiClient, ApiError } from "../src/api/client";
import { writeThroughTempFile } from "../src/api/download-file";
import { downloadAppToFile, downloadSnapshotToFile } from "../src/api/snapshots";

const MB = 1024 * 1024;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vertra-ext-dl-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const client = (): ApiClient => new ApiClient(async () => "t", "ua");

interface BodyInit2 {
  chunks: number;
  chunkBytes?: number;
  everyMs?: number;
  stallAfter?: number;
  onChunk?: (index: number) => Promise<void> | void;
}

/** `fetch` falso cujo corpo é gerado pedaço a pedaço (nada fica guardado) e que erra o fluxo quando o pedido é abortado, como um real. */
function fakeFetch(init: BodyInit2): { fetch: (url: string, req: RequestInit) => Promise<Response>; sha256: () => string } {
  const hash = createHash("sha256");
  let sent = 0;
  const chunkBytes = init.chunkBytes ?? MB;
  return {
    sha256: () => hash.copy().digest("hex"),
    fetch: async (_url, req) => {
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            req.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
          },
          async pull(controller) {
            if (init.stallAfter !== undefined && sent >= init.stallAfter) {return new Promise<void>(() => undefined);}
            if (sent >= init.chunks) {return controller.close();}
            if (init.everyMs) {await new Promise((resolve) => setTimeout(resolve, init.everyMs));}
            await init.onChunk?.(sent);
            const chunk = new Uint8Array(chunkBytes).fill(sent % 251);
            hash.update(chunk);
            sent++;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200 });
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {hash.update(chunk as Buffer);}
  return hash.digest("hex");
}

describe("downloadSnapshotToFile", () => {
  it("400 MB chegam ao disco com memória constante, antes do fim da resposta, e o arquivo sai idêntico", async () => {
    const total = 400;
    const dest = join(dir, "snapshot.zip");
    let midSize = 0;
    let finalNameBeforeEnd = false;
    const base = process.memoryUsage().rss;
    let peak = 0;
    const server = fakeFetch({
      chunks: total,
      onChunk: async (index) => {
        peak = Math.max(peak, process.memoryUsage().rss - base);
        if (index === 200) {
          const names = await readdir(dir);
          const part = names.find((name) => name.endsWith(".part"));
          if (part) {midSize = (await stat(join(dir, part))).size;}
          finalNameBeforeEnd = names.includes("snapshot.zip");
        }
      },
    });
    vi.stubGlobal("fetch", server.fetch);
    const written = await downloadSnapshotToFile(client(), "a1", "s1", "applications", dest);
    assert.equal(written, total * MB);
    assert.ok(midSize >= 190 * MB, `o temporário tinha ${midSize} bytes na metade da resposta`);
    assert.equal(finalNameBeforeEnd, false);
    assert.ok(peak < 160 * MB, `RSS cresceu ${Math.round(peak / MB)} MB para um arquivo de ${total} MB`);
    assert.equal((await stat(dest)).size, total * MB);
    assert.equal(await sha256File(dest), server.sha256());
    assert.deepEqual(await readdir(dir), ["snapshot.zip"]);
  }, 60_000);

  it("download que para no meio estoura por inatividade, com TIMEOUT, e o sink recebeu só o que chegou", async () => {
    vi.stubGlobal("fetch", fakeFetch({ chunks: 50, chunkBytes: 1024, everyMs: 10, stallAfter: 4 }).fetch);
    let received = 0;
    await assert.rejects(
      client().request<undefined>("/v1/users/a1/snapshots/s1/download", {
        raw: true,
        inactivityMs: 200,
        sink: async (chunk) => void (received += chunk.byteLength),
      }),
      (e: unknown) => e instanceof ApiError && e.code === "TIMEOUT",
    );
    assert.equal(received, 4 * 1024);
  });

  it("cancelar pelo token remove o temporário e mantém o arquivo que já existia", async () => {
    const dest = join(dir, "snapshot.zip");
    await writeFile(dest, "antigo");
    const source = new CancellationTokenSource();
    vi.stubGlobal("fetch", fakeFetch({ chunks: 1000, chunkBytes: 1024, everyMs: 10, onChunk: (i) => { if (i === 5) {source.cancel();} } }).fetch);
    await assert.rejects(
      downloadSnapshotToFile(client(), "a1", "s1", "applications", dest, source.token as unknown as vscode.CancellationToken),
      (e: unknown) => e instanceof ApiError && e.code === "CANCELLED",
    );
    assert.deepEqual(await readdir(dir), ["snapshot.zip"]);
    assert.equal(await readFile(dest, "utf8"), "antigo");
  });

  it("erro da API não cria arquivo", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ code: "SNAPSHOT_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } }));
    await assert.rejects(
      downloadSnapshotToFile(client(), "a1", "s1", "applications", join(dir, "snapshot.zip")),
      (e: unknown) => e instanceof ApiError && e.code === "SNAPSHOT_NOT_FOUND",
    );
    assert.deepEqual(await readdir(dir), []);
  });

  it("falha do disco (destino numa pasta que não existe) sobe como está e não deixa nada", async () => {
    vi.stubGlobal("fetch", fakeFetch({ chunks: 2, chunkBytes: 10 }).fetch);
    await assert.rejects(downloadSnapshotToFile(client(), "a1", "s1", "applications", join(dir, "nao-existe", "x.zip")), /ENOENT/);
    assert.deepEqual(await readdir(dir), []);
  });

  it("um 503 não é repetido com o sink: nenhum byte é escrito duas vezes", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("{}", { status: 503 });
    });
    await assert.rejects(downloadSnapshotToFile(client(), "a1", "s1", "applications", join(dir, "x.zip")));
    assert.equal(calls, 1);
  });
});

describe("downloadAppToFile", () => {
  it("tira o snapshot, segue o job e grava o zip em fluxo", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, req: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${req.method ?? "GET"} ${path}`);
      if (req.method === "POST") {return new Response(JSON.stringify({ response: { job_id: "j1" } }), { status: 202 });}
      if (path.endsWith("/jobs/j1")) {return new Response(JSON.stringify({ response: { id: "j1", kind: "snapshot", resource_id: "a1", status: "ready", snapshot_id: "s9" } }), { status: 200 });}
      return new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 });
    });
    const dest = join(dir, "app.zip");
    let preparing = 0;
    const written = await downloadAppToFile(client(), "a1", dest, { sleep: async () => undefined, onPreparing: () => preparing++ });
    assert.equal(written, 4);
    assert.ok(preparing >= 1);
    assert.equal(calls.at(-1), "GET /v1/users/a1/snapshots/s9/download");
    assert.deepEqual([...(await readFile(dest))], [80, 75, 3, 4]);
    assert.deepEqual(await readdir(dir), ["app.zip"]);
  });
});

describe("writeThroughTempFile", () => {
  it("um erro no meio apaga o temporário e não toca o destino", async () => {
    const dest = join(dir, "snapshot.zip");
    await writeFile(dest, "antigo");
    await assert.rejects(
      writeThroughTempFile(dest, async (sink) => {
        await sink(new Uint8Array(1024));
        throw new ApiError(0, "TIMEOUT", "No data received from the server");
      }),
      (e: unknown) => e instanceof ApiError && e.code === "TIMEOUT",
    );
    assert.deepEqual(await readdir(dir), ["snapshot.zip"]);
    assert.equal(await readFile(dest, "utf8"), "antigo");
  });
});

describe("corpo cortado antes do Content-Length (servidor e fetch reais)", () => {
  let server: Server;
  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(4 * MB) });
      res.write(Buffer.alloc(2 * MB, 7), () => setTimeout(() => res.socket?.destroy(), 20));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const realFetch = globalThis.fetch;
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubGlobal("fetch", (url: string, req?: RequestInit) => realFetch(`${origin}${new URL(url).pathname}${new URL(url).search}`, req));
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("downloadSnapshotToFile falha e não deixa arquivo nem cria o destino", async () => {
    const target = join(dir, "snapshot.zip");
    await assert.rejects(downloadSnapshotToFile(client(), "app-1", "snap-1", "applications", target));
    assert.deepEqual(await readdir(dir), []);
  });

  it("não troca um destino que já existia", async () => {
    const target = join(dir, "snapshot.zip");
    await writeFile(target, "antigo");
    await assert.rejects(downloadSnapshotToFile(client(), "app-1", "snap-1", "applications", target));
    assert.equal(await readFile(target, "utf8"), "antigo");
    assert.deepEqual(await readdir(dir), ["snapshot.zip"]);
  });
});
