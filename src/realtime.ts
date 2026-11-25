import * as vscode from "vscode";
import { readUnlessAborted } from "./abortable-read";
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
const RUN_STARTED = /^run_note:started:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const HIDDEN_MESSAGES = new Set([
  "Loading historical logs",
  "Historical logs loaded",
  "Starting live logs",
  "Attached to live logs",
  "Resuming live logs",
  "Container stopped",
]);
const RUNTIME_LINE_CHANGED =
  /^runtime_note:line_changed:[a-z0-9_-]+:([0-9A-Za-z][0-9A-Za-z._+-]*):([0-9A-Za-z][0-9A-Za-z._+-]*):(?:retired|unavailable|requested)$/;
const PORT_NOT_LISTENING = /^run_note:port_not_listening:(\d{1,5})$/;
const IMAGE_PULLING = /^image_note:pulling:(\d{1,9})$/;
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOY_NOTE_PREFIX = "deploy_note:";
const NOTE_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z (.+)$/;
const DISCARD_REASON = /^[a-z][a-z_]{0,39}$/;
const STEP_TIMEOUT_SECONDS = "900";
const TOTAL_TIMEOUT_SECONDS = "1500";

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

function discardCause(reason: string): string | undefined {
  switch (reason) {
    case "install_oom":
      return vscode.l10n.t("it ran out of memory while installing dependencies");
    case "install_build_oom":
    case "build_oom":
      return vscode.l10n.t("it ran out of memory during the build");
    case "install_failed":
      return vscode.l10n.t("the dependency install failed");
    case "install_build_failed":
      return vscode.l10n.t("the build command failed");
    case "install_build_timeout":
      return vscode.l10n.t("the build went over the time limit");
    case "install_timeout":
      return vscode.l10n.t("the install went over the time limit");
    case "install_shield":
      return vscode.l10n.t("network protection stopped the install");
    case "crashed":
      return vscode.l10n.t("it stopped before it was ready");
    case "unhealthy":
      return vscode.l10n.t("it did not become ready to receive traffic");
    case "timeout":
      return vscode.l10n.t("it did not respond in time");
    default:
      return undefined;
  }
}

function translateDeployNote(message: string): string | undefined {
  const parts = message.split(":");
  const short = (id: string) => id.slice(0, 7).toLowerCase();
  if (parts[1] === "failed" && parts.length === 3 && STRICT_UUID.test(parts[2])) {
    return vscode.l10n.t("Deploy {0} crashed on start.", short(parts[2]));
  }
  if (
    parts[1] === "discarded" &&
    (parts.length === 3 || (parts.length === 4 && DISCARD_REASON.test(parts[3]))) &&
    STRICT_UUID.test(parts[2])
  ) {
    const cause = parts[3] === undefined ? undefined : discardCause(parts[3]);
    if (cause) {
      return vscode.l10n.t("Deploy {0} was discarded: {1}. The previous version is still online.", short(parts[2]), cause);
    }
    return vscode.l10n.t("Deploy {0} was discarded; the previous version is still online.", short(parts[2]));
  }
  if (parts[1] === "recreated" && (parts.length === 2 || (parts.length === 3 && DISCARD_REASON.test(parts[2])))) {
    switch (parts[2]) {
      case "plan_memory":
        return vscode.l10n.t("Restarted without the zero-downtime deploy: the plan has no free memory to run both versions at once.");
      case "recreate_required":
        return vscode.l10n.t("Restarted without the zero-downtime deploy: the change required recreating the app.");
      default:
        return vscode.l10n.t("Restarted without the zero-downtime deploy.");
    }
  }
  if (parts[1] === "rollback" && parts.length === 4 && STRICT_UUID.test(parts[2]) && STRICT_UUID.test(parts[3])) {
    return vscode.l10n.t("Deploy {0} crashed on start. We went back to {1}.", short(parts[2]), short(parts[3]));
  }
  return undefined;
}

function translateSystem(message: string): string | undefined {
  if (message === "Connected to realtime log stream") {return vscode.l10n.t("Connected in real time");}
  if (message === "No logs found") {return vscode.l10n.t("No logs found");}
  if (message === "app_restarted") {return vscode.l10n.t("Application restarted");}
  if (message === "install_note:started") {
    return vscode.l10n.t("Dependency install started");
  }
  if (message.startsWith(DEPLOY_NOTE_PREFIX)) {return translateDeployNote(message);}
  if (message === "install_note:done") {return vscode.l10n.t("Installation finished");}

  const runtime = RUNTIME_LINE_CHANGED.exec(message);
  if (runtime) {return vscode.l10n.t("Runtime changed from {0} to {1}", runtime[1], runtime[2]);}

  const notListening = PORT_NOT_LISTENING.exec(message);
  if (notListening) {
    return vscode.l10n.t(
      "The app started but did not listen on port {0}. Make sure it listens on that port on all interfaces.",
      notListening[1],
    );
  }

  const pulling = IMAGE_PULLING.exec(message);
  if (pulling) {return vscode.l10n.t("Pulling the image ({0}%)", Math.min(100, Number(pulling[1])));}
  if (message === "image_note:creating") {return vscode.l10n.t("Creating the container");}
  if (message === "image_note:starting") {return vscode.l10n.t("Starting the container");}
  if (message === "image_note:waiting_port") {return vscode.l10n.t("Waiting for the app to open its port");}

  const install = /^install_note:(oom|failed|build_failed|build_oom|build_timeout|timeout|shield)(?::(\d+))?$/.exec(message);
  if (install) {
    switch (install[1]) {
      case "oom":
        return vscode.l10n.t("Dependency install stopped — plan memory exhausted.");
      case "failed":
        return vscode.l10n.t("Dependency install failed (exit code {0}).", install[2] ?? "?");
      case "build_failed":
        return vscode.l10n.t("The build command failed; the app was not started.");
      case "build_oom":
        return vscode.l10n.t("The build command ran out of memory and was stopped. Raise the app memory or reduce what the build processes.");
      case "build_timeout":
        return vscode.l10n.t("The build exceeded the 10-minute time limit.");
      case "timeout":
        if (install[2] === STEP_TIMEOUT_SECONDS) {
          return vscode.l10n.t("A dependency install step exceeded the 15-minute limit.");
        }
        if (install[2] === TOTAL_TIMEOUT_SECONDS) {
          return vscode.l10n.t("The installation exceeded the 25-minute total time limit.");
        }
        return vscode.l10n.t("The installation exceeded the time limit.");
      default:
        return vscode.l10n.t("Build stopped by network protection — traffic above the allowance during the deploy.");
    }
  }

  const restart = /^restart_note:(\w+)$/.exec(message);
  if (restart) {
    if (restart[1] === "auto_restart_disabled") {return vscode.l10n.t("Auto-restart is turned off for this app.");}
    if (restart[1] === "crash_loop") {
      return vscode.l10n.t("Crash loop detected — auto-restart temporarily suspended.");
    }
    if (restart[1] === "oom_killed") {return vscode.l10n.t("App stopped — plan memory exhausted.");}
    if (restart[1] === "unsupported_node") {
      return vscode.l10n.t(
        "App stopped — the runtime's Node.js version is not supported by this project. Change the runtime version in the app settings.",
      );
    }
    return vscode.l10n.t("Application restarted automatically.");
  }

  const shield = /^shield_note:(\w+):(in|out)$/.exec(message);
  if (shield) {
    const direction =
      shield[2] === "in" ? vscode.l10n.t("inbound") : vscode.l10n.t("outbound");
    if (shield[1] === "rate_limit") {
      return vscode.l10n.t("Vertra Shield: app stopped for exceeding {0} request limits.", direction);
    }
    return vscode.l10n.t("Vertra Shield: app stopped for an {0} traffic burst.", direction);
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
    if (event.event === "next_logs") {
      const label = vscode.l10n.t("[New version]");
      for (const line of event.data.replace(ANSI, "").split("\n")) {
        if (line.length > 0) {channel.appendLine(`${label} ${line}`);}
      }
      return;
    }
    if (event.event !== "system") {return;}
    const message = NOTE_STAMP.exec(event.data)?.[1] ?? event.data;
    if (HIDDEN_MESSAGES.has(message) || RUN_STARTED.test(message)) {return;}
    const translated = translateSystem(message);
    if (translated) {
      channel.appendLine(`[Vertra] ${translated}`);
      return;
    }
    channel.appendLine(event.data);
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
      let reader: ReadableStreamDefaultReader<SseEvent> | undefined;
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
        reader = body.pipeThrough(parseSse()).getReader();
        for (;;) {
          const { done, value } = await readUnlessAborted(reader, controller.signal);
          if (done) {break;}
          healthy = true;
          arm();
          this.handle(channel, value);
        }
      } catch (err) {
        void reader?.cancel().catch(() => undefined);
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
