import * as vscode from "vscode";
import type { APIBlobObject, APIBlobStats } from "@vertracloud/blob";
import type { GetBlob } from "../blob/client";
import { describeBlobError } from "../blob/errors";
import { formatBytes } from "../l10n";

export type BlobNode =
  | { kind: "stats"; stats: APIBlobStats }
  | { kind: "folder"; prefix: string }
  | { kind: "object"; object: APIBlobObject };

const PAGE_LIMIT = 1000;
// ponytail: stops after 20 pages (20k entries per folder); add a "load more" node if anyone hits it.
const MAX_PAGES = 20;

export function folderName(prefix: string): string {
  return prefix.replace(/\/$/, "").split("/").pop() ?? prefix;
}

export function objectName(object: APIBlobObject): string {
  return object.path.split("/").pop() ?? object.path;
}

export function blobUri(object: Pick<APIBlobObject, "id" | "path">): vscode.Uri {
  return vscode.Uri.from({ scheme: "vertra-blob", authority: object.id, path: `/${object.path}` });
}

export class BlobProvider implements vscode.TreeDataProvider<BlobNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Set when the last load failed; the registrar shows it as the view message. */
  message: string | undefined;
  onMessage?: (message: string | undefined) => void;

  constructor(private readonly getBlob: GetBlob) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: BlobNode): vscode.TreeItem {
    if (node.kind === "stats") {
      const { used_bytes, quota_bytes } = node.stats;
      const item = new vscode.TreeItem(vscode.l10n.t("Storage"), vscode.TreeItemCollapsibleState.None);
      item.description = vscode.l10n.t("{0} of {1}", formatBytes(used_bytes), formatBytes(quota_bytes));
      item.iconPath = new vscode.ThemeIcon("database");
      item.contextValue = "blob:stats";
      return item;
    }
    if (node.kind === "folder") {
      const item = new vscode.TreeItem(folderName(node.prefix), vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "blob:folder";
      return item;
    }
    const { object } = node;
    const isPublic = object.visibility === "public";
    const item = new vscode.TreeItem(objectName(object), vscode.TreeItemCollapsibleState.None);
    item.description = `${formatBytes(object.size)}${isPublic ? "" : ` · ${vscode.l10n.t("private")}`}`;
    item.iconPath = new vscode.ThemeIcon(object.content_type.startsWith("image/") ? "file-media" : isPublic ? "file" : "lock");
    item.contextValue = isPublic ? "blob:object:public" : "blob:object:private";
    item.tooltip = `${object.path}\n${object.content_type}`;
    item.command = { command: "vertraCloud.blob.preview", title: vscode.l10n.t("Preview"), arguments: [node] };
    return item;
  }

  async getChildren(node?: BlobNode): Promise<BlobNode[]> {
    if (node && node.kind !== "folder") {return [];}
    const prefix = node?.prefix ?? "";
    try {
      const blob = await this.getBlob();
      const listing = this.list(blob, prefix);
      const stats = node ? undefined : blob.stats().catch(() => undefined);
      const [children, usage] = await Promise.all([listing, stats]);
      this.setMessage(undefined);
      return usage ? [{ kind: "stats", stats: usage }, ...children] : children;
    } catch (error) {
      this.setMessage(describeBlobError(error as { code: string; message?: string; details?: unknown; retryAfter?: number }));
      return [];
    }
  }

  private async list(blob: Awaited<ReturnType<GetBlob>>, prefix: string): Promise<BlobNode[]> {
    const folders: BlobNode[] = [];
    const objects: BlobNode[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await blob.listPage({ prefix, delimiter: "/", limit: PAGE_LIMIT, cursor });
      for (const folder of result.folders) {
        if (!folders.some((f) => f.kind === "folder" && f.prefix === folder)) {folders.push({ kind: "folder", prefix: folder });}
      }
      for (const object of result.objects) {
        if (!object.path.endsWith("/")) {objects.push({ kind: "object", object });}
      }
      if (!result.cursor) {break;}
      cursor = result.cursor;
    }
    return [...folders, ...objects];
  }

  private setMessage(message: string | undefined): void {
    if (message === this.message) {return;}
    this.message = message;
    this.onMessage?.(message);
  }
}
