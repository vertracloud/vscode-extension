import * as vscode from "vscode";
import axios, { AxiosInstance } from "axios";
import { APIApplicationStatus, APIApplicationStatusShort, APIDatabaseStatus } from "@vertracloud/api-types/v1";

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
    this.contextValue = contextValue;
    this.metadata = metadata;
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
  private _onDidChangeTreeData: vscode.EventEmitter<VertraCloudItem | undefined | void> =
    new vscode.EventEmitter<VertraCloudItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<VertraCloudItem | undefined | void> =
    this._onDidChangeTreeData.event;

  public apps: any[] = [];
  public dbs: any[] = [];
  public userApps: Record<string, APIApplicationStatusShort> = {};
  public axiosInstance: AxiosInstance | null = null;
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
      if (this.apps.length === 0 && this.dbs.length === 0) {
        await this.loadProjects();
      }

      const appParent = new VertraCloudItem(
        "Aplicações",
        vscode.TreeItemCollapsibleState.Expanded,
        undefined,
        "parent-apps",
        undefined,
        new vscode.ThemeIcon("package")
      );
      appParent.children = this.apps.map((app) => {
        const running = app.running;
        const statusIcon = running
          ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));

        const appItem = new VertraCloudItem(
          `${app.name} (${app.id})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          "app",
          app,
          statusIcon
        );

        return appItem
      });

      const dbParent = new VertraCloudItem(
        "Bancos de Dados",
        vscode.TreeItemCollapsibleState.Collapsed,
        undefined,
        "parent-dbs",
        undefined,
        new vscode.ThemeIcon("database")
      );
      dbParent.children = this.dbs.map((db) => {
        const running = db.running;
        const icon = running
          ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));

        return new VertraCloudItem(
          db.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          "db",
          db,
          icon
        );
      });

      return [appParent, dbParent];
    }

    if (element.contextValue === "app" || element.contextValue === "db") {
      const statusEndpoint = element.contextValue === "app"
        ? `/apps/${element.metadata.id}/status`
        : `/databases/${element.metadata.id}/status`;

      const statusRes = await this.axiosInstance!.get(statusEndpoint).catch(() => null);
      const statusData = statusRes?.data?.response as APIApplicationStatus | APIDatabaseStatus | undefined;

      if (statusData) {
        const children: VertraCloudItem[] = [];
        const userApp = this.userApps[element.metadata.id];
        const ramLimit = userApp?.ram || statusData.ram;

        children.push(
          new VertraCloudItem(
            `Status: ${statusData.running ? "Ligado" : "Desligado"}`,
            vscode.TreeItemCollapsibleState.None,
            undefined,
            undefined,
            undefined,
            new vscode.ThemeIcon("pulse")
          )
        );

        children.push(
          new VertraCloudItem(
            `${parseFloat(statusData.ram).toFixed(2)}MB / ${ramLimit}MB RAM`,
            vscode.TreeItemCollapsibleState.None,
            undefined,
            undefined,
            undefined,
            new vscode.ThemeIcon("server")
          )
        );

        const uptimeMin = Math.floor((statusData.uptime || 0) / 60);
        children.push(
          new VertraCloudItem(
            `Uptime: ${uptimeMin} min`,
            vscode.TreeItemCollapsibleState.None,
            undefined,
            undefined,
            undefined,
            new vscode.ThemeIcon("clock")
          )
        );

        return children;
      }
    }

    return element.children || [];
  }

  refresh(): void {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(() => this._onDidChangeTreeData.fire(), 100);
  }

  clearProjects(): void {
    this.apps = [];
    this.dbs = [];
    this.userApps = {};
  }

  private async loadProjects() {
    try {
      const userRes = await this.axiosInstance!.get("/users/@me");
      const userData = userRes.data;
      if (userData.status !== "success") return;

      this.apps = (userData.response.applications || []).map((p: any) => ({ ...p, type: "app", running: false }));
      this.dbs = (userData.response.databases || []).map((p: any) => ({ ...p, type: "db", running: false }));

      this.userApps = {};
      this.apps.forEach((app: any) => {
        this.userApps[app.id] = {
          id: app.id,
          cpu: app.cpu || "0%",
          ram: app.ram || "0",
          running: app.running || false
        };
      });

      this.refresh();
      await this.updateStatuses();
    } catch (err: any) {
      vscode.window.showErrorMessage("❌ Falha ao carregar projetos: " + err.message || err);
    }
  }

  private async updateStatuses() {
    if (!this.axiosInstance) return;

    try {
      const [appsStatusRes, dbsStatusRes] = await Promise.all([
        this.axiosInstance.get("/apps/status").catch(() => ({ data: { response: [] } })),
        this.axiosInstance.get("/databases/status").catch(() => ({ data: { response: [] } })),
      ]);

      const appsStatus = appsStatusRes.data.response || [];
      const dbsStatus = dbsStatusRes.data.response || [];

      let hasChanges = false;
      this.apps.forEach((app) => {
        const status = appsStatus.find((s: any) => s.id === app.id);
        const running = status?.running || false;
        if (app.running !== running) {
          app.running = running;
          hasChanges = true;
        }
      });

      this.dbs.forEach((db) => {
        const status = dbsStatus.find((s: any) => s.id === db.id);
        const running = status?.running || false;
        if (db.running !== running) {
          db.running = running;
          hasChanges = true;
        }
      });

      if (hasChanges) this.refresh();
    } catch (err) {
      console.error("Falha ao atualizar status:", err);
    }
  }

  private startStatusUpdateInterval(): void {
    this.statusUpdateInterval = setInterval(() => this.updateStatuses(), 60 * 1000);
  }

  public stopStatusUpdateInterval(): void {
    if (this.statusUpdateInterval) clearInterval(this.statusUpdateInterval);
  }

  public async viewLogs(app: any): Promise<void> {
    try {
      const logsRes = await this.axiosInstance!.get(`/apps/${app.id}/logs`);
      const logs = logsRes.data?.response || "Nenhum log disponível";
      const outputChannel = vscode.window.createOutputChannel(`Logs: ${app.name}`);
      outputChannel.append(logs);
      outputChannel.show();
    } catch (err: any) {
      vscode.window.showErrorMessage(`❌ Falha ao carregar logs:`, err.message || err);
    }
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const secretStorage = context.secrets;
  const provider = new VertraCloudProvider(secretStorage);
  vscode.window.registerTreeDataProvider("vertraCloudExplorer", provider);

  context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.setApiKey", async () => {
      const existingKey = await secretStorage.get("vertraCloudApiKey");
      const apiKey = await vscode.window.showInputBox({
        prompt: existingKey ? "Digite a nova API Key para atualizar" : "Digite sua API Key da Vertra Cloud",
        ignoreFocusOut: true,
        password: true,
      });
      if (apiKey) {
        await secretStorage.store("vertraCloudApiKey", apiKey);
        provider.clearProjects();
        provider.refresh();
        vscode.window.showInformationMessage(existingKey ? "🔄 API Key atualizada" : "✅ API Key cadastrada");
      }
    }),
    vscode.commands.registerCommand("vertraCloud.clearApiKey", async () => {
      await secretStorage.delete("vertraCloudApiKey");
      provider.clearProjects();
      provider.refresh();
      vscode.window.showInformationMessage("🗑️ API Key removida");
    }),
    vscode.commands.registerCommand("vertraCloud.showApiKey", async () => {
      const apiKey = await secretStorage.get("vertraCloudApiKey");
      vscode.window.showInformationMessage(apiKey ? `🔑 API Key: ${apiKey}` : "⚠️ Nenhuma API Key cadastrada");
    }),
    vscode.commands.registerCommand("vertraCloud.project.viewLogs", async (data) => {
      await provider.viewLogs(data.metadata);
    })
  );

  context.subscriptions.push({ dispose: () => provider.stopStatusUpdateInterval() });
}

export function deactivate() {}