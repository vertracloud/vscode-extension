import * as vscode from "vscode";
import type { AppEntry, Store } from "../state";
import { appEffectiveStatus, appInfoFields, appInfoItem, appTreeItem, folderIcon, type AppInfoField } from "./items";

const FAVORITES_LABEL = () => vscode.l10n.t("Favorites");

type Node =
  | { kind: "group"; group: "favorites" | "folder"; folderId?: string }
  | { kind: "app"; appId: string; folderId?: string }
  | { kind: "appInfo"; appId: string; field: AppInfoField; folderId?: string };

/** Favoritos primeiro (tratados à parte), depois online antes de offline, depois alfabético. */
function sortApps(entries: AppEntry[]): AppEntry[] {
  return [...entries].sort((a, b) => {
    const aUp = appEffectiveStatus(a) === "up" ? 0 : 1;
    const bUp = appEffectiveStatus(b) === "up" ? 0 : 1;
    if (aUp !== bUp) {return aUp - bUp;}
    return a.app.name.localeCompare(b.app.name);
  });
}

export class ApplicationsProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: Store) {}

  refresh(): void {
    this.emitter.fire();
  }

  private findApp(appId: string): AppEntry | undefined {
    return this.store.apps.find((e) => e.app.id === appId);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const folder = node.folderId ? this.store.getFolder(node.folderId) : undefined;
      const item = new vscode.TreeItem(
        node.group === "favorites" ? FAVORITES_LABEL() : folder?.name ?? vscode.l10n.t("Folder"),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = node.group === "favorites" ? new vscode.ThemeIcon("star-full") : folderIcon(folder?.color);
      item.contextValue = node.group === "favorites" ? "favorites:personal" : `resource-folder:personal:${node.folderId}`;
      return item;
    }
    const entry = this.findApp(node.appId);
    if (!entry) {return new vscode.TreeItem("");}
    if (node.kind === "appInfo") {return appInfoItem(entry, node.field);}
    const item = appTreeItem(entry);
    if (node.folderId) {item.contextValue = `${item.contextValue}:folder:${node.folderId}`;}
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (this.store.apps.length === 0 && (this.store.getOrganization()?.folders.length ?? 0) === 0) {return [];} 
    if (!node) {
      const organization = this.store.getOrganization();
      const filed = new Set(organization?.folders.flatMap((folder) =>
        folder.resources.filter((resource) => resource.resource_type === "application").map((resource) => resource.resource_id),
      ));
      const favorites = sortApps(this.store.apps.filter((e) => e.favorite));
      const rest = sortApps(this.store.apps.filter((e) => !e.favorite && !filed.has(e.app.id)));
      const nodes: Node[] = [];
      for (const folder of organization?.folders ?? []) {
        nodes.push({ kind: "group", group: "folder", folderId: folder.id });
      }
      if (favorites.length > 0) {nodes.push({ kind: "group", group: "favorites" });}
      nodes.push(...rest.map((e): Node => ({ kind: "app", appId: e.app.id })));
      return nodes;
    }
    if (node.kind === "group" && node.group === "favorites") {
      return sortApps(this.store.apps.filter((e) => e.favorite)).map((e): Node => ({ kind: "app", appId: e.app.id }));
    }
    if (node.kind === "group" && node.group === "folder" && node.folderId) {
      const folder = this.store.getFolder(node.folderId);
      const ids = new Set(folder?.resources
        .filter((resource) => resource.resource_type === "application")
        .map((resource) => resource.resource_id));
      return sortApps(this.store.apps.filter((entry) => ids.has(entry.app.id))).map((entry): Node => ({
        kind: "app",
        appId: entry.app.id,
        folderId: node.folderId,
      }));
    }
    if (node.kind === "app") {
      const entry = this.findApp(node.appId);
      if (!entry) {return [];}
      return appInfoFields(entry).map((field): Node => ({ kind: "appInfo", appId: node.appId, field, folderId: node.folderId }));
    }
    return [];
  }
}
