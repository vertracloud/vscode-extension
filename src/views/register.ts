import * as vscode from "vscode";
import type { Store } from "../state";
import { describeError } from "../l10n";
import { ProjectProvider, type ProjectLinkSource } from "./project";
import { ApplicationsProvider } from "./applications";
import { DatabasesProvider } from "./databases";
import { WorkspacesProvider } from "./workspaces";
import { AccountProvider } from "./account";

interface Refreshable {
  refresh(): void;
}

/** Reduz o mínimo de FakeTreeView usado pelos testes e pela API real do VS Code. */
interface MinimalTreeView {
  message?: string;
  onDidChangeVisibility: vscode.Event<{ visible: boolean }>;
}

function bindStatusMessage(view: MinimalTreeView, store: Store, hasData: () => boolean): void {
  const update = () => {
    if (store.loading && !hasData()) {
      view.message = vscode.l10n.t("Loading…");
    } else if (store.lastError) {
      view.message = describeError(store.lastError);
    } else {
      view.message = undefined;
    }
  };
  store.onDidChange(update);
  update();
}

export function registerViews(
  context: { subscriptions: Array<{ dispose(): void }> },
  store: Store,
  links: ProjectLinkSource
): { refreshAll(): void } {
  const projectProvider = new ProjectProvider(store, links);
  const applicationsProvider = new ApplicationsProvider(store);
  const databasesProvider = new DatabasesProvider(store);
  const workspacesProvider = new WorkspacesProvider(store);
  const accountProvider = new AccountProvider(store);

  const providers: Refreshable[] = [
    projectProvider,
    applicationsProvider,
    databasesProvider,
    workspacesProvider,
    accountProvider,
  ];
  store.onDidChange(() => {
    for (const provider of providers) {provider.refresh();}
  });
  links.onDidChange(() => projectProvider.refresh());

  const projectView = vscode.window.createTreeView("vertraCloudProject", {
    treeDataProvider: projectProvider,
    showCollapseAll: false,
  });
  const appsView = vscode.window.createTreeView("vertraCloudApps", {
    treeDataProvider: applicationsProvider,
    showCollapseAll: false,
  });
  const dbsView = vscode.window.createTreeView("vertraCloudDBs", {
    treeDataProvider: databasesProvider,
    showCollapseAll: false,
  });
  const workspacesView = vscode.window.createTreeView("vertraCloudWorkspaces", {
    treeDataProvider: workspacesProvider,
    showCollapseAll: false,
  });
  const accountView = vscode.window.createTreeView("vertraCloudAccount", {
    treeDataProvider: accountProvider,
    showCollapseAll: false,
  });

  bindStatusMessage(projectView, store, () => links.links.length > 0);
  bindStatusMessage(appsView, store, () => store.apps.length > 0);
  bindStatusMessage(dbsView, store, () => store.databases.length > 0);
  bindStatusMessage(workspacesView, store, () => store.workspaces.length > 0);
  bindStatusMessage(accountView, store, () => store.user !== undefined);

  for (const view of [appsView, dbsView, workspacesView, accountView, projectView]) {
    context.subscriptions.push(
      view as unknown as { dispose(): void },
      view.onDidChangeVisibility((e: { visible: boolean }) => store.setViewVisible(e.visible))
    );
  }

  context.subscriptions.push(vscode.window.onDidChangeWindowState((state: { focused: boolean }) => store.setWindowFocus(state.focused)));

  return {
    refreshAll(): void {
      for (const provider of providers) {provider.refresh();}
    },
  };
}
