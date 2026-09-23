import * as vscode from "vscode";
import type { Store } from "./state";
import type { ProjectLinkSource } from "./views/project";

/** Item discreto: só aparece com vínculo de projeto, ou quando o serviço não está saudável. */
export class StatusBar {
  private readonly item = vscode.window.createStatusBarItem
    ? vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    : undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: Store, private readonly links: ProjectLinkSource) {
    if (!this.item) {return;}
    this.item.command = "vertraCloudProject.focus";
    this.subscriptions.push(store.onDidChange(() => this.update()));
    this.subscriptions.push(this.links.onDidChange(() => this.update()));
    this.update();
  }

  private update(): void {
    if (!this.item) {return;}
    const link = this.links.links[0];
    const status = this.store.serviceStatus;
    const unhealthy = status !== undefined && status.status !== "healthy";

    if (!this.store.connected || (!link && !unhealthy)) {
      this.item.hide();
      return;
    }

    if (link) {
      const entry = this.store.apps.find((e) => e.app.id === link.appId);
      const label = entry
        ? entry.status?.installing
          ? vscode.l10n.t("Installing")
          : entry.status
            ? entry.status.running
              ? vscode.l10n.t("Online")
              : vscode.l10n.t("Offline")
            : entry.app.status === "up"
              ? vscode.l10n.t("Online")
              : vscode.l10n.t("Offline")
        : link.appId;
      this.item.text = `$(cloud) ${entry?.app.name ?? link.folder.name} · ${label}`;
    } else {
      this.item.text = `$(cloud) ${status?.message ?? vscode.l10n.t("Service issue")}`;
    }
    this.item.show();
  }

  dispose(): void {
    for (const sub of this.subscriptions) {sub.dispose();}
    this.item?.dispose();
  }
}
