import * as vscode from "vscode";
import { getAppLogs } from "../api/endpoints";
import type { CommandDeps } from "./deps";
import { register } from "./index";

export function registerLogsCommands(deps: CommandDeps): void {
  const { context } = deps;

  register(context, "vertraCloud.app.showLogs", async (arg: unknown) => {
    const entry = await deps.resolveApp(arg);
    if (!entry) {return;}
    let logs: string;
    try {
      logs = await getAppLogs(deps.client, entry.app.id);
    } catch (err) {
      deps.showError(err);
      return;
    }
    const channel = deps.getChannel(entry.app.id, entry.app.name);
    channel.replace(logs || vscode.l10n.t("No logs yet."));
    channel.show(true);
  });

  register(context, "vertraCloud.app.toggleRealtime", async (arg: unknown) => {
    const entry = await deps.resolveApp(arg);
    if (!entry) {return;}
    deps.realtime.toggle(entry.app.id, entry.app.name);
    void vscode.window.showInformationMessage(
      deps.realtime.isActive(entry.app.id)
        ? vscode.l10n.t("Streaming live logs for {0}.", entry.app.name)
        : vscode.l10n.t("Stopped streaming live logs for {0}.", entry.app.name),
    );
  });
}
