import type * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import type { Session } from "../auth";
import type { AppEntry, DbEntry, Store } from "../state";
import type { ProjectLinks } from "../project/link";
import type { RealtimeManager } from "../realtime";

export interface CommandDeps {
  context: vscode.ExtensionContext;
  client: ApiClient;
  session: Session;
  store: Store;
  links: ProjectLinks;
  realtime: RealtimeManager;
  getChannel(appId: string, appName: string): vscode.OutputChannel;
  refresh(): Promise<void>;
  showError(err: unknown): void;
  pickApp(filter?: (entry: AppEntry) => boolean): Promise<AppEntry | undefined>;
  pickDatabase(): Promise<DbEntry | undefined>;
  resolveApp(arg: unknown): Promise<AppEntry | undefined>;
  resolveDatabase(arg: unknown): Promise<DbEntry | undefined>;
  confirmDanger(resourceName: string, action: string): Promise<boolean>;
  remoteFiles?: { invalidateApp(appId: string): void };
}
