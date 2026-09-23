import * as vscode from "vscode";
import type { DbEntry, Store } from "../state";
import { dbInfoFields, dbInfoItem, dbTreeItem, folderIcon, type DbInfoField } from "./items";

type Node =
  | { kind: "group"; group: "folder"; folderId: string }
  | { kind: "db"; dbId: string; folderId?: string }
  | { kind: "dbInfo"; dbId: string; field: DbInfoField; folderId?: string };

export class DatabasesProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: Store) {}

  refresh(): void {
    this.emitter.fire();
  }

  private findDb(dbId: string): DbEntry | undefined {
    return this.store.databases.find((e) => e.db.id === dbId);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const folder = this.store.getFolder(node.folderId);
      const item = new vscode.TreeItem(folder?.name ?? vscode.l10n.t("Folder"), vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = folderIcon(folder?.color);
      item.contextValue = `resource-folder:personal:${node.folderId}`;
      return item;
    }
    const entry = this.findDb(node.dbId);
    if (!entry) {return new vscode.TreeItem("");}
    if (node.kind === "dbInfo") {return dbInfoItem(entry, node.field);}
    const item = dbTreeItem(entry);
    if (node.folderId) {item.contextValue = `${item.contextValue}:folder:${node.folderId}`;}
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const organization = this.store.getOrganization();
      const filed = new Set(organization?.folders.flatMap((folder) =>
        folder.resources.filter((resource) => resource.resource_type === "database").map((resource) => resource.resource_id),
      ));
      const nodes: Node[] = (organization?.folders ?? []).map((folder) => ({ kind: "group", group: "folder", folderId: folder.id }));
      nodes.push(...this.store.databases.filter((entry) => !filed.has(entry.db.id)).map((entry): Node => ({ kind: "db", dbId: entry.db.id })));
      return nodes;
    }
    if (node.kind === "group") {
      const folder = this.store.getFolder(node.folderId);
      const ids = new Set(folder?.resources.filter((resource) => resource.resource_type === "database").map((resource) => resource.resource_id));
      return this.store.databases.filter((entry) => ids.has(entry.db.id)).map((entry): Node => ({ kind: "db", dbId: entry.db.id, folderId: node.folderId }));
    }
    if (node.kind !== "db") {return [];} 
    const entry = this.findDb(node.dbId);
    if (!entry) {return [];}
    return dbInfoFields().map((field): Node => ({ kind: "dbInfo", dbId: node.dbId, field, folderId: node.folderId }));
  }
}
