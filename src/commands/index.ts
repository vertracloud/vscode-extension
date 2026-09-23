import * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import type { Session } from "../auth";
import type { AppEntry, DbEntry, Store } from "../state";
import type { ProjectLinks } from "../project/link";
import type { RealtimeManager } from "../realtime";
import { describeError, statusLabel, type ApiErrorLike } from "../l10n";
import type { CommandDeps } from "./deps";

export const DASHBOARD_URL = "https://vertracloud.app/dashboard";
export const API_KEYS_URL = "https://vertracloud.app/dashboard/settings/api-key";
export const PLANS_URL = "https://vertracloud.app/pricing";
export const DOCS_URL = "https://docs.vertracloud.app";

function toErrorLike(err: unknown): ApiErrorLike {
  if (err && typeof err === "object" && "code" in err) {return err as ApiErrorLike;}
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
}

export function openUrl(url: string): void {
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

export function appIdOf(arg: unknown): string | undefined {
  if (typeof arg === "string") {return arg;}
  if (!arg || typeof arg !== "object") {return undefined;}
  const node = arg as {
    kind?: string;
    appId?: unknown;
    app?: { id?: unknown };
    link?: { appId?: unknown };
  };
  if (node.kind === "app" || node.kind === "appInfo") {
    if (typeof node.appId === "string") {return node.appId;}
    if (typeof node.app?.id === "string") {return node.app.id;}
  }
  if (node.kind === "root" && typeof node.link?.appId === "string") {return node.link.appId;}
  return undefined;
}

function dbIdOf(arg: unknown): string | undefined {
  if (typeof arg === "string") {return arg;}
  if (!arg || typeof arg !== "object") {return undefined;}
  const node = arg as { kind?: string; db?: { id?: unknown } };
  if (node.kind === "db" && typeof node.db?.id === "string") {return node.db.id;}
  return undefined;
}

export function workspaceIdOf(arg: unknown): string | undefined {
  if (typeof arg === "string") {return arg;}
  if (!arg || typeof arg !== "object") {return undefined;}
  const node = arg as { kind?: string; id?: unknown; workspaceId?: unknown };
  if (node.kind === "workspace" && typeof node.id === "string") {return node.id;}
  if (typeof node.workspaceId === "string") {return node.workspaceId;}
  return undefined;
}

function appStatus(entry: AppEntry): "up" | "down" | "installing" {
  if (entry.status?.installing) {return "installing";}
  if (entry.status) {return entry.status.running ? "up" : "down";}
  return entry.app.status === "up" ? "up" : "down";
}

export interface DepsParts {
  client: ApiClient;
  session: Session;
  store: Store;
  links: ProjectLinks;
  realtime: RealtimeManager;
  refreshViews(): void;
}

export interface Deps extends CommandDeps {
  disposeChannels(): void;
}

export function createDeps(context: vscode.ExtensionContext, parts: DepsParts): Deps {
  const channels = new Map<string, vscode.OutputChannel>();

  const getChannel = (appId: string, appName: string): vscode.OutputChannel => {
    const existing = channels.get(appId);
    if (existing) {return existing;}
    const channel = vscode.window.createOutputChannel(`Vertra Cloud: ${appName}`);
    channels.set(appId, channel);
    return channel;
  };

  const showError = (err: unknown): void => {
    const error = toErrorLike(err);
    if (error.code === "CANCELLED") {return;}

    const message = describeError(error);
    if (error.code === "API_KEY_SCOPE_DENIED" || error.code === "WEBSITE_ONLY") {
      const action = vscode.l10n.t("Open API keys");
      void Promise.resolve(vscode.window.showErrorMessage(message, action)).then((choice) => {
        if (choice === action) {openUrl(API_KEYS_URL);}
      });
      return;
    }
    if (error.code.startsWith("PLAN_")) {
      const action = vscode.l10n.t("View plans");
      void Promise.resolve(vscode.window.showErrorMessage(message, action)).then((choice) => {
        if (choice === action) {openUrl(PLANS_URL);}
      });
      return;
    }
    void vscode.window.showErrorMessage(message);
  };

  const pickApp = async (filter?: (entry: AppEntry) => boolean): Promise<AppEntry | undefined> => {
    const entries = filter ? parts.store.apps.filter(filter) : parts.store.apps;
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No applications available."));
      return undefined;
    }
    if (entries.length === 1) {return entries[0];}
    const pick = await vscode.window.showQuickPick(
      entries.map((entry) => ({
        label: entry.app.name,
        description: `${statusLabel(appStatus(entry))} · ${entry.app.ram}MB`,
        detail: entry.app.id,
        entry,
      })),
      { placeHolder: vscode.l10n.t("Select an application") },
    );
    return pick?.entry;
  };

  const pickDatabase = async (): Promise<DbEntry | undefined> => {
    const entries = parts.store.databases;
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No databases available."));
      return undefined;
    }
    if (entries.length === 1) {return entries[0];}
    const pick = await vscode.window.showQuickPick(
      entries.map((entry) => ({
        label: entry.db.name,
        description: `${statusLabel((entry.status?.running ?? entry.db.status === "up") ? "up" : "down")} · ${entry.db.ram}MB`,
        detail: entry.db.id,
        entry,
      })),
      { placeHolder: vscode.l10n.t("Select a database") },
    );
    return pick?.entry;
  };

  const resolveApp = async (arg: unknown): Promise<AppEntry | undefined> => {
    const id = appIdOf(arg);
    if (id) {
      const entry = parts.store.apps.find((e) => e.app.id === id);
      if (entry) {return entry;}
    }
    if (arg === undefined) {return pickApp();}
    return id ? undefined : pickApp();
  };

  const resolveDatabase = async (arg: unknown): Promise<DbEntry | undefined> => {
    const id = dbIdOf(arg);
    if (id) {
      const entry = parts.store.databases.find((e) => e.db.id === id);
      if (entry) {return entry;}
    }
    if (arg === undefined) {return pickDatabase();}
    return id ? undefined : pickDatabase();
  };

  const confirmDanger = async (resourceName: string, action: string): Promise<boolean> => {
    const typed = await vscode.window.showInputBox({
      title: action,
      prompt: vscode.l10n.t("Type {0} to confirm.", resourceName),
      placeHolder: resourceName,
      ignoreFocusOut: true,
      validateInput: (value: string) =>
        value.trim() === resourceName ? undefined : vscode.l10n.t("The name doesn't match."),
    });
    return typeof typed === "string" && typed.trim() === resourceName;
  };

  return {
    context,
    client: parts.client,
    session: parts.session,
    store: parts.store,
    links: parts.links,
    get realtime(): RealtimeManager {
      return parts.realtime;
    },
    getChannel,
    async refresh(): Promise<void> {
      await parts.store.refresh();
      await parts.links.refresh();
      parts.refreshViews();
    },
    showError,
    pickApp,
    pickDatabase,
    resolveApp,
    resolveDatabase,
    confirmDanger,
    disposeChannels(): void {
      for (const channel of channels.values()) {channel.dispose();}
      channels.clear();
    },
  };
}

export function register(
  context: vscode.ExtensionContext,
  id: string,
  handler: (...args: unknown[]) => unknown,
): void {
  context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}
