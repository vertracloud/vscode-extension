import * as vscode from "vscode";
import type { APIApplication, APIDatabase } from "@vertracloud/api-types/v1";
import type { AppEntry, DbEntry, Store, WorkspaceEntry } from "../state";
import { appTreeItem, dbTreeItem, folderIcon } from "./items";

/**
 * Alguns endpoints de workspace devolvem apps/dbs vinculados e o papel do chamador; a lista
 * básica não. Nunca redeclare o payload inteiro.
 */
type WorkspaceWithResources = WorkspaceEntry & {
  applications?: APIApplication[];
  databases?: APIDatabase[];
  is_owner?: boolean;
};

type Node = { kind: "workspace"; id: string } | { kind: "folder"; workspaceId: string; folderId: string } | { kind: "app"; workspaceId: string; app: APIApplication; folderId?: string } | {
  kind: "db";
  workspaceId: string;
  db: APIDatabase;
  folderId?: string;
};

export class WorkspacesProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: Store) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "app") {
      const entry: AppEntry = {
        app: node.app,
        favorite: this.store.isFavorite("application", node.app.id, node.workspaceId),
      };
      const item = appTreeItem(entry);
      if (node.folderId) {item.contextValue = `${item.contextValue}:folder:${node.folderId}:workspace:${node.workspaceId}`;}
      return item;
    }
    if (node.kind === "db") {
      const entry: DbEntry = {
        db: node.db,
        favorite: this.store.isFavorite("database", node.db.id, node.workspaceId),
      };
      const item = dbTreeItem(entry);
      if (node.folderId) {item.contextValue = `${item.contextValue}:folder:${node.folderId}:workspace:${node.workspaceId}`;}
      return item;
    }
    if (node.kind === "folder") {
      const organization = this.store.getOrganization(node.workspaceId);
      const folder = organization?.folders.find((item) => item.id === node.folderId);
      const item = new vscode.TreeItem(folder?.name ?? vscode.l10n.t("Folder"), vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = folderIcon(folder?.color);
      item.contextValue = `resource-folder:workspace:${node.workspaceId}:${node.folderId}`;
      return item;
    }
    const workspace = this.store.workspaces.find((w) => w.id === node.id) as WorkspaceWithResources | undefined;
    if (!workspace) {return new vscode.TreeItem("");}
    const hasChildren = (workspace.applications?.length ?? 0) + (workspace.databases?.length ?? 0) > 0 ||
      (workspace.resource_organization?.folders.length ?? 0) > 0;
    const item = new vscode.TreeItem(
      workspace.name,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.description = workspace.is_owner ? vscode.l10n.t("Owner") : vscode.l10n.t("owned by {0}", workspace.owner.display_name);
    item.iconPath = new vscode.ThemeIcon("organization");
    item.contextValue = "workspace";
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {return this.store.workspaces.map((w) => ({ kind: "workspace", id: w.id }));}
    const workspaceId = node.kind === "workspace" ? node.id : node.workspaceId;
    const workspace = this.store.workspaces.find((w) => w.id === workspaceId) as WorkspaceWithResources | undefined;
    if (!workspace) {return [];}
    const organization = workspace.resource_organization;
    const filed = new Set(organization?.folders.flatMap((folder) => folder.resources.map((resource) => `${resource.resource_type}:${resource.resource_id}`)));
    const folders = (organization?.folders ?? []).map((folder) => ({ kind: "folder" as const, workspaceId, folderId: folder.id }));
    const apps = (workspace.applications ?? [])
      .filter((app) => !filed.has(`application:${app.id}`))
      .map((app) => ({ kind: "app" as const, workspaceId, app }));
    const dbs = (workspace.databases ?? [])
      .filter((db) => !filed.has(`database:${db.id}`))
      .map((db) => ({ kind: "db" as const, workspaceId, db }));
    if (node.kind === "folder") {
      const folder = organization?.folders.find((item) => item.id === node.folderId);
      const appIds = new Set(folder?.resources.filter((resource) => resource.resource_type === "application").map((resource) => resource.resource_id));
      const dbIds = new Set(folder?.resources.filter((resource) => resource.resource_type === "database").map((resource) => resource.resource_id));
      return [
        ...(workspace.applications ?? []).filter((app) => appIds.has(app.id)).map((app) => ({ kind: "app" as const, workspaceId, app, folderId: node.folderId })),
        ...(workspace.databases ?? []).filter((db) => dbIds.has(db.id)).map((db) => ({ kind: "db" as const, workspaceId, db, folderId: node.folderId })),
      ];
    }
    if (node.kind !== "workspace") {return [];}
    return [...folders, ...apps, ...dbs];
  }
}
