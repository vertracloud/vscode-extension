import * as vscode from "vscode";
import {
  APIApplicationStatus,
  APIDatabaseStatus,
  APIDatabase,
  APIApplication,
  APIUserInfoResponse,
  APIPayload,
} from "@vertracloud/api-types/v1";
import { VertraCloudItemMetadata } from "./@types";

class VertraCloudItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly contextValue?: string,
    public readonly metadata?: VertraCloudItemMetadata,
    iconPath?: vscode.ThemeIcon,
    private _children?: VertraCloudItem[]
  ) {
    super(label, collapsibleState);
    if (iconPath) this.iconPath = iconPath;
    if (command) this.command = command;
  }

  get children(): VertraCloudItem[] | undefined {
    return this._children;
  }

  set children(value: VertraCloudItem[] | undefined) {
    this._children = value;
  }
}

class VertraCloudProvider implements vscode.TreeDataProvider<VertraCloudItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    VertraCloudItem | undefined | void
  > = new vscode.EventEmitter<VertraCloudItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<VertraCloudItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private readonly apps: APIApplication[] = [];
  private readonly dbs: APIDatabase[] = [];
  private readonly baseURL: string = "https://api.vertracloud.app/v1";

  constructor(
    private readonly secretStorage: vscode.SecretStorage,
    private readonly type: "app" | "db"
  ) {}

  getTreeItem(element: VertraCloudItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: VertraCloudItem): Promise<VertraCloudItem[]> {
    const apiKey: string | undefined = await this.secretStorage.get("vertraCloudApiKey");
    if (!apiKey) {
      vscode.window.showWarningMessage(
        "Nenhuma API Key configurada. Por favor, execute o comando 'Vertra Cloud: Cadastrar ou Atualizar API Key'."
      );
      await vscode.commands.executeCommand("vertraCloud.setApiKey");
      return [];
    }

    if (!element) {
      if (this.apps.length === 0 && this.dbs.length === 0) {
        await this.loadProjects(apiKey);
      }

      if (this.type === "app") {
        return this.apps.map((app: APIApplication) => {
          const isUp: boolean = app.status === "up";
          const icon: vscode.ThemeIcon = new vscode.ThemeIcon(
            "circle-filled",
            new vscode.ThemeColor(isUp ? "charts.green" : "charts.red")
          );

          return new VertraCloudItem(
            `${app.name} (${app.id})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            undefined,
            isUp ? "appOnline" : "appOffline",
            app,
            icon
          );
        });
      } else {
        return this.dbs.map((db: APIDatabase) => {
          const icon: vscode.ThemeIcon = new vscode.ThemeIcon(
            "circle-filled",
            new vscode.ThemeColor(db.status === "up" ? "charts.green" : "charts.red")
          );
          return new VertraCloudItem(
            db.name,
            vscode.TreeItemCollapsibleState.Collapsed,
            undefined,
            "db",
            db,
            icon
          );
        });
      }
    }

    if (!element.metadata) {
      return element.children || [];
    }

    const statusEndpoint: string =
      this.type === "app"
        ? `${this.baseURL}/apps/${element.metadata.id}/status`
        : `${this.baseURL}/databases/${element.metadata.id}/status`;

    let statusData: APIApplicationStatus | APIDatabaseStatus | undefined;

    try {
      const response: Response = await fetch(statusEndpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: APIPayload<APIApplicationStatus | APIDatabaseStatus> = await response.json() as APIPayload<APIApplicationStatus | APIDatabaseStatus>;
      statusData = data.response;
    } catch (err: unknown) {
      statusData = {
        id: "0",
        running: false,
        ram: "0",
        cpu: "0",
        uptime: 0,
        network: { total: "0KB ↓ 0KB ↑", now: "0KB ↑ 0KB ↓" },
        status: "down",
        storage: "0 MB",
      };
    }

    if (statusData) {
      const children: VertraCloudItem[] = [];
      if (this.type === "app") {
        const userApp = this.apps.find((a) => a.id === element.metadata?.id);
        const ramLimit: string = userApp?.ram
          ? `${userApp.ram}MB`
          : `${statusData.ram.replace(/\s+/g, "")}`;

        const statusItem: VertraCloudItem = new VertraCloudItem(
          `${statusData.running ? "Ligado" : "Desligado"}`,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          new vscode.ThemeIcon("pulse")
        );
        statusItem.description = "Status";
        children.push(statusItem);

        const ramItem: VertraCloudItem = new VertraCloudItem(
          `${parseFloat(statusData.ram).toFixed(1)}MB/${ramLimit}`,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          new vscode.ThemeIcon("server")
        );
        ramItem.description = "RAM";
        children.push(ramItem);

        const cpuItem: VertraCloudItem = new VertraCloudItem(
          `${parseFloat(statusData.cpu).toFixed(2)}%`,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          new vscode.ThemeIcon("device-desktop")
        );
        cpuItem.description = "CPU";
        children.push(cpuItem);

        const uptimeMin: number = Math.floor((statusData.uptime || 0) / 60);
        const uptimeItem: VertraCloudItem = new VertraCloudItem(
          `${uptimeMin} min`,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          new vscode.ThemeIcon("clock")
        );
        uptimeItem.description = "Uptime";
        children.push(uptimeItem);
      }

      return children;
    }

    return element.children || [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async loadProjects(apiKey: string): Promise<void> {
    try {
      const response: Response = await fetch(`${this.baseURL}/users/@me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const userData: APIPayload<APIUserInfoResponse> = await response.json() as APIPayload<APIUserInfoResponse>;
      if (!userData.response) return;

      this.apps.length = 0;
      this.dbs.length = 0;
      this.apps.push(...(userData.response.applications || []));
      this.dbs.push(...(userData.response.databases || []));
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Erro ao carregar projetos: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async viewLogs(app: VertraCloudItemMetadata, apiKey: string): Promise<void> {
    try {
      const response: Response = await fetch(`${this.baseURL}/apps/${app.id}/logs`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: APIPayload<string> = await response.json() as APIPayload<string>;
      const logs: string = data.response || "Nenhum log disponível";
      const outputChannel: vscode.OutputChannel = vscode.window.createOutputChannel(`Logs: ${app.name}`);
      outputChannel.append(logs);
      outputChannel.show();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Falha ao carregar logs: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async sendPostRequest(endpoint: string, apiKey: string): Promise<void> {
    try {
      const response: Response = await fetch(`${this.baseURL}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err: unknown) {
      throw err;
    }
  }

  getApps(): APIApplication[] {
    return this.apps;
  }

  clearProjects(): void {
    this.apps.length = 0;
    this.dbs.length = 0;
    this._onDidChangeTreeData.fire();
  }
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<{
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
}> {
  const secretStorage: vscode.SecretStorage = context.secrets;

  const appsProvider: VertraCloudProvider = new VertraCloudProvider(secretStorage, "app");
  const dbsProvider: VertraCloudProvider = new VertraCloudProvider(secretStorage, "db");

  vscode.window.registerTreeDataProvider("vertraCloudApps", appsProvider);
  vscode.window.registerTreeDataProvider("vertraCloudDBs", dbsProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.setApiKey", async () => {
      const existingKey: string | undefined = await secretStorage.get("vertraCloudApiKey");
      const apiKey: string | undefined = await vscode.window.showInputBox({
        prompt: existingKey ? "Digite a nova API Key" : "Digite sua API Key da Vertra Cloud",
        ignoreFocusOut: true,
        password: true,
      });

      if (apiKey) {
        await secretStorage.store("vertraCloudApiKey", apiKey);
        await Promise.all([appsProvider.loadProjects(apiKey), dbsProvider.loadProjects(apiKey)]);
        appsProvider.refresh();
        dbsProvider.refresh();
        vscode.window.showInformationMessage(
          existingKey ? "API Key atualizada" : "API Key cadastrada"
        );
      }
    }),

    vscode.commands.registerCommand("vertraCloud.clearApiKey", async () => {
      const existingKey: string | undefined = await secretStorage.get("vertraCloudApiKey");
      if (!existingKey) {
        vscode.window.showWarningMessage("Nenhuma API Key está cadastrada.");
        return;
      }
      await secretStorage.delete("vertraCloudApiKey");
      appsProvider.clearProjects();
      dbsProvider.clearProjects();
      vscode.window.showInformationMessage("API Key removida com sucesso!");
    }),

    vscode.commands.registerCommand("vertraCloud.project.viewLogs", async (data: VertraCloudItem) => {
      const apiKey: string | undefined = await secretStorage.get("vertraCloudApiKey");
      if (!apiKey || !data.metadata) return;
      await appsProvider.viewLogs(data.metadata, apiKey);
    }),

    vscode.commands.registerCommand("vertraCloud.project.stopApp", async (item: VertraCloudItem) => {
      if (!item.metadata) return;
      const app: VertraCloudItemMetadata = item.metadata;
      const apiKey: string | undefined = await secretStorage.get("vertraCloudApiKey");
      if (!apiKey) return;
      try {
        await appsProvider.sendPostRequest(`/apps/${app.id}/stop`, apiKey);
        vscode.window.showInformationMessage(`App ${app.name} parado com sucesso.`);
        const target = appsProvider.getApps().find((a) => a.id === app.id);
        if (target) target.status = "down";
        item.iconPath = new vscode.ThemeIcon("loading~spin");
        appsProvider.refresh();
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Falha ao parar o app: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("vertraCloud.project.startApp", async (item: VertraCloudItem) => {
      if (!item.metadata) return;
      const app: VertraCloudItemMetadata = item.metadata;
      const apiKey: string | undefined = await secretStorage.get("vertraCloudApiKey");
      if (!apiKey) return;
      try {
        await appsProvider.sendPostRequest(`/apps/${app.id}/start`, apiKey);
        vscode.window.showInformationMessage(`App ${app.name} iniciado com sucesso.`);
        const target = appsProvider.getApps().find((a) => a.id === app.id);
        if (target) target.status = "up";
        item.iconPath = new vscode.ThemeIcon("loading~spin");
        appsProvider.refresh();
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Falha ao iniciar o app: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("vertraCloud.project.restartApp", async (item: VertraCloudItem) => {
      if (!item.metadata) return;
      const app: VertraCloudItemMetadata = item.metadata;
      const apiKey: string | undefined = await secretStorage.get("vertraCloudApiKey");
      if (!apiKey) return;
      try {
        await appsProvider.sendPostRequest(`/apps/${app.id}/restart`, apiKey);
        vscode.window.showInformationMessage(`App ${app.name} reiniciado com sucesso.`);
        item.iconPath = new vscode.ThemeIcon("loading~spin");
        appsProvider.refresh();
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Falha ao reiniciar o app: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  return {
    setApiKey: async (apiKey: string) => {
      await secretStorage.store("vertraCloudApiKey", apiKey);
      await Promise.all([appsProvider.loadProjects(apiKey), dbsProvider.loadProjects(apiKey)]);
      appsProvider.refresh();
      dbsProvider.refresh();
    },
    clearApiKey: async () => {
      await secretStorage.delete("vertraCloudApiKey");
      appsProvider.clearProjects();
      dbsProvider.clearProjects();
    },
  };
}

export function deactivate(): void {}
