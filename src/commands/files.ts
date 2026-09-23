import * as vscode from "vscode";
import { listFiles } from "../api/files";
import { VertraFileSystemProvider, VERTRA_SCHEME, remoteUri } from "../remote-files";
import type { CommandDeps } from "./deps";
import { openUrl, PLANS_URL, register } from "./index";

function errorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

export function registerFilesCommands(deps: CommandDeps): void {
  const provider = new VertraFileSystemProvider(deps.client);
  deps.remoteFiles = provider;
  deps.context.subscriptions.push(
    provider,
    vscode.workspace.registerFileSystemProvider(VERTRA_SCHEME, provider, { isCaseSensitive: true }),
  );

  register(deps.context, "vertraCloud.app.openRemoteFiles", async (arg: unknown) => {
    const entry = await deps.resolveApp(arg);
    if (!entry) {return;}

    // Uma listagem da raiz antes de montar a pasta: sem ela o gate de plano apareceria só
    // como pasta vazia no Explorer, sem explicação.
    try {
      await listFiles(deps.client, entry.app.id, "");
    } catch (error) {
      if (errorCode(error).startsWith("PLAN_")) {
        const action = vscode.l10n.t("View plans");
        const choice = await vscode.window.showInformationMessage(
          vscode.l10n.t("Browsing application files isn't included in this plan."),
          action,
        );
        if (choice === action) {openUrl(PLANS_URL);}
        return;
      }
      deps.showError(error);
      return;
    }

    provider.rememberApp(entry.app.id, entry.app.name);
    const uri = remoteUri(entry.app.id);
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some((folder) => folder.uri.toString() === uri.toString())) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }
    // `updateWorkspaceFolders` e não `vscode.openFolder`: abrir a pasta remota como raiz
    // fecharia o projeto local em que o usuário está trabalhando.
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
      uri,
      name: vscode.l10n.t("{0} (Vertra)", entry.app.name),
    });
  });
}
