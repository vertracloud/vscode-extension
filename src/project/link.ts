import * as vscode from "vscode";
import { readConfig, writeConfigKey, CONFIG_FILE_NAME, buildConfigFromApp, type ConfigSource } from "./config";

const MEMENTO_KEY = "vertraCloud.links";

export type ProjectLinkSource = "config" | "workspaceState";

export interface ProjectLink {
  folder: vscode.WorkspaceFolder;
  appId: string;
  source: ProjectLinkSource;
}

function mementoLinks(state: vscode.Memento): Record<string, string> {
  return state.get<Record<string, string>>(MEMENTO_KEY, {});
}

async function setMementoLink(state: vscode.Memento, folderUri: string, appId: string | undefined): Promise<void> {
  const links = { ...mementoLinks(state) };
  if (appId === undefined) {
    delete links[folderUri];
  } else {
    links[folderUri] = appId;
  }
  await state.update(MEMENTO_KEY, links);
}

/** Reads the app linked to each folder: `ID=` in `vertracloud.config` takes precedence over workspaceState. */
export async function readLinks(
  folders: readonly vscode.WorkspaceFolder[],
  state: vscode.Memento,
): Promise<ProjectLink[]> {
  const links: ProjectLink[] = [];
  const memento = mementoLinks(state);

  for (const folder of folders) {
    const config = await readConfig(folder.uri);
    const configId = config?.values.ID;
    if (configId) {
      links.push({ folder, appId: configId, source: "config" });
      continue;
    }
    const stateId = memento[folder.uri.toString()];
    if (stateId) {
      links.push({ folder, appId: stateId, source: "workspaceState" });
    }
  }

  return links;
}

/** Links a folder to an app id, writing `ID=` when `writeConfig` is set, otherwise only workspaceState. */
export async function link(
  folder: vscode.WorkspaceFolder,
  appId: string,
  opts: { writeConfig: boolean; app?: ConfigSource },
  state: vscode.Memento,
): Promise<void> {
  if (opts.writeConfig) {
    const existing = await readConfig(folder.uri);
    if (!existing && opts.app) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(folder.uri, "vertracloud.config"),
        Buffer.from(buildConfigFromApp(opts.app), "utf8"),
      );
    } else {
      await writeConfigKey(folder.uri, "ID", appId);
    }
  }
  await setMementoLink(state, folder.uri.toString(), appId);
}

/** Removes the link from both `vertracloud.config` (the `ID=` line) and workspaceState. */
export async function unlink(folder: vscode.WorkspaceFolder, state: vscode.Memento): Promise<void> {
  const config = await readConfig(folder.uri);
  if (config?.values.ID !== undefined) {
    const uri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    const next = text.split(/\r?\n/).filter((line) => !/^\s*ID\s*=/i.test(line));
    if (next.length > 0 && next[next.length - 1] === "") {next.pop();}
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`${next.join("\n")}\n`, "utf8"));
  }
  await setMementoLink(state, folder.uri.toString(), undefined);
}

/** Resolves the target folder for a project command: the only folder, or a QuickPick when multi-root. */
export async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {return undefined;}
  if (folders.length === 1) {return folders[0];}

  const pick = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.path, folder })),
    { placeHolder: vscode.l10n.t("Select a project folder") },
  );
  return pick?.folder;
}

export class ProjectLinks {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  links: ProjectLink[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposed = false;

  constructor(
    private readonly state: vscode.Memento,
    private readonly subscriptions: { push(d: { dispose(): void }): void },
  ) {
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()));
    this.watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_NAME}`);
    this.subscriptions.push(this.watcher);
    this.subscriptions.push(this.watcher.onDidChange(() => void this.refresh()));
    this.subscriptions.push(this.watcher.onDidCreate(() => void this.refresh()));
    this.subscriptions.push(this.watcher.onDidDelete(() => void this.refresh()));
    this.subscriptions.push({ dispose: () => this.emitter.dispose() });
  }

  async refresh(): Promise<void> {
    if (this.disposed) {return;}
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.links = await readLinks(folders, this.state);
    await vscode.commands.executeCommand("setContext", "vertraCloud.hasLink", this.links.length > 0);
    this.emitter.fire();
  }

  dispose(): void {
    this.disposed = true;
  }
}
