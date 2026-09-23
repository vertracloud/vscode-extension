import * as vscode from "vscode";
import type { CommandDeps } from "./deps";
import { register } from "./index";

/** IDs da 0.0.4, mantidos como alias para não quebrar keybindings e chamadas externas. */
const ALIASES: Record<string, string> = {
  "vertraCloud.setApiKey": "vertraCloud.useApiKey",
  "vertraCloud.clearApiKey": "vertraCloud.disconnect",
  "vertraCloud.project.viewLogs": "vertraCloud.app.showLogs",
  "vertraCloud.project.startApp": "vertraCloud.app.start",
  "vertraCloud.project.stopApp": "vertraCloud.app.stop",
  "vertraCloud.project.restartApp": "vertraCloud.app.restart",
};

export function registerLegacyCommands(deps: CommandDeps): void {
  for (const [oldId, newId] of Object.entries(ALIASES)) {
    register(deps.context, oldId, (...args: unknown[]) =>
      vscode.commands.executeCommand(newId, ...args),
    );
  }
}
