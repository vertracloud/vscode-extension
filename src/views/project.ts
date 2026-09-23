import * as vscode from "vscode";
import type { Store, AppEntry } from "../state";
import { statusLabel, formatMegabytes } from "../l10n";
import type { ProjectLink } from "../project/link";

export interface ProjectLinkSource {
  readonly links: ProjectLink[];
  readonly onDidChange: vscode.Event<void>;
}

type InfoField = "folder" | "status" | "ram" | "domain";

type Node =
  | { kind: "root"; link: ProjectLink }
  | { kind: "info"; link: ProjectLink; field: InfoField };

function effectiveStatus(entry: AppEntry | undefined): "up" | "down" | "installing" {
  if (!entry) {return "down";}
  if (entry.status?.installing) {return "installing";}
  if (entry.status) {return entry.status.running ? "up" : "down";}
  return entry.app.status === "up" ? "up" : "down";
}

export class ProjectProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: Store, private readonly links: ProjectLinkSource) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const entry = this.store.apps.find((e) => e.app.id === node.link.appId);

    if (node.kind === "info") {
      const status = effectiveStatus(entry);
      switch (node.field) {
        case "folder": {
          const item = new vscode.TreeItem(node.link.folder.name, vscode.TreeItemCollapsibleState.None);
          item.iconPath = new vscode.ThemeIcon("folder");
          return item;
        }
        case "status": {
          const item = new vscode.TreeItem(
            vscode.l10n.t("Status: {0}", statusLabel(status)),
            vscode.TreeItemCollapsibleState.None
          );
          item.iconPath = new vscode.ThemeIcon("pulse");
          return item;
        }
        case "ram": {
          const ramLabel = entry?.status
            ? `${entry.status.ram} / ${formatMegabytes(entry.app.ram)}`
            : entry
              ? `${formatMegabytes(entry.app.ram)}`
              : "?";
          const item = new vscode.TreeItem(vscode.l10n.t("RAM: {0}", ramLabel), vscode.TreeItemCollapsibleState.None);
          item.iconPath = new vscode.ThemeIcon("server");
          return item;
        }
        case "domain": {
          const domain = entry?.app.public_url ?? vscode.l10n.t("Not published");
          const item = new vscode.TreeItem(domain, vscode.TreeItemCollapsibleState.None);
          item.iconPath = new vscode.ThemeIcon("globe");
          if (entry?.app.public_url) {
            item.command = { command: "vertraCloud.app.open", title: "", arguments: [entry.app.id] };
          }
          return item;
        }
      }
    }

    const item = new vscode.TreeItem(entry?.app.name ?? node.link.folder.name, vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = entry?.app.public_url ? "project:published" : "project";
    if (entry) {
      const status = effectiveStatus(entry);
      item.description = statusLabel(status);
      item.iconPath =
        status === "installing"
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(status === "up" ? "charts.green" : "charts.red"));
    } else {
      item.description = node.link.appId;
      item.iconPath = new vscode.ThemeIcon("cloud-outline");
    }
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${entry?.app.name ?? node.link.folder.name}**\n\n`);
    tooltip.appendMarkdown(`- ${vscode.l10n.t("Folder")}: ${node.link.folder.uri.fsPath}\n`);
    tooltip.appendMarkdown(`- ID: \`${node.link.appId}\`\n`);
    if (entry) {
      const ramLabel = entry.status ? `${entry.status.ram} / ${formatMegabytes(entry.app.ram)}` : `${formatMegabytes(entry.app.ram)}`;
      tooltip.appendMarkdown(`- RAM: ${ramLabel}\n`);
      tooltip.appendMarkdown(`- ${vscode.l10n.t("Public domain")}: ${entry.app.public_url ?? vscode.l10n.t("Not published")}\n`);
    }
    item.tooltip = tooltip;
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      if (!this.store.connected) {return [];}
      return this.links.links.map((link) => ({ kind: "root", link }));
    }
    if (node.kind !== "root") {return [];}
    return (["folder", "status", "ram", "domain"] as const).map((field) => ({
      kind: "info",
      link: node.link,
      field,
    }));
  }
}
