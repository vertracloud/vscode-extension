import * as vscode from "vscode";
import { parseSse, type SseEvent } from "./sse";

export interface StreamClient {
  stream(
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; signal: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
}

const IDLE_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;
// OutputChannel não renderiza escape ANSI: sem remover, cada linha colorida do app chega suja.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

interface Connection {
  controller: AbortController;
  stopped: boolean;
  idleFired: boolean;
}

function isFatalStatus(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 || status === 429;
}

function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.min(MAX_BACKOFF_MS, base + Math.random() * 1000);
}

function translateSystem(message: string): string | undefined {
  if (message === "app_restarted") {return vscode.l10n.t("Application restarted");}
  if (message === "install_note:started") {
    return vscode.l10n.t("Dependency install started");
  }

  const install = /^install_note:(oom|failed|build_failed|build_timeout|timeout|shield)(?::(\d+))?$/.exec(message);
  if (install) {
    switch (install[1]) {
      case "oom":
        return vscode.l10n.t("Dependency install stopped — plan memory exhausted.");
      case "failed":
        return vscode.l10n.t("Dependency install failed (exit code {0}).", install[2] ?? "?");
      case "build_failed":
        return vscode.l10n.t("The build command failed; the app was not started.");
      case "build_timeout":
        return vscode.l10n.t("The build exceeded the 10-minute time limit.");
      case "timeout":
        return vscode.l10n.t("The installation exceeded the time limit.");
      default:
        return vscode.l10n.t("Build stopped by network protection — traffic above the allowance during the deploy.");
    }
  }

  const restart = /^restart_note:(\w+)$/.exec(message);
  if (restart) {
    if (restart[1] === "crash_loop") {
      return vscode.l10n.t("Crash loop detected — auto-restart temporarily suspended.");
    }
    if (restart[1] === "oom_killed") {return vscode.l10n.t("App stopped — plan memory exhausted.");}
    return vscode.l10n.t("Application restarted automatically.");
  }

  const shield = /^shield_note:(\w+):(in|out)$/.exec(message);
  if (shield) {
    const direction =
      shield[2] === "in" ? vscode.l10n.t("inbound") : vscode.l10n.t("outbound");
    if (shield[1] === "rate_limit") {
      return vscode.l10n.t("Vertra Shield: app stopped for exceeding {0} request limits.", direction);
    }
    return vscode.l10n.t("Vertra Shield: app stopped for a {0} traffic burst.", direction);
  }

  return undefined;
}

export class RealtimeManager {
  private readonly connections = new Map<string, Connection>();
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly client: StreamClient,
    private readonly getChannel: (appId: string, appName: string) => vscode.OutputChannel,
  ) {}

  isActive(appId: string): boolean {
    return this.connections.has(appId);
  }

  toggle(appId: string, appName: string): void {
    if (this.isActive(appId)) {
      this.stop(appId);
      return;
    }
    const connection: Connection = {
      controller: new AbortController(),
      stopped: false,
      idleFired: false,
    };
    this.connections.set(appId, connection);
    this.emitter.fire(appId);
    void this.run(appId, appName, connection);
  }

  stop(appId: string): void {
    const connection = this.connections.get(appId);
    if (!connection) {return;}
    connection.stopped = true;
    connection.controller.abort();
    this.connections.delete(appId);
    this.emitter.fire(appId);
  }

  stopAll(): void {
    for (const appId of [...this.connections.keys()]) {this.stop(appId);}
  }

  dispose(): void {
    this.stopAll();
    this.emitter.dispose();
  }

  private finish(appId: string, connection: Connection, channel: vscode.OutputChannel, note?: string): void {
    if (note) {channel.appendLine(`[Vertra] ${note}`);}
    if (connection.stopped) {return;}
    connection.stopped = true;
    if (this.connections.get(appId) === connection) {
      this.connections.delete(appId);
      this.emitter.fire(appId);
    }
  }

  private handle(channel: vscode.OutputChannel, event: SseEvent): void {
    if (event.event === "logs") {
      channel.appendLine(event.data.replace(ANSI, ""));
      return;
    }
    if (event.event !== "system") {return;}
    if (event.data === "install_note:started") {channel.clear();}
    const translated = translateSystem(event.data);
    channel.appendLine(translated ? `[Vertra] ${translated}` : event.data);
  }

  private async run(appId: string, appName: string, connection: Connection): Promise<void> {
    const channel = this.getChannel(appId, appName);
    let attempt = 0;

    while (!connection.stopped) {
      const controller = new AbortController();
      connection.controller = controller;
      connection.idleFired = false;
      let healthy = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (idleTimer) {clearTimeout(idleTimer);}
        idleTimer = setTimeout(() => {
          connection.idleFired = true;
          controller.abort();
        }, IDLE_TIMEOUT_MS);
      };

      try {
        const body = await this.client.stream(`/v1/apps/${appId}/realtime`, {
          signal: controller.signal,
        });
        arm();
        const reader = body.pipeThrough(parseSse()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {break;}
          healthy = true;
          arm();
          this.handle(channel, value);
        }
      } catch (err) {
        if (connection.stopped) {return;}
        if (isFatalStatus(err)) {
          this.finish(appId, connection, channel, vscode.l10n.t("Live logs stopped: access denied by the server."));
          return;
        }
      } finally {
        if (idleTimer) {clearTimeout(idleTimer);}
      }

      if (connection.stopped) {return;}
      // Uma conexão que chegou a receber evento zera o orçamento: sem isso, cinco quedas
      // espalhadas por uma sessão longa encerrariam o stream.
      if (healthy) {attempt = 0;}
      if (!healthy && !connection.idleFired) {
        this.finish(appId, connection, channel, vscode.l10n.t("Live logs stopped: could not connect."));
        return;
      }
      if (attempt >= MAX_ATTEMPTS - 1) {
        this.finish(appId, connection, channel, vscode.l10n.t("Live logs stopped after too many reconnection attempts."));
        return;
      }
      const wait = backoffMs(attempt);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
