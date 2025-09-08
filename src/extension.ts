import * as vscode from "vscode";
import axios, { AxiosInstance } from "axios";
import { APIApplicationStatus, APIDatabaseStatus, APIDatabase, APIApplication } from "@vertracloud/api-types/v1";

class VertraCloudItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly contextValue?: string,
    public readonly metadata?: any,
    public readonly iconPath?: vscode.ThemeIcon,
    public _children?: VertraCloudItem[]
  ) {
    super(label, collapsibleState);
    if (iconPath) this.iconPath = iconPath;
    if (command) this.command = command;
  }

  get children(): VertraCloudItem[] | undefined { return this._children; }
  set children(value: VertraCloudItem[] | undefined) { this._children = value; }
}

class VertraCloudProvider implements vscode.TreeDataProvider<VertraCloudItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<VertraCloudItem | undefined | void> =
    new vscode.EventEmitter<VertraCloudItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<VertraCloudItem | undefined | void> = this._onDidChangeTreeData.event;

  public apps: APIApplication[] = [];
  public dbs: APIDatabase[] = [];
  public axiosInstance: AxiosInstance | null = null;

  constructor(private secretStorage: vscode.SecretStorage, private type: "app" | "db") {}

  getTreeItem(element: VertraCloudItem): vscode.TreeItem { return element; }

  async getChildren(element?: VertraCloudItem): Promise<VertraCloudItem[]> {
    const apiKey = await this.secretStorage.get("vertraCloudApiKey");
    if (!apiKey) { await vscode.commands.executeCommand("vertraCloud.setApiKey"); return []; }
    if (!this.axiosInstance) this.axiosInstance = axios.create({ baseURL: "https://api.vertracloud.app/v1", headers: { Authorization: `Bearer ${apiKey}` }});

    if (!element) {
      if (this.apps.length === 0 && this.dbs.length === 0) await this.loadProjects();

      if (this.type === "app") {
        return this.apps.map((app) => {
          const isUp = app.status === "up";
          const icon = new vscode.ThemeIcon(
            "circle-filled",
            new vscode.ThemeColor(isUp ? "charts.green" : "charts.red")
          );

          const item = new VertraCloudItem(
            `${app.name} (${app.id})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            undefined,
            isUp ? "appOnline" : "appOffline",
            app,
            icon
          );

          return item;
        });

      } else {
        return this.dbs.map((db) => {
          const icon = db.status === "up"
            ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
            : new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
          return new VertraCloudItem(db.name, vscode.TreeItemCollapsibleState.Collapsed, undefined, "db", db, icon);
        });
      }
    }

    const statusEndpoint = this.type === "app"
      ? `/apps/${element.metadata.id}/status`
      : `/databases/${element.metadata.id}/status`;

    let statusData: APIApplicationStatus | APIDatabaseStatus | undefined;

    try {
      const statusRes = await this.axiosInstance!.get(statusEndpoint);
      statusData = statusRes.data?.response;
    } catch (err: any) {
      if (err.response?.status === 404 && this.type === "app") {
        statusData = {
          running: false,
          ram: "0",
          cpu: "0",
          uptime: 0,
          created_at: new Date().toISOString(),
          "network": {
            "total": "569.90KB ↓ 36.41KB ↑",
            "now": "18.78KB ↑ 1.20KB ↓"
          },
          status: "down",
          storage: "0 MB",
          updated_at: new Date().toISOString(),
        }
      } else {
        vscode.window.showErrorMessage(`Erro ao obter status do app: ${err.message || err}`);
        return element.children || [];
      }
    }

    if (statusData) {
      const children: VertraCloudItem[] = [];
      if (this.type === "app") {
        const userApp = this.apps.find(a => a.id === element.metadata.id);
        const ramLimit = `${userApp?.ram}MB` || `${statusData.ram.replace(/\s+/g, "")}`;

        // Status
        const statusItem = new VertraCloudItem(
          `${statusData.running ? "Ligado" : "Desligado"}`,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          new vscode.ThemeIcon("pulse")
        );
        statusItem.description = 'Status';
        children.push(statusItem);

        // Memória
        const ramItem = new VertraCloudItem(
          `${parseFloat(statusData.ram).toFixed(1)}MB/${ramLimit}`, 
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          new vscode.ThemeIcon("server")
        );
        ramItem.description = 'RAM';
        children.push(ramItem);
        
        // CPU
        const cpuItem = new VertraCloudItem(
          `${parseFloat(statusData.cpu).toFixed(2)}%`, 
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          new vscode.ThemeIcon("device-desktop")
        );
        cpuItem.description = 'CPU';
        children.push(cpuItem);

        // Uptime
        const uptimeMin = Math.floor((statusData.uptime || 0) / 60);
        const uptimeItem = new VertraCloudItem(
          `${uptimeMin} min`,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          undefined,
          new vscode.ThemeIcon("clock")
        )
        uptimeItem.description = `Uptime`;
        children.push(uptimeItem);
      }

      return children;
    }

    return element.children || [];
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  async loadProjects() {
    if (!this.axiosInstance) return;
    const userRes = await this.axiosInstance.get("/users/@me");
    const userData = userRes.data;
    if (userData.status !== "success") return;

    this.apps = userData.response.applications || [];
    this.dbs = userData.response.databases || [];
  }

  public async viewLogs(app: any): Promise<void> {
    try {
      const logsRes = await this.axiosInstance!.get(`/apps/${app.id}/logs`);
      const logs = logsRes.data?.response || "Nenhum log disponível";
      const outputChannel = vscode.window.createOutputChannel(`Logs: ${app.name}`);
      outputChannel.append(logs);
      outputChannel.show();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Falha ao carregar logs: ${err.message || err}`);
    }
  }
}

// ------------------------- ACTIVATE -------------------------
export async function activate(context: vscode.ExtensionContext) {
  const secretStorage = context.secrets;

  const appsProvider = new VertraCloudProvider(secretStorage, "app");
  const dbsProvider = new VertraCloudProvider(secretStorage, "db");

  vscode.window.registerTreeDataProvider("vertraCloudApps", appsProvider);
  vscode.window.registerTreeDataProvider("vertraCloudDBs", dbsProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.setApiKey", async () => {
      const existingKey = await secretStorage.get("vertraCloudApiKey");
      const apiKey = await vscode.window.showInputBox({ prompt: existingKey ? "Digite a nova API Key" : "Digite sua API Key da Vertra Cloud", ignoreFocusOut: true, password: true });
      if (apiKey) {
        await secretStorage.store("vertraCloudApiKey", apiKey);
        appsProvider.loadProjects(); appsProvider.refresh();
        dbsProvider.loadProjects(); dbsProvider.refresh();
        vscode.window.showInformationMessage(existingKey ? "🔄 API Key atualizada" : "API Key cadastrada");
      }
    }),
    vscode.commands.registerCommand("vertraCloud.project.viewLogs", async (data) => appsProvider.viewLogs(data.metadata)),
    vscode.commands.registerCommand("vertraCloud.project.stopApp", async (item) => {
      const app = item.metadata;
      try {
        await appsProvider.axiosInstance!.post(`/apps/${app.id}/stop`);
        vscode.window.showInformationMessage(`App ${app.name} parado com sucesso.`);

        const target = appsProvider.apps.find(a => a.id === app.id);
        if (target) target.status = "down";

        item.iconPath = new vscode.ThemeIcon("loading~spin");
        appsProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Falha ao parar o app: ${err.message || err}`);
      }
    }),

    vscode.commands.registerCommand("vertraCloud.project.startApp", async (item) => {
      const app = item.metadata;
      try {
        await appsProvider.axiosInstance!.post(`/apps/${app.id}/start`);
        vscode.window.showInformationMessage(`App ${app.name} iniciado com sucesso.`);

        const target = appsProvider.apps.find(a => a.id === app.id);
        if (target) target.status = "up";

        item.iconPath = new vscode.ThemeIcon("loading~spin");
        appsProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Falha ao iniciar o app: ${err.message || err}`);
      }
    }),

    vscode.commands.registerCommand("vertraCloud.project.restartApp", async (item) => {
      const app = item.metadata;
      try {
        await appsProvider.axiosInstance!.post(`/apps/${app.id}/restart`);
        vscode.window.showInformationMessage(`App ${app.name} reiniciado com sucesso.`);
        appsProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Falha ao reiniciar o app: ${err.message || err}`);
      }
    })
  );
}

export function deactivate() {}
