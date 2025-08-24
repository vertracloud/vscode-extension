import * as vscode from "vscode";
import axios, { AxiosInstance } from "axios";

// === Classe TreeItem ===
class VertraCloudItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly contextValue?: string,
    public readonly metadata?: any,
    public readonly iconPath?: vscode.ThemeIcon
  ) {
    super(label, collapsibleState);
    if (iconPath) this.iconPath = iconPath;
  }
}

// === TreeDataProvider ===
class VertraCloudProvider implements vscode.TreeDataProvider<VertraCloudItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    VertraCloudItem | undefined | void
  > = new vscode.EventEmitter<VertraCloudItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<VertraCloudItem | undefined | void> =
    this._onDidChangeTreeData.event;

  public projects: any[] = [];
  public axiosInstance: AxiosInstance | null = null;
  private openedProjectId: string | null = null;
  private refreshTimeout: NodeJS.Timeout | null = null;
  private statusUpdateInterval: NodeJS.Timeout | null = null;

  constructor(private secretStorage: vscode.SecretStorage) {
    this.startStatusUpdateInterval();
  }

  getTreeItem(element: VertraCloudItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: VertraCloudItem): Promise<VertraCloudItem[]> {
    const apiKey = await this.secretStorage.get("vertraCloudApiKey");
    if (!apiKey) {
      await vscode.commands.executeCommand("vertraCloud.setApiKey");
      return [];
    }

    if (!this.axiosInstance) {
      this.axiosInstance = axios.create({
        baseURL: "https://api.vertracloud.app/v1",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    }

    if (!element) {
      if (this.projects.length === 0) {
        await this.loadProjects();
      }
      return this.projects.map((proj) => {
        const icon = proj.running === undefined
          ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.gray"))
          : proj.running
            ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
            : new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));

        return new VertraCloudItem(
          proj.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          "project",
          proj,
          icon
        );
      });
    }

    if (element.contextValue === "project" && element.metadata.id !== this.openedProjectId) {
      this.openedProjectId = element.metadata.id;

      const endpoint = element.metadata.type === "app"
        ? `/apps/${element.metadata.id}/status`
        : `/databases/${element.metadata.id}/status`;
      await this.axiosInstance!.get(endpoint).catch(() => {});

      return [
        new VertraCloudItem("Iniciar", vscode.TreeItemCollapsibleState.None, {
          command: "vertraCloud.project.start",
          title: "Iniciar",
          arguments: [element],
        }),
        new VertraCloudItem("Parar", vscode.TreeItemCollapsibleState.None, {
          command: "vertraCloud.project.stop",
          title: "Parar",
          arguments: [element],
        }),
        new VertraCloudItem("Reiniciar", vscode.TreeItemCollapsibleState.None, {
          command: "vertraCloud.project.restart",
          title: "Reiniciar",
          arguments: [element],
        }),
      ];
    }

    return [];
  }

  refresh(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = setTimeout(() => {
      this._onDidChangeTreeData.fire();
    }, 100);
  }

  clearProjects(): void {
    this.projects = [];
  }

  private async loadProjects() {
    try {
      const userRes = await this.axiosInstance!.get("/users/@me");
      const userData = userRes.data;
      if (userData.status !== "success") return;

      const apps = userData.response.applications || [];
      const dbs = userData.response.databases || [];

      this.projects = [
        ...apps.map((p: any) => ({ ...p, type: "app", running: undefined })),
        ...dbs.map((p: any) => ({ ...p, type: "db", running: undefined })),
      ];

      this.refresh();

      // Fetch statuses after listing projects
      await this.updateStatuses();
    } catch (err: any) {
      vscode.window.showErrorMessage("❌ Falha ao carregar projetos: " + err.message || err);
    }
  }

  private async updateStatuses() {
    if (!this.axiosInstance || this.projects.length === 0) return;

    try {
      const [appsStatusRes, dbsStatusRes] = await Promise.all([
        this.axiosInstance.get("/apps/status").catch(() => ({ data: { response: [] } })),
        this.axiosInstance.get("/databases/status").catch(() => ({ data: { response: [] } })),
      ]);

      const appsStatus = appsStatusRes.data.response || [];
      const dbsStatus = dbsStatusRes.data.response || [];

      let hasChanges = false;
      this.projects.forEach((proj) => {
        const statusList = proj.type === "app" ? appsStatus : dbsStatus;
        const status = statusList.find((s: any) => s.id === proj.id);
        const newRunning = status?.running || false;
        if (proj.running !== newRunning) {
          proj.running = newRunning;
          hasChanges = true;
        }
      });

      if (hasChanges) {
        this.refresh();
      }
    } catch (err: any) {
      console.error("Falha ao atualizar status:", err);
    }
  }

  private startStatusUpdateInterval(): void {
    this.statusUpdateInterval = setInterval(() => {
      this.updateStatuses();
    }, 60 * 1000); // Every 1 minute
  }

  public stopStatusUpdateInterval(): void {
    if (this.statusUpdateInterval) {
      clearInterval(this.statusUpdateInterval);
      this.statusUpdateInterval = null;
    }
  }
}

// === Ativação da extensão ===
export async function activate(context: vscode.ExtensionContext) {
  const secretStorage = context.secrets;

  const provider = new VertraCloudProvider(secretStorage);
  vscode.window.registerTreeDataProvider("vertraCloudExplorer", provider);

  context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.refresh", () => provider.refresh())
  );

  const setApiKey = vscode.commands.registerCommand(
    "vertraCloud.setApiKey",
    async () => {
      const existingKey = await secretStorage.get("vertraCloudApiKey");
      const apiKey = await vscode.window.showInputBox({
        prompt: existingKey
          ? "Já existe uma API Key cadastrada. Digite a nova para atualizar:"
          : "Digite sua API Key da Vertra Cloud",
        ignoreFocusOut: true,
        password: true,
      });

      if (apiKey) {
        await secretStorage.store("vertraCloudApiKey", apiKey);
        provider.clearProjects();
        vscode.window.showInformationMessage(
          existingKey
            ? "🔄 API Key atualizada com sucesso!"
            : "✅ API Key cadastrada com sucesso!"
        );
        provider.refresh();
      }
    }
  );

  const clearApiKey = vscode.commands.registerCommand(
    "vertraCloud.clearApiKey",
    async () => {
      const existingKey = await secretStorage.get("vertraCloudApiKey");
      if (!existingKey) {
        vscode.window.showWarningMessage("⚠️ Nenhuma API Key está cadastrada.");
        return;
      }
      await secretStorage.delete("vertraCloudApiKey");
      provider.clearProjects();
      vscode.window.showInformationMessage("🗑️ API Key removida com sucesso!");
      provider.refresh();
    }
  );

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

  const actions = ["start", "stop", "restart"] as const;
  actions.forEach((action) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(`vertraCloud.project.${action}`, async (item: VertraCloudItem) => {
        vscode.window.showInformationMessage(`🚀 Ação "${action}" acionada no projeto "${item.label}"`);
        try {
          const endpoint = item.metadata.type === "app"
            ? `/apps/${item.metadata.id}/status`
            : `/databases/${item.metadata.id}/status`;
          const statusRes = await provider.axiosInstance!.get(endpoint);
          const status = statusRes.data.response || {};
          const project = provider.projects.find((p) => p.id === item.metadata.id);
          if (project) {
            project.running = status.running || false;
            provider.refresh();
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`❌ Falha ao atualizar status do projeto "${item.label}": ${err.message || err}`);
        }
      })
    );
  });

  context.subscriptions.push({
    dispose: () => provider.stopStatusUpdateInterval()
  });
}

export function deactivate() {}