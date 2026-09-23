import * as vscode from "vscode";
import type { Store } from "../state";
import { formatMegabytes } from "../l10n";

type Node = "identity" | "plan" | "service-status";

export class AccountProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: Store) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const user = this.store.user;
    if (!user) {return new vscode.TreeItem("");}

    if (node === "identity") {
      const item = new vscode.TreeItem(user.name, vscode.TreeItemCollapsibleState.None);
      item.description = user.email;
      item.iconPath = new vscode.ThemeIcon("account");
      item.contextValue = "account";
      return item;
    }
    if (node === "plan") {
      const item = new vscode.TreeItem(user.plan.name, vscode.TreeItemCollapsibleState.None);
      item.description = vscode.l10n.t("{0} / {1} RAM", formatMegabytes(user.plan.memory.used), formatMegabytes(user.plan.memory.limit));
      item.iconPath = new vscode.ThemeIcon("credit-card");
      item.contextValue = "account";
      return item;
    }
    const status = this.store.serviceStatus;
    const item = new vscode.TreeItem(vscode.l10n.t("Service status"), vscode.TreeItemCollapsibleState.None);
    item.description = status?.message ?? vscode.l10n.t("Unknown");
    item.iconPath = status?.status === "healthy"
    ? new vscode.ThemeIcon("heart", new vscode.ThemeColor("charts.green"))
    : new vscode.ThemeIcon("heart", new vscode.ThemeColor("charts.red"));
    item.contextValue = "account";
    item.command = { command: "vertraCloud.account.showServiceStatus", title: "" };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (node || !this.store.user) {return [];}
    return ["identity", "plan", "service-status"];
  }
}
