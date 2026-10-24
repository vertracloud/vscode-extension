import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { readImageLog } from "../src/images/logs";

const enc = new TextEncoder();

function streamOf(chunks: string[], opts: { hang?: boolean; signal?: AbortSignal; failWith?: Error } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
        return;
      }
      if (opts.failWith) {
        controller.error(opts.failWith);
        return;
      }
      if (opts.hang) {
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {resolve();}
          opts.signal?.addEventListener("abort", () => resolve());
        });
        controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      controller.close();
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readImageLog", () => {
  it("emits one line per log event, strips ANSI and ends when the stream ends", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const result = await readImageLog(
      streamOf(["event: log\ndata: Step 1/2 : FROM node\n\n", "event: log\ndata: \u001b[31mred\u001b[0m\n\n"]),
      { controller, onLine: (l) => lines.push(l) },
    );
    assert.equal(result, "ended");
    assert.deepEqual(lines, ["Step 1/2 : FROM node", "red"]);
  });

  it("handles events split across chunks and unnamed events", async () => {
    const lines: string[] = [];
    const result = await readImageLog(streamOf(["event: lo", "g\ndata: a\n", "\ndata: b\n\n"]), {
      controller: new AbortController(),
      onLine: (l) => lines.push(l),
    });
    assert.equal(result, "ended");
    assert.deepEqual(lines, ["a", "b"]);
  });

  it("ignores events that are not log lines and keep-alive comments", async () => {
    const lines: string[] = [];
    await readImageLog(streamOf([": keep-alive\n\n", "event: heartbeat\ndata: x\n\n", "event: log\ndata: kept\n\n"]), {
      controller: new AbortController(),
      onLine: (l) => lines.push(l),
    });
    assert.deepEqual(lines, ["kept"]);
  });

  it("stops after the idle time when the build is not running", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const controller = new AbortController();
    const promise = readImageLog(streamOf(["event: log\ndata: history\n\n"], { hang: true, signal: controller.signal }), {
      controller,
      idleMs: 3000,
      onLine: (l) => lines.push(l),
    });
    await vi.advanceTimersByTimeAsync(3100);
    assert.equal(await promise, "idle");
    assert.deepEqual(lines, ["history"]);
  });

  it("keeps following while lines arrive within the idle time", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(enc.encode("event: log\ndata: one\n\n"));
        await gate;
        c.enqueue(enc.encode("event: log\ndata: two\n\n"));
        c.close();
      },
    });
    const lines: string[] = [];
    const promise = readImageLog(body, { controller, idleMs: 3000, onLine: (l) => lines.push(l) });
    await vi.advanceTimersByTimeAsync(2000);
    release();
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(await promise, "ended");
    assert.deepEqual(lines, ["one", "two"]);
  });

  it("returns cancelled when the user aborts", async () => {
    const controller = new AbortController();
    const promise = readImageLog(streamOf([], { hang: true, signal: controller.signal }), { controller, onLine: () => {} });
    controller.abort();
    assert.equal(await promise, "cancelled");
  });

  it("returns interrupted when the connection fails midway", async () => {
    const result = await readImageLog(streamOf(["event: log\ndata: a\n\n"], { failWith: new Error("socket closed") }), {
      controller: new AbortController(),
      onLine: () => {},
    });
    assert.equal(result, "interrupted");
  });
});
