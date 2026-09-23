import * as vscode from "vscode";
import { getServiceStatus } from "../api/endpoints";
import type { CommandDeps } from "./deps";
import { appIdOf, DASHBOARD_URL, DOCS_URL, openUrl, register, workspaceIdOf } from "./index";

function copyableId(arg: unknown, deps: CommandDeps): string | undefined {
  if (typeof arg === "string") {return arg;}
  if (!arg || typeof arg !== "object") {return undefined;}
  const node = arg as { kind?: string; appId?: unknown; id?: unknown; app?: { id?: unknown }; db?: { id?: unknown } };
  if (typeof node.appId === "string") {return node.appId;}
  if (typeof node.app?.id === "string") {return node.app.id;}
  if (typeof node.db?.id === "string") {return node.db.id;}
  const workspaceId = workspaceIdOf(arg);
  if (workspaceId) {return workspaceId;}
  if (typeof node.id === "string") {return node.id;}
  return deps.store.user?.id;
}

export function registerAuthCommands(deps: CommandDeps): void {
  const { context } = deps;

  register(context, "vertraCloud.connect", async () => {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("Waiting for browser authorization…"),
          cancellable: true,
        },
        (_progress, token) => deps.session.connectWithOAuth(token),
      );
    } catch (err) {
      deps.showError(err);
    }
  });

  register(context, "vertraCloud.useApiKey", async () => {
    const key = await vscode.window.showInputBox({
      title: vscode.l10n.t("Vertra Cloud API key"),
      prompt: vscode.l10n.t("Paste an API key from your dashboard."),
      password: true,
      ignoreFocusOut: true,
      validateInput: (value: string) =>
        value.trim().length === 0 ? vscode.l10n.t("The API key can't be empty.") : undefined,
    });
    if (!key || key.trim().length === 0) {return;}

    try {
      await deps.session.connectWithApiKey(key.trim());
    } catch (err) {
      deps.showError(err);
      return;
    }
    const state = deps.session.state;
    if (state.status === "connected") {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Connected as {0} ({1}).", state.user.name, state.user.email),
      );
    }
    await deps.refresh();
  });

  register(context, "vertraCloud.disconnect", async () => {
    const confirm = vscode.l10n.t("Disconnect");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Disconnect this account from VS Code?"),
      { modal: true },
      confirm,
    );
    if (choice !== confirm) {return;}
    await deps.session.disconnect();
  });

  register(context, "vertraCloud.openDashboard", (arg: unknown) => {
    const appId = appIdOf(arg);
    openUrl(appId ? `${DASHBOARD_URL}/apps/${appId}` : DASHBOARD_URL);
  });

  register(context, "vertraCloud.openDocs", () => openUrl(DOCS_URL));

  register(context, "vertraCloud.refresh", async () => {
    try {
      await deps.refresh();
    } catch (err) {
      deps.showError(err);
    }
  });

  register(context, "vertraCloud.copyId", async (arg: unknown) => {
    const id = copyableId(arg, deps);
    if (!id) {return;}
    await vscode.env.clipboard.writeText(id);
    void vscode.window.showInformationMessage(vscode.l10n.t("Copied {0} to the clipboard.", id));
  });

  register(context, "vertraCloud.account.showServiceStatus", async () => {
    try {
      const status = await getServiceStatus(deps.client);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Service status: {0} — {1}", status.status, status.message),
      );
    } catch (err) {
      deps.showError(err);
    }
  });
}
