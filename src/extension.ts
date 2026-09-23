import * as vscode from "vscode";
import { ApiClient } from "./api/client";
import {
  getAppsStatus,
  getDatabasesStatus,
  getMe,
  getRuntimes,
  getServiceStatus,
  getWorkspace,
  getWorkspaces,
} from "./api/endpoints";
import {
  addResourceToFolder,
  createFolder,
  deleteFolder,
  removeResourceFromFolder,
  setFavorite,
  updateFolder,
} from "./api/organization";
import { Session } from "./auth";
import { Store } from "./state";
import { ProjectLinks } from "./project/link";
import { registerConfigLanguage } from "./project/language";
import { RealtimeManager } from "./realtime";
import { registerViews } from "./views/register";
import { StatusBar } from "./status-bar";
import { createDeps, type Deps } from "./commands/index";
import { registerAuthCommands } from "./commands/auth";
import { registerAppsCommands } from "./commands/apps";
import { registerLogsCommands } from "./commands/logs";
import { registerProjectCommands } from "./commands/project";
import { registerLegacyCommands } from "./commands/legacy";
import { registerEnvsCommands } from "./commands/envs";
import { registerSnapshotsCommands } from "./commands/snapshots";
import { registerFilesCommands } from "./commands/files";
import { registerDatabasesCommands } from "./commands/databases";
import { registerWorkspacesCommands } from "./commands/workspaces";
import { registerOrganizationCommands } from "./commands/organization";
import { registerNetworkCommands } from "./commands/network";
import { registerAppsExtraCommands } from "./commands/apps-extra";

interface Lifecycle {
  store: Store;
  realtime: RealtimeManager;
  links: ProjectLinks;
  deps: Deps;
}

let lifecycle: Lifecycle | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<{
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
}> {
  const version = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0.0.0";

  // Ciclo deliberado: o cliente lê o token da sessão, a sessão usa o cliente, e o realtime pede
  // canal às deps, que já carregam o realtime. Todos existem antes de qualquer chamada.
  const refs: { session?: Session; realtime?: RealtimeManager; views?: { refreshAll(): void } } = {};

  const client = new ApiClient(
    (): Promise<string | undefined> => refs.session?.getToken() ?? Promise.resolve(undefined),
    `vertra-cloud-vscode/${version}`,
  );
  const session = new Session(context.secrets, client);
  refs.session = session;

  const store = new Store(
    session,
    {
      getMe: () => getMe(client),
      getWorkspace: (workspaceId) => getWorkspace(client, workspaceId),
      getAppsStatus: () => getAppsStatus(client),
      getDatabasesStatus: () => getDatabasesStatus(client),
      getWorkspaces: () => getWorkspaces(client),
      getServiceStatus: () => getServiceStatus(client),
      getLastRateLimit: () => client.lastRateLimit,
      createFolder: (scope, body) => createFolder(client, body, scope),
      updateFolder: (scope, folderId, body) => updateFolder(client, folderId, body, scope),
      deleteFolder: (scope, folderId) => deleteFolder(client, folderId, scope),
      addResourceToFolder: (scope, folderId, resource) => addResourceToFolder(client, folderId, resource.resource_type, resource.resource_id, scope),
      removeResourceFromFolder: (scope, folderId, resource) => removeResourceFromFolder(client, folderId, resource.resource_type, resource.resource_id, scope),
      setFavorite: (scope, resource, favorite) => setFavorite(client, resource, favorite, scope),
    },
    context.globalState,
  );

  const links = new ProjectLinks(context.workspaceState, context.subscriptions);

  const deps = createDeps(context, {
    client,
    session,
    store,
    links,
    get realtime() {
      return refs.realtime as RealtimeManager;
    },
    refreshViews: () => refs.views?.refreshAll(),
  });

  const realtime = new RealtimeManager(client, (appId, appName) => deps.getChannel(appId, appName));
  refs.realtime = realtime;

  const views = registerViews(context, store, links);
  refs.views = views;
  context.subscriptions.push(new StatusBar(store, links));

  registerConfigLanguage(context, { getRuntimes: () => getRuntimes(client) });

  registerAuthCommands(deps);
  registerAppsCommands(deps);
  registerLogsCommands(deps);
  registerProjectCommands(deps);
  registerLegacyCommands(deps);
  registerEnvsCommands(deps);
  registerSnapshotsCommands(deps);
  registerFilesCommands(deps);
  registerDatabasesCommands(deps);
  registerWorkspacesCommands(deps);
  registerOrganizationCommands(deps);
  registerNetworkCommands(deps);
  registerAppsExtraCommands(deps);

  context.subscriptions.push(
    session.onDidChange(() => {
      void store.refresh();
    }),
    { dispose: () => store.dispose() },
    { dispose: () => realtime.dispose() },
    { dispose: () => deps.disposeChannels() },
    { dispose: () => links.dispose() },
  );

  lifecycle = { store, realtime, links, deps };

  await links.refresh();
  await session.restore();

  return {
    setApiKey: (key: string) => session.connectWithApiKey(key),
    clearApiKey: () => session.disconnect(),
  };
}

export function deactivate(): void {
  lifecycle?.store.dispose();
  lifecycle?.realtime.dispose();
  lifecycle?.deps.disposeChannels();
  lifecycle?.links.dispose();
  lifecycle = undefined;
}
