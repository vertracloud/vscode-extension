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
  it("install_note:started não limpa o canal: o histórico continua", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: logs\ndata: \u001b[32mrodando\u001b[0m\n\n");
    await tick();
    opened[0].push("event: system\ndata: install_note:started\n\n");
    await tick();

    assert.deepEqual(channel.lines, ["rodando", "[Vertra] Dependency install started"]);
    manager.dispose();
  });

  it("install_note:done vira o aviso de instalação concluída", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: install_note:done\n\n");
    await tick();

    assert.deepEqual(channel.lines, ["[Vertra] Installation finished"]);
    manager.dispose();
  });

  it("linha de log do app que imita sentinela ou fim de fase segue como log comum", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    const nonce = "0123456789abcdef0123456789abcdef";
    opened[0].push(`event: logs\ndata: 2026-11-22T10:00:00Z [vertra] phase=running ${nonce}\n\n`);
    opened[0].push("event: logs\ndata: > install_note:done\n\n");
    await tick();

    assert.deepEqual(channel.lines, [`2026-11-22T10:00:00Z [vertra] phase=running ${nonce}`, "> install_note:done"]);
    manager.dispose();
  });

  it("sentinela desconhecida ou malformada sai crua e só o marcador de início da execução some", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: future_note:something:42\n\n");
    opened[0].push("event: system\ndata: run_note:started:2026-11-22T10:00:00Z\n\n");
    opened[0].push("event: system\ndata: 2026-11-22T10:00:01Z run_note:started:2026-11-22T10:00:00.123Z\n\n");
    opened[0].push("event: system\ndata: run_note:started:soon\n\n");
    opened[0].push("event: system\ndata: Connection Closed\n\n");
    await tick();

    assert.deepEqual(channel.lines, ["future_note:something:42", "run_note:started:soon", "Connection Closed"]);
    manager.dispose();
  });

  it("run_note:port_not_listening vira aviso com a porta e porta inválida sai crua", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: run_note:port_not_listening:3000\n\n");
    opened[0].push("event: system\ndata: run_note:port_not_listening:abc\n\n");
    opened[0].push("event: system\ndata: run_note:port_not_listening\n\n");
    opened[0].push("event: system\ndata: run_note:port_not_listening:3000:x\n\n");
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] The app started but did not listen on port 3000. Make sure it listens on that port on all interfaces.",
      "run_note:port_not_listening:abc",
      "run_note:port_not_listening",
      "run_note:port_not_listening:3000:x",
    ]);
    manager.dispose();
  });

  it("runtime_note:line_changed vira aviso e formato inválido sai cru", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: runtime_note:line_changed:nodejs:22.23.5:26.1.0:retired\n\n");
    opened[0].push("event: system\ndata: runtime_note:line_changed:nodejs:22.23.5:26.1.0:whatever\n\n");
    opened[0].push("event: system\ndata: runtime_note:line_changed:nodejs:22.23.5\n\n");
    opened[0].push("event: system\ndata: runtime_note:line_changed:nodejs:a b:26.1.0:retired\n\n");
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] Runtime changed from 22.23.5 to 26.1.0",
      "runtime_note:line_changed:nodejs:22.23.5:26.1.0:whatever",
      "runtime_note:line_changed:nodejs:22.23.5",
      "runtime_note:line_changed:nodejs:a b:26.1.0:retired",
    ]);
    manager.dispose();
  });

  it("install_note:timeout nunca sai cru e distingue etapa, prazo total e formato antigo", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: install_note:timeout:900\n\n");
    opened[0].push("event: system\ndata: install_note:timeout:1500\n\n");
    opened[0].push("event: system\ndata: install_note:timeout:777\n\n");
    opened[0].push("event: system\ndata: install_note:timeout\n\n");
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] A dependency install step exceeded the 15-minute limit.",
      "[Vertra] The installation exceeded the 25-minute total time limit.",
      "[Vertra] The installation exceeded the time limit.",
      "[Vertra] The installation exceeded the time limit.",
    ]);
    manager.dispose();
  });

  it("deploy_note traduz só com UUID estrito em cada id; outra forma sai como linha comum", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    for (const note of [
      `deploy_note:failed:${a}`,
      `deploy_note:discarded:${a}`,
      `deploy_note:rollback:${a}:${b}`,
      "deploy_note:failed:abc",
      `deploy_note:rollback:${a}:xyz`,
      `deploy_note:failed:${a}:extra`,
    ]) {
      opened[0].push(`event: system\ndata: ${note}\n\n`);
    }
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] Deploy 1111111 crashed on start.",
      "[Vertra] Deploy 1111111 was discarded; the previous version is still online.",
      "[Vertra] Deploy 1111111 crashed on start. We went back to 2222222.",
      "deploy_note:failed:abc",
      `deploy_note:rollback:${a}:xyz`,
      `deploy_note:failed:${a}:extra`,
    ]);
    manager.dispose();
  });

  it("nota reenviada no início da conexão chega com horário ISO e é traduzida sem ele", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    const a = "11111111-1111-4111-8111-111111111111";
    for (const note of [
      "2026-11-24T12:00:00.000Z install_note:done",
      "2026-11-24T12:00:01Z install_note:build_oom",
      "2026-11-24T12:00:02.123456789Z run_note:port_not_listening:3000",
      "2026-11-24T12:00:03.000Z restart_note:crash_loop",
      `2026-11-24T12:00:04.000Z deploy_note:failed:${a}`,
      "2026-11-24T12:00:05.000Z future_note:something",
      "2026-11-24T12:00:06.000Z Connection Closed",
    ]) {
      opened[0].push(`event: system\ndata: ${note}\n\n`);
    }
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] Installation finished",
      "[Vertra] The build command ran out of memory and was stopped. Raise the app memory or reduce what the build processes.",
      "[Vertra] The app started but did not listen on port 3000. Make sure it listens on that port on all interfaces.",
      "[Vertra] Crash loop detected — auto-restart temporarily suspended.",
      "[Vertra] Deploy 1111111 crashed on start.",
      "2026-11-24T12:00:05.000Z future_note:something",
      "2026-11-24T12:00:06.000Z Connection Closed",
    ]);
    manager.dispose();
  });

  it("horário ISO só é removido em system: linha de log com horário segue intacta", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: logs\ndata: 2026-11-24T12:00:00.000Z install_note:done\n\n");
    await tick();

    assert.deepEqual(channel.lines, ["2026-11-24T12:00:00.000Z install_note:done"]);
    manager.dispose();
  });

  it("install_note:build_oom ao vivo vira o aviso de falta de memória no build", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: install_note:build_oom\n\n");
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] The build command ran out of memory and was stopped. Raise the app memory or reduce what the build processes.",
    ]);
    manager.dispose();
  });

  it("deploy_note:discarded traduz o motivo conhecido e cai na mensagem sem motivo nos demais", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    const a = "11111111-1111-4111-8111-111111111111";
    for (const note of [
      `deploy_note:discarded:${a}:install_build_oom`,
      `deploy_note:discarded:${a}:unhealthy`,
      `2026-11-24T12:00:00.000Z deploy_note:discarded:${a}:install_shield`,
      `deploy_note:discarded:${a}:some_future_reason`,
      `deploy_note:discarded:${a}:Bad-Reason`,
      `deploy_note:discarded:${a}:crashed:extra`,
    ]) {
      opened[0].push(`event: system\ndata: ${note}\n\n`);
    }
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] Deploy 1111111 was discarded: it ran out of memory during the build. The previous version is still online.",
      "[Vertra] Deploy 1111111 was discarded: it did not become ready to receive traffic. The previous version is still online.",
      "[Vertra] Deploy 1111111 was discarded: network protection stopped the install. The previous version is still online.",
      "[Vertra] Deploy 1111111 was discarded; the previous version is still online.",
      `deploy_note:discarded:${a}:Bad-Reason`,
      `deploy_note:discarded:${a}:crashed:extra`,
    ]);
    manager.dispose();
  });

  it("next_logs sai rotulado como da nova versão, linha a linha, sem ANSI", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: logs\ndata: versão atual\n\n");
    opened[0].push("event: next_logs\ndata: \u001b[32mnpm install\u001b[0m\ndata: added 3 packages\n\n");
    await tick();

    assert.deepEqual(channel.lines, ["versão atual", "[New version] npm install", "[New version] added 3 packages"]);
    manager.dispose();
  });

  it("mensagens de controle do stream somem e conexão e histórico vazio viram aviso", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    for (const message of [
      "Connected to realtime log stream",
      "Loading historical logs",
      "No logs found",
      "Historical logs loaded",
      "Starting live logs",
      "Attached to live logs",
      "Resuming live logs",
      "2026-11-24T12:00:00Z Container stopped",
    ]) {
      opened[0].push(`event: system\ndata: ${message}\n\n`);
    }
    await tick();

    assert.deepEqual(channel.lines, ["[Vertra] Connected in real time", "[Vertra] No logs found"]);
    manager.dispose();
  });

  it("deploy_note:recreated traduz cada motivo, cai no texto genérico e formato inválido sai cru", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    for (const note of [
      "deploy_note:recreated:plan_memory",
      "deploy_note:recreated:host_memory",
      "2026-11-24T12:00:00Z deploy_note:recreated:recreate_required",
      "deploy_note:recreated:brand_new_reason",
      "deploy_note:recreated",
      "deploy_note:recreated:Bad-Reason",
      "deploy_note:recreated:a:b",
    ]) {
      opened[0].push(`event: system\ndata: ${note}\n\n`);
    }
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] Restarted without the zero-downtime deploy: the plan has no free memory to run both versions at once.",
      "[Vertra] Restarted without the zero-downtime deploy: the server had no free memory.",
      "[Vertra] Restarted without the zero-downtime deploy: the change required recreating the app.",
      "[Vertra] Restarted without the zero-downtime deploy.",
      "[Vertra] Restarted without the zero-downtime deploy.",
      "deploy_note:recreated:Bad-Reason",
      "deploy_note:recreated:a:b",
    ]);
    manager.dispose();
  });

  it("restart_note:unsupported_node vira aviso do Node.js do runtime", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: restart_note:unsupported_node\n\n");
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] App stopped — the runtime's Node.js version is not supported by this project. Change the runtime version in the app settings.",
    ]);
    manager.dispose();
  });

  it("deploy sem queda lê na ordem: versão atual, nova versão marcada, descarte e métricas fora", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    const a = "11111111-1111-4111-8111-111111111111";
    opened[0].push("event: logs\ndata: serving\n\n");
    opened[0].push("event: system\ndata: install_note:started\n\n");
    opened[0].push("event: next_logs\ndata: npm ci\n\n");
    opened[0].push('event: next_metrics\ndata: {"cpu_percent":1}\n\n');
    opened[0].push(`event: system\ndata: deploy_note:discarded:${a}:install_oom\n\n`);
    await tick();

    assert.deepEqual(channel.lines, [
      "serving",
      "[Vertra] Dependency install started",
      "[New version] npm ci",
      "[Vertra] Deploy 1111111 was discarded: it ran out of memory while installing dependencies. The previous version is still online.",
    ]);
    manager.dispose();
  });

  it("metrics é ignorado e a conexão não pede metrics=true", async () => {
    const queries: unknown[] = [];
    const base = makeClient();
    const client: StreamClient = {
      stream: (path, opts) => {
        queries.push(opts.query);
        return base.client.stream(path, opts);
      },
    };
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    base.opened[0].push('event: metrics\ndata: {"cpu_percent":1}\n\n');
    base.opened[0].push("event: heartbeat\ndata: \n\n");
    base.opened[0].push("event: logs\ndata: ok\n\n");
    await tick();

    assert.deepEqual(channel.lines, ["ok"]);
    assert.ok(queries.every((q) => q === undefined || !("metrics" in (q as object))));
    manager.dispose();
  });

  it("image_note:pulling aceita até 9 dígitos e corta em 100", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    opened[0].push("event: system\ndata: image_note:pulling:999999999\n\n");
    opened[0].push("event: system\ndata: image_note:pulling:1234567890\n\n");
    await tick();

    assert.deepEqual(channel.lines, ["[Vertra] Pulling the image (100%)", "image_note:pulling:1234567890"]);
    manager.dispose();
  });

  it("traduz o catálogo de sentinelas de imagem e de auto-restart", async () => {
    const { client, opened } = makeClient();
    const { manager, channel } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    for (const note of [
      "image_note:pulling:42",
      "image_note:pulling:abc",
      "image_note:creating",
      "image_note:starting",
      "image_note:waiting_port",
      "restart_note:auto_restart_disabled",
    ]) {
      opened[0].push(`event: system\ndata: ${note}\n\n`);
    }
    await tick();

    assert.deepEqual(channel.lines, [
      "[Vertra] Pulling the image (42%)",
      "image_note:pulling:abc",
      "[Vertra] Creating the container",
      "[Vertra] Starting the container",
      "[Vertra] Waiting for the app to open its port",
      "[Vertra] Auto-restart is turned off for this app.",
    ]);
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

  it("reconecta depois do tempo parado mesmo quando o corpo do stream não recebe o abort", async () => {
    vi.useFakeTimers();
    const { client, opened } = makeClient();
    const { manager } = makeManager(client);
    manager.toggle("app1", "app");
    await vi.advanceTimersByTimeAsync(0);

    opened[0].push("event: logs\ndata: a\n\n");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(3000);

    assert.equal(opened.length, 2);
    assert.equal(manager.isActive("app1"), true);
    manager.dispose();
  });

  it("toggle off libera o corpo mesmo quando ele não recebe o abort", async () => {
    let cancelled = false;
    const client: StreamClient = {
      stream: async () =>
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
    };
    const { manager } = makeManager(client);
    manager.toggle("app1", "app");
    await tick();

    manager.toggle("app1", "app");
    await tick();

    assert.equal(cancelled, true);
    manager.dispose();
  });
});
