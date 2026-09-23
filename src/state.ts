import * as vscode from "vscode";
import type {
  APIApplication,
  APIApplicationStatusShort,
  APIDatabase,
  APIDatabaseStatusShort,
  APIStatus,
  APIUserInfoResponse,
  APIWorkspace,
  APIWorkspaceInfoResponse,
  APIWorkspaceResourceFolder,
  APIWorkspaceResourceOrganization,
  APIWorkspaceResourceRef,
  WorkspaceFolderColor,
  WorkspaceResourceType,
} from "@vertracloud/api-types/v1";
import type { ApiErrorLike } from "./l10n";

const LEGACY_FAVORITES_KEY = "vertraCloud.favorites";
const POLL_INTERVAL_MS = 60_000;
const MUTATION_POLL_INTERVAL_MS = 3_000;
const MUTATION_POLL_ATTEMPTS = 5;
const LOW_RATE_LIMIT_THRESHOLD = 5;

/** Contrato estrutural mínimo de `Session` — só o que o Store consome. */
export interface SessionStateLike {
  status: "disconnected" | "connecting" | "connected";
  user?: APIUserInfoResponse;
}
export interface SessionLike {
  readonly state: SessionStateLike;
  readonly onDidChange: vscode.Event<SessionStateLike>;
}

/** Assinatura mínima do que o Store precisa da `ApiClient` para saber se deve pular um tick. */
export interface RateLimitLike {
  remaining?: number;
}

/**
 * Funções finas de `src/api/endpoints.ts` injetadas por quem compõe a extensão — o Store nunca
 * monta URL nem fala com `ApiClient` diretamente.
 */
export interface StoreApi {
  getMe(): Promise<APIUserInfoResponse>;
  getWorkspace?(workspaceId: string): Promise<APIWorkspaceInfoResponse>;
  getAppsStatus(): Promise<APIApplicationStatusShort[]>;
  getDatabasesStatus(): Promise<APIDatabaseStatusShort[]>;
  getWorkspaces(): Promise<APIWorkspace[]>;
  getServiceStatus(): Promise<APIStatus>;
  /** Opcional: usado só para pular um tick de polling sob rate limit apertado. */
  getLastRateLimit?(): RateLimitLike | undefined;
  createFolder?(scope: OrganizationScope, body: { name: string; color?: WorkspaceFolderColor }): Promise<APIWorkspaceResourceFolder>;
  updateFolder?(scope: OrganizationScope, folderId: string, body: { name?: string; color?: WorkspaceFolderColor }): Promise<APIWorkspaceResourceFolder>;
  deleteFolder?(scope: OrganizationScope, folderId: string): Promise<void>;
  addResourceToFolder?(scope: OrganizationScope, folderId: string, resource: APIWorkspaceResourceRef): Promise<APIWorkspaceResourceOrganization>;
  removeResourceFromFolder?(scope: OrganizationScope, folderId: string, resource: APIWorkspaceResourceRef): Promise<APIWorkspaceResourceOrganization>;
  setFavorite?(scope: OrganizationScope, resource: APIWorkspaceResourceRef, favorite: boolean): Promise<APIWorkspaceResourceOrganization>;
}

export type OrganizationResourceType = WorkspaceResourceType;
export type OrganizationScope = { workspaceId?: string };
export type WorkspaceEntry = APIWorkspace & Partial<APIWorkspaceInfoResponse>;

export interface AppEntry {
  app: APIApplication;
  status?: APIApplicationStatusShort;
  favorite: boolean;
}

export interface DbEntry {
  db: APIDatabase;
  status?: APIDatabaseStatusShort;
  favorite: boolean;
}

/** Códigos tolerados na leitura de workspaces: usuário sem o recurso não derruba o resto da carga. */
function isToleratedWorkspaceError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === "API_KEY_SCOPE_DENIED" || (typeof code === "string" && code.startsWith("PLAN_"));
}

function toErrorLike(err: unknown): ApiErrorLike {
  if (err && typeof err === "object" && "code" in err) {return err as ApiErrorLike;}
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
}

export class Store {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private _apps: AppEntry[] = [];
  private _databases: DbEntry[] = [];
  private _workspaces: WorkspaceEntry[] = [];
  private _user?: APIUserInfoResponse;
  private _serviceStatus?: APIStatus;
  private _loading = false;
  private _lastError?: ApiErrorLike;

  private personalOrganization?: APIWorkspaceResourceOrganization;
  private readonly workspaceOrganizations = new Map<string, APIWorkspaceResourceOrganization>();
  private readonly legacyMemento?: vscode.Memento;

  private inFlight?: Promise<void>;
  private windowFocused = true;
  private viewVisible = true;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private sessionSubscription: vscode.Disposable;

  /** Seam de teste: injetável para não esperar 3s reais entre tentativas de `pollAfterMutation`. */
  mutationPollIntervalMs = MUTATION_POLL_INTERVAL_MS;
  /** Seam de teste: injetável para não esperar 60s reais de polling. */
  pollIntervalMs = POLL_INTERVAL_MS;

  constructor(
    private readonly session: SessionLike,
    private readonly api: StoreApi,
    legacyMemento?: vscode.Memento
  ) {
    this.legacyMemento = legacyMemento;
    this.sessionSubscription = this.session.onDidChange((state) => this.handleSessionChange(state));
    if (this.session.state.status === "connected") {
      void this.refresh();
      this.schedulePoll();
    }
  }

  get apps(): AppEntry[] {
    return this._apps;
  }
  get databases(): DbEntry[] {
    return this._databases;
  }
  get workspaces(): WorkspaceEntry[] {
    return this._workspaces;
  }
  get user(): APIUserInfoResponse | undefined {
    return this._user;
  }
  get serviceStatus(): APIStatus | undefined {
    return this._serviceStatus;
  }
  get loading(): boolean {
    return this._loading;
  }
  get connected(): boolean {
    return this.session.state.status === "connected";
  }
  get lastError(): ApiErrorLike | undefined {
    return this._lastError;
  }

  private fire(): void {
    this.emitter.fire();
  }

  private handleSessionChange(state: SessionStateLike): void {
    if (state.status === "connected") {
      void this.refresh();
      this.schedulePoll();
    } else {
      this.clearData();
      this.stopPoll();
      this.updateContextKeys();
      this.fire();
    }
  }

  private clearData(): void {
    this._apps = [];
    this._databases = [];
    this._workspaces = [];
    this._user = undefined;
    this._serviceStatus = undefined;
    this._lastError = undefined;
    this.personalOrganization = undefined;
    this.workspaceOrganizations.clear();
  }

  async refresh(opts?: { statusOnly?: boolean }): Promise<void> {
    if (this.inFlight) {return this.inFlight;}
    const statusOnly = opts?.statusOnly ?? false;
    this.inFlight = this.doRefresh(statusOnly).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doRefresh(statusOnly: boolean): Promise<void> {
    if (this.session.state.status !== "connected") {return;}
    this._loading = true;
    this.fire();
    try {
      if (statusOnly && this._user) {
        await this.applyStatuses();
      } else {
        await this.refreshFull();
      }
      this._lastError = undefined;
    } catch (err) {
      this._lastError = this.session.state.status === "connected" ? toErrorLike(err) : undefined;
    } finally {
      this._loading = false;
      this.updateContextKeys();
      this.fire();
    }
  }

  private async refreshFull(): Promise<void> {
    const user = await this.api.getMe();
    this._user = user;
    this.personalOrganization = user.resource_organization;
    await this.legacyMemento?.update(LEGACY_FAVORITES_KEY, undefined);
    this._apps = user.applications.map((app) => ({ app, favorite: this.isFavorite("application", app.id) }));
    this._databases = user.databases.map((db) => ({ db, favorite: this.isFavorite("database", db.id) }));
    await this.applyStatuses();

    try {
      const workspaces = await this.api.getWorkspaces();
      this._workspaces = await Promise.all(workspaces.map(async (workspace) => {
        if (!this.api.getWorkspace) {return workspace;}
        try {
          const info = await this.api.getWorkspace(workspace.id);
          this.workspaceOrganizations.set(workspace.id, info.resource_organization);
          return { ...workspace, ...info };
        } catch {
          return workspace;
        }
      }));
    } catch (err) {
      if (!isToleratedWorkspaceError(err)) {throw err;}
      this._workspaces = [];
    }

    try {
      this._serviceStatus = await this.api.getServiceStatus();
    } catch {
      // status de serviço nunca derruba o resto da carga
    }
  }

  getOrganization(workspaceId?: string): APIWorkspaceResourceOrganization | undefined {
    return workspaceId ? this.workspaceOrganizations.get(workspaceId) : this.personalOrganization;
  }

  isFavorite(resourceType: APIWorkspaceResourceRef["resource_type"], resourceId: string, workspaceId?: string): boolean {
    return this.getOrganization(workspaceId)?.favorites.some(
      (favorite) => favorite.resource_type === resourceType && favorite.resource_id === resourceId,
    ) ?? false;
  }

  getFolder(folderId: string, workspaceId?: string): APIWorkspaceResourceFolder | undefined {
    return this.getOrganization(workspaceId)?.folders.find((folder) => folder.id === folderId);
  }

  private setOrganization(scope: OrganizationScope, organization: APIWorkspaceResourceOrganization): void {
    if (scope.workspaceId) {
      this.workspaceOrganizations.set(scope.workspaceId, organization);
      this._workspaces = this._workspaces.map((workspace) =>
        workspace.id === scope.workspaceId ? { ...workspace, resource_organization: organization } : workspace,
      );
    } else {
      this.personalOrganization = organization;
      this._apps = this._apps.map((entry) => ({ ...entry, favorite: this.isFavorite("application", entry.app.id) }));
      this._databases = this._databases.map((entry) => ({ ...entry, favorite: this.isFavorite("database", entry.db.id) }));
    }
  }

  private requireOrganization(scope: OrganizationScope): APIWorkspaceResourceOrganization {
    return this.getOrganization(scope.workspaceId) ?? {
      scope: scope.workspaceId ? "workspace" : "personal",
      user_id: this._user?.id ?? "",
      workspace_id: scope.workspaceId ?? null,
      folders: [],
      favorites: [],
    };
  }

  private requireApiMethod<K extends keyof StoreApi>(name: K): NonNullable<StoreApi[K]> {
    const method = this.api[name];
    if (typeof method !== "function") {throw new Error(`Store API method is unavailable: ${String(name)}`);}
    return method as NonNullable<StoreApi[K]>;
  }

  async createFolder(scope: OrganizationScope, body: { name: string; color?: WorkspaceFolderColor }): Promise<APIWorkspaceResourceFolder> {
    const create = this.requireApiMethod("createFolder") as NonNullable<StoreApi["createFolder"]>;
    const previous = this.requireOrganization(scope);
    const folder = await create(scope, body);
    this.setOrganization(scope, { ...previous, folders: [...previous.folders, folder] });
    this.fire();
    return folder;
  }

  async updateFolder(scope: OrganizationScope, folderId: string, body: { name?: string; color?: WorkspaceFolderColor }): Promise<APIWorkspaceResourceFolder> {
    const update = this.requireApiMethod("updateFolder") as NonNullable<StoreApi["updateFolder"]>;
    const previous = this.requireOrganization(scope);
    try {
      const folder = await update(scope, folderId, body);
      this.setOrganization(scope, { ...previous, folders: previous.folders.map((item) => item.id === folderId ? folder : item) });
      this.fire();
      return folder;
    } catch (error) {
      this.setOrganization(scope, previous);
      this.fire();
      throw error;
    }
  }

  async deleteFolder(scope: OrganizationScope, folderId: string): Promise<void> {
    const remove = this.requireApiMethod("deleteFolder") as NonNullable<StoreApi["deleteFolder"]>;
    const previous = this.requireOrganization(scope);
    this.setOrganization(scope, { ...previous, folders: previous.folders.filter((folder) => folder.id !== folderId) });
    this.fire();
    try {
      await remove(scope, folderId);
    } catch (error) {
      this.setOrganization(scope, previous);
      this.fire();
      throw error;
    }
  }

  async setResourceFolder(scope: OrganizationScope, folderId: string, resource: APIWorkspaceResourceRef, present: boolean): Promise<void> {
    const method = present ? this.requireApiMethod("addResourceToFolder") : this.requireApiMethod("removeResourceFromFolder");
    const previous = this.requireOrganization(scope);
    try {
      const organization = await (method as NonNullable<StoreApi["addResourceToFolder"]>)(scope, folderId, resource);
      this.setOrganization(scope, organization);
      this.fire();
    } catch (error) {
      this.setOrganization(scope, previous);
      this.fire();
      throw error;
    }
  }

  async toggleFavorite(resourceType: APIWorkspaceResourceRef["resource_type"], resourceId: string, workspaceId?: string): Promise<void> {
    const scope = { workspaceId };
    const favorite = !this.isFavorite(resourceType, resourceId, workspaceId);
    const method = this.requireApiMethod("setFavorite") as NonNullable<StoreApi["setFavorite"]>;
    const previous = this.requireOrganization(scope);
    const optimistic: APIWorkspaceResourceOrganization = {
      ...previous,
      favorites: favorite
        ? [...previous.favorites, { resource_type: resourceType, resource_id: resourceId, position: previous.favorites.length, created_at: new Date().toISOString() }]
        : previous.favorites.filter((item) => !(item.resource_type === resourceType && item.resource_id === resourceId)),
    };
    this.setOrganization(scope, optimistic);
    this.fire();
    try {
      this.setOrganization(scope, await method(scope, { resource_type: resourceType, resource_id: resourceId }, favorite));
      this.fire();
    } catch (error) {
      this.setOrganization(scope, previous);
      this.fire();
      throw error;
    }
  }

  private async applyStatuses(): Promise<void> {
    const [appsStatus, dbsStatus] = await Promise.all([this.api.getAppsStatus(), this.api.getDatabasesStatus()]);
    const appStatusMap = new Map(appsStatus.map((s) => [s.id, s] as const));
    this._apps = this._apps.map((entry) => ({ ...entry, status: appStatusMap.get(entry.app.id) }));
    const dbStatusMap = new Map(dbsStatus.map((s) => [s.id, s] as const));
    this._databases = this._databases.map((entry) => ({ ...entry, status: dbStatusMap.get(entry.db.id) }));
  }

  /** Nunca escreve estado otimista: só reflete o que a própria API confirmar. */
  async pollAfterMutation(appId: string, expect: "up" | "down"): Promise<void> {
    for (let attempt = 0; attempt < MUTATION_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) {await this.delay(this.mutationPollIntervalMs);}
      let statuses: APIApplicationStatusShort[];
      try {
        statuses = await this.api.getAppsStatus();
      } catch {
        continue;
      }
      const appStatusMap = new Map(statuses.map((s) => [s.id, s] as const));
      this._apps = this._apps.map((entry) => ({ ...entry, status: appStatusMap.get(entry.app.id) ?? entry.status }));
      this.fire();
      const current = appStatusMap.get(appId);
      if (current && ((expect === "up" && current.running) || (expect === "down" && !current.running))) {return;}
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  setWindowFocus(focused: boolean): void {
    this.windowFocused = focused;
    this.reschedulePollFromVisibility();
  }

  setViewVisible(visible: boolean): void {
    this.viewVisible = visible;
    this.reschedulePollFromVisibility();
  }

  private reschedulePollFromVisibility(): void {
    if (this.session.state.status !== "connected") {return;}
    if (this.isPollEligible()) {
      if (!this.pollTimer) {
        void this.refresh({ statusOnly: true });
        this.schedulePoll();
      }
    } else {
      this.stopPoll();
    }
  }

  private isPollEligible(): boolean {
    return this.windowFocused && this.viewVisible && this.session.state.status === "connected";
  }

  private schedulePoll(delayMs = this.pollIntervalMs): void {
    this.stopPoll();
    if (!this.isPollEligible()) {return;}
    this.pollTimer = setTimeout(() => void this.pollTick(), delayMs);
  }

  private async pollTick(): Promise<void> {
    if (!this.isPollEligible()) {
      this.pollTimer = undefined;
      return;
    }
    const rateLimit = this.api.getLastRateLimit?.();
    if (rateLimit && rateLimit.remaining !== undefined && rateLimit.remaining < LOW_RATE_LIMIT_THRESHOLD) {
      this.schedulePoll();
      return;
    }
    await this.refresh({ statusOnly: true });
    const retryAfter = this._lastError?.retryAfter;
    const nextDelay =
      this._lastError?.code === "RATE_LIMIT_EXCEEDED" && retryAfter ? retryAfter * 1000 : this.pollIntervalMs;
    this.schedulePoll(nextDelay);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private updateContextKeys(): void {
    const connected = this.session.state.status === "connected";
    void vscode.commands.executeCommand("setContext", "vertraCloud.connected", connected);
    void vscode.commands.executeCommand("setContext", "vertraCloud.appsEmpty", connected && this._apps.length === 0);
    void vscode.commands.executeCommand(
      "setContext",
      "vertraCloud.dbsEmpty",
      connected && this._databases.length === 0
    );
  }

  dispose(): void {
    this.stopPoll();
    this.sessionSubscription.dispose();
    this.emitter.dispose();
  }
}
