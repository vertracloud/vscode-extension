import * as vscode from "vscode";

// === Classe TreeItem ===
class VertraCloudItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
  }
}

// === TreeDataProvider ===
class VertraCloudProvider implements vscode.TreeDataProvider<VertraCloudItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    VertraCloudItem | undefined | void
  > = new vscode.EventEmitter<VertraCloudItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<VertraCloudItem | undefined | void> =
    this._onDidChangeTreeData.event;

  getTreeItem(element: VertraCloudItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: VertraCloudItem): Thenable<VertraCloudItem[]> {
    if (!element) {
      // Raiz da árvore
      return Promise.resolve([
        new VertraCloudItem(
          "Apps",
          vscode.TreeItemCollapsibleState.Collapsed
        ),
        new VertraCloudItem(
          "Databases",
          vscode.TreeItemCollapsibleState.Collapsed
        )
      ]);
    } else if (element.label === "Apps") {
      return Promise.resolve([
        new VertraCloudItem("App 1", vscode.TreeItemCollapsibleState.None),
        new VertraCloudItem("App 2", vscode.TreeItemCollapsibleState.None)
      ]);
    } else if (element.label === "Databases") {
      return Promise.resolve([
        new VertraCloudItem("Database 1", vscode.TreeItemCollapsibleState.None)
      ]);
    }

    return Promise.resolve([]);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

// === Ativação da extensão ===
export async function activate(context: vscode.ExtensionContext) {
  const secretStorage = context.secrets;

  // Registrar árvore lateral
  const provider = new VertraCloudProvider();
  vscode.window.registerTreeDataProvider("vertraCloudExplorer", provider);

  // Comando para atualizar árvore
  context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.refresh", () =>
      provider.refresh()
    )
  );

  // Comando: Cadastrar ou atualizar API Key
  const setApiKey = vscode.commands.registerCommand(
    "vertraCloud.setApiKey",
    async () => {
      const existingKey = await secretStorage.get("vertraCloudApiKey");

      const apiKey = await vscode.window.showInputBox({
        prompt: existingKey
          ? "Já existe uma API Key cadastrada. Digite a nova para atualizar:"
          : "Digite sua API Key da Vertra Cloud",
        ignoreFocusOut: true,
        password: true
      });

      if (apiKey) {
        await secretStorage.store("vertraCloudApiKey", apiKey);
        vscode.window.showInformationMessage(
          existingKey
            ? "🔄 API Key atualizada com sucesso!"
            : "✅ API Key cadastrada com sucesso!"
        );
      }
    }
  );

  // Comando: Remover API Key
  const clearApiKey = vscode.commands.registerCommand(
    "vertraCloud.clearApiKey",
    async () => {
      const existingKey = await secretStorage.get("vertraCloudApiKey");

      if (!existingKey) {
        vscode.window.showWarningMessage("⚠️ Nenhuma API Key está cadastrada.");
        return;
      }

      await secretStorage.delete("vertraCloudApiKey");
      vscode.window.showInformationMessage("🗑️ API Key removida com sucesso!");
    }
  );

  // Comando: Exibir API Key (apenas para debug)
  const showApiKey = vscode.commands.registerCommand(
    "vertraCloud.showApiKey",
    async () => {
      const apiKey = await secretStorage.get("vertraCloudApiKey");

      if (apiKey) {
        vscode.window.showInformationMessage(`🔑 API Key atual: ${apiKey}`);
      } else {
        vscode.window.showWarningMessage("⚠️ Nenhuma API Key cadastrada.");
      }
    }
  );

  context.subscriptions.push(setApiKey, clearApiKey, showApiKey);
}

export function deactivate() {}
