import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { RealtimeManager, type StreamClient } from "../src/realtime";
import { createFakeOutputChannel, type FakeOutputChannel } from "./vscode-mock";

interface Opened {
  signal: AbortSignal;
  push(text: string): void;
  close(): void;
}

function makeClient(): { client: StreamClient; opened: Opened[] } {
  const opened: Opened[] = [];
  const client: StreamClient = {
    stream: async (_path, opts) => {
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      opened.push({
        signal: opts.signal,
        push: (text) => controller.enqueue(encoder.encode(text)),
        close: () => controller.close(),
      });
      return stream;
    },
  };
  return { client, opened };
}

function makeManager(client: StreamClient): { manager: RealtimeManager; channel: FakeOutputChannel } {
  const channel = createFakeOutputChannel("Vertra Cloud: app");
  const manager = new RealtimeManager(client, () => channel);
  return { manager, channel };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeManager", () => {
  it("manda evento logs para o canal e limpa em install_note:started", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: logs\ndata: \u001b[32mrodando\u001b[0m\n\n");
    await tick();
    assert.deepEqual(channel.lines, ["rodando"]);

    opened[0].push("event: system\ndata: install_note:started\n\n");
    await tick();
    assert.equal(channel.lines.length, 1);
    assert.match(channel.lines[0], /^\[Vertra\] /);

    manager.dispose();
  });

  it("traduz sentinela sem vazar o texto cru", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: shield_note:burst:out\n\n");
    opened[0].push("event: system\ndata: install_note:failed:137\n\n");
    opened[0].push("event: heartbeat\ndata: 1\n\n");
    await tick();

    assert.equal(channel.lines.length, 2);
    for (const line of channel.lines) {
      assert.ok(line.startsWith("[Vertra] "));
      assert.ok(!line.includes("install_note:"));
      assert.ok(!line.includes("shield_note:"));
    }
    assert.ok(channel.lines[1].includes("137"));

    manager.dispose();
  });

  it("não reconecta quando a primeira conexão falha com 401", async () => {
    const client: StreamClient = {
      stream: async () => {
        throw Object.assign(new Error("unauthorized"), { status: 401, code: "API_KEY_INVALID" });
      },
    };
    const { manager, channel } = makeManager(client);
    const changes: string[] = [];
    manager.onDidChange((id) => changes.push(id));
    manager.toggle("app1", "app");
    await tick();
    await tick();

    assert.equal(manager.isActive("app1"), false);
    assert.deepEqual(changes, ["app1", "app1"]);
    assert.equal(channel.lines.length, 1);
    manager.dispose();
  });

  it("reconecta quando o stream fecha depois de um evento", async () => {
    vi.useFakeTimers();
    const { client, opened } = makeClient();
    const { manager } = makeManager(client);
    manager.toggle("app1", "app");
    await vi.advanceTimersByTimeAsync(0);

    opened[0].push("event: logs\ndata: a\n\n");
    await vi.advanceTimersByTimeAsync(0);
    opened[0].close();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    assert.equal(opened.length, 2);
    assert.equal(manager.isActive("app1"), true);
    manager.dispose();
  });

  it("zera o orçamento de reconexão depois de cada conexão saudável", async () => {
    vi.useFakeTimers();
    const { client, opened } = makeClient();
    const { manager } = makeManager(client);
    manager.toggle("app1", "app");
    await vi.advanceTimersByTimeAsync(0);

    for (let round = 0; round < 7; round++) {
      opened[round].push("event: logs\ndata: a\n\n");
      await vi.advanceTimersByTimeAsync(0);
      opened[round].close();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
    }

    assert.equal(opened.length, 8);
    assert.equal(manager.isActive("app1"), true);
    manager.dispose();
  });

  it("toggle off aborta o signal da conexão", async () => {
    const { client, opened } = makeClient();
    const { manager } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();
    assert.equal(opened[0].signal.aborted, false);

    manager.toggle("app1", "app");
    assert.equal(opened[0].signal.aborted, true);
    assert.equal(manager.isActive("app1"), false);
    manager.dispose();
  });

  it("stopAll encerra todas as conexões e dispose é idempotente", async () => {
    const { client, opened } = makeClient();
    const channel = createFakeOutputChannel("c");
    const manager = new RealtimeManager(client, () => channel);
    manager.toggle("app1", "app");
    manager.toggle("app2", "app");
    await tick();

    manager.stopAll();
    assert.equal(manager.isActive("app1"), false);
    assert.equal(manager.isActive("app2"), false);
    assert.ok(opened.every((o) => o.signal.aborted));

    manager.dispose();
    manager.dispose();
  });
});
