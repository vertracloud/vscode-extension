import * as vscode from "vscode";
import type {
  APIApplication,
  APIDatabase,
  APIWorkspaceResourceFolder,
  APIWorkspaceResourceRef,
  WorkspaceFolderColor,
} from "@vertracloud/api-types/v1";
import type { CommandDeps } from "./deps";
import { register, workspaceIdOf } from "./index";
import type { OrganizationScope } from "../state";

const COLORS: WorkspaceFolderColor[] = ["neutral", "red", "orange", "yellow", "green", "blue", "purple"];

function scopeOf(arg: unknown): OrganizationScope {
  const workspaceId = workspaceIdOf(arg);
  return workspaceId ? { workspaceId } : {};
}

function folderIdOf(arg: unknown): string | undefined {
  if (!arg || typeof arg !== "object") {return undefined;}
  const value = (arg as { kind?: string; folderId?: unknown }).folderId;
  return typeof value === "string" ? value : undefined;
}

function resourceOf(arg: unknown): APIWorkspaceResourceRef | undefined {
  if (!arg || typeof arg !== "object") {return undefined;}
  const node = arg as { kind?: string; appId?: unknown; dbId?: unknown; app?: APIApplication; db?: APIDatabase };
  if (node.kind === "app" && node.app?.id) {return { resource_type: "application", resource_id: node.app.id };}
  if (node.kind === "db" && node.db?.id) {return { resource_type: "database", resource_id: node.db.id };}
  if (node.kind === "app" && typeof node.appId === "string") {return { resource_type: "application", resource_id: node.appId };}
  if (node.kind === "db" && typeof node.dbId === "string") {return { resource_type: "database", resource_id: node.dbId };}
  return undefined;
}

async function pickScope(deps: CommandDeps): Promise<OrganizationScope | undefined> {
  const workspaces = deps.store.workspaces;
  const pick = await vscode.window.showQuickPick([
    { label: vscode.l10n.t("Personal organization"), scope: {} },
    ...workspaces.map((workspace) => ({ label: workspace.name, description: workspace.id, scope: { workspaceId: workspace.id } })),
  ], { placeHolder: vscode.l10n.t("Choose where to organize resources") });
  return pick?.scope;
}

async function resolveScope(deps: CommandDeps, arg: unknown): Promise<OrganizationScope | undefined> {
  if (workspaceIdOf(arg)) {return scopeOf(arg);}
  return pickScope(deps);
}

async function pickFolder(deps: CommandDeps, scope: OrganizationScope): Promise<APIWorkspaceResourceFolder | undefined> {
  const folders = deps.store.getOrganization(scope.workspaceId)?.folders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("No folders available."));
    return undefined;
  }
  if (folders.length === 1) {return folders[0];}
  const pick = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.color, folder })),
    { placeHolder: vscode.l10n.t("Select a folder") },
  );
  return pick?.folder;
}

async function pickResource(deps: CommandDeps, scope: OrganizationScope): Promise<APIWorkspaceResourceRef | undefined> {
  const resources: APIWorkspaceResourceRef[] = scope.workspaceId
    ? (() => {
      const workspace = deps.store.workspaces.find((entry) => entry.id === scope.workspaceId);
      return [
        ...(workspace?.applications ?? []).map((app) => ({ resource_type: "application" as const, resource_id: app.id })),
        ...(workspace?.databases ?? []).map((db) => ({ resource_type: "database" as const, resource_id: db.id })),
      ];
    })()
    : [
      ...deps.store.apps.map((entry) => ({ resource_type: "application" as const, resource_id: entry.app.id })),
      ...deps.store.databases.map((entry) => ({ resource_type: "database" as const, resource_id: entry.db.id })),
    ];
  const names = new Map<string, string>([
    ...deps.store.apps.map((entry) => [`application:${entry.app.id}`, entry.app.name] as const),
    ...deps.store.databases.map((entry) => [`database:${entry.db.id}`, entry.db.name] as const),
  ]);
  const pick = await vscode.window.showQuickPick(
    resources.map((resource) => ({
      label: names.get(`${resource.resource_type}:${resource.resource_id}`) ?? resource.resource_id,
      description: resource.resource_type,
      resource,
    })),
    { placeHolder: vscode.l10n.t("Select a resource") },
  );
  return pick?.resource;
}

async function createFolderCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const scope = await resolveScope(deps, arg);
  if (!scope) {return;}
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Folder name"),
    validateInput: (value) => value.trim().length < 1 || value.length > 50 ? vscode.l10n.t("The name must be between 1 and 50 characters.") : undefined,
  });
  if (name === undefined) {return;}
  const color = await vscode.window.showQuickPick(COLORS, { placeHolder: vscode.l10n.t("Choose a folder color") }) as WorkspaceFolderColor | undefined;
  try {
    await deps.store.createFolder(scope, { name: name.trim(), color: color as WorkspaceFolderColor | undefined });
  } catch (error) {
    deps.showError(error);
  }
}

async function renameFolderCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const scope = await resolveScope(deps, arg);
  if (!scope) {return;}
  const folderId = folderIdOf(arg) ?? (await pickFolder(deps, scope))?.id;
  if (!folderId) {return;}
  const folder = deps.store.getFolder(folderId, scope.workspaceId);
  if (!folder) {return;}
  const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Folder name"), value: folder.name });
  if (name === undefined) {return;}
  try {
    await deps.store.updateFolder(scope, folderId, { name: name.trim() });
  } catch (error) {
    deps.showError(error);
  }
}

async function colorFolderCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const scope = await resolveScope(deps, arg);
  if (!scope) {return;}
  const folder = folderIdOf(arg) ? deps.store.getFolder(folderIdOf(arg)!, scope.workspaceId) : await pickFolder(deps, scope);
  if (!folder) {return;}
  const color = await vscode.window.showQuickPick(COLORS, { placeHolder: vscode.l10n.t("Choose a folder color") }) as WorkspaceFolderColor | undefined;
  if (!color) {return;}
  try {
    await deps.store.updateFolder(scope, folder.id, { color });
  } catch (error) {
    deps.showError(error);
  }
}

async function deleteFolderCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const scope = await resolveScope(deps, arg);
  if (!scope) {return;}
  const folder = folderIdOf(arg) ? deps.store.getFolder(folderIdOf(arg)!, scope.workspaceId) : await pickFolder(deps, scope);
  if (!folder || !(await deps.confirmDanger(folder.name, vscode.l10n.t("Delete folder")))) {return;}
  try {
    await deps.store.deleteFolder(scope, folder.id);
  } catch (error) {
    deps.showError(error);
  }
}

async function setFolderResourceCommand(deps: CommandDeps, arg: unknown, present: boolean): Promise<void> {
  const scope = await resolveScope(deps, arg);
  if (!scope) {return;}
  const folderId = folderIdOf(arg) ?? (await pickFolder(deps, scope))?.id;
  if (!folderId) {return;}
  const resource = resourceOf(arg) ?? await pickResource(deps, scope);
  if (!resource) {return;}
  try {
    await deps.store.setResourceFolder(scope, folderId, resource, present);
  } catch (error) {
    deps.showError(error);
  }
}

export function registerOrganizationCommands(deps: CommandDeps): void {
  register(deps.context, "vertraCloud.organization.createFolder", (arg: unknown) => createFolderCommand(deps, arg));
  register(deps.context, "vertraCloud.organization.renameFolder", (arg: unknown) => renameFolderCommand(deps, arg));
  register(deps.context, "vertraCloud.organization.colorFolder", (arg: unknown) => colorFolderCommand(deps, arg));
  register(deps.context, "vertraCloud.organization.deleteFolder", (arg: unknown) => deleteFolderCommand(deps, arg));
  register(deps.context, "vertraCloud.organization.addResource", (arg: unknown) => setFolderResourceCommand(deps, arg, true));
  register(deps.context, "vertraCloud.organization.removeResource", (arg: unknown) => setFolderResourceCommand(deps, arg, false));
}
