import * as vscode from "vscode";
import type {
  APIWorkspace,
  APIWorkspaceActionRequest,
  RESTPostAPIWorkspaceActionRequestBody,
  WorkspaceActionRequestAction,
  WorkspaceActionRequestStatus,
} from "@vertracloud/api-types/v1";
import { listSnapshots } from "../api/snapshots";
import {
  acceptWorkspaceInvite,
  addAppToWorkspace,
  addDatabaseToWorkspace,
  createWorkspace,
  createWorkspaceActionRequest,
  declineWorkspaceInvite,
  deleteWorkspace,
  listWorkspaceActionRequests,
  listWorkspaceInvites,
  previewWorkspaceInvite,
  revokeWorkspaceInvite,
  updateWorkspace,
} from "../api/workspaces";
import type { WorkspaceEntry } from "../state";
import type { CommandDeps } from "./deps";

function workspaceIdOf(arg: unknown): string | undefined {
  if (typeof arg === "string") {return arg;}
  if (!arg || typeof arg !== "object") {return undefined;}
  const node = arg as { kind?: string; id?: unknown; workspaceId?: unknown };
  if (node.kind === "workspace" && typeof node.id === "string") {return node.id;}
  if (typeof node.workspaceId === "string") {return node.workspaceId;}
  return undefined;
}

async function pickWorkspace(deps: CommandDeps): Promise<APIWorkspace | undefined> {
  const entries = deps.store.workspaces;
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("No workspaces available."));
    return undefined;
  }
  if (entries.length === 1) {return entries[0];}
  const pick = await vscode.window.showQuickPick(
    entries.map((w) => ({ label: w.name, description: w.description ?? undefined, detail: w.id, workspace: w })),
    { placeHolder: vscode.l10n.t("Select a workspace") },
  );
  return pick?.workspace;
}

async function resolveWorkspace(deps: CommandDeps, arg: unknown): Promise<APIWorkspace | undefined> {
  const id = workspaceIdOf(arg);
  if (id) {
    const entry = deps.store.workspaces.find((w) => w.id === id);
    if (entry) {return entry;}
  }
  if (arg === undefined) {return pickWorkspace(deps);}
  return id ? undefined : pickWorkspace(deps);
}

async function createWorkspaceCommand(deps: CommandDeps): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Workspace name"),
    validateInput: (value) =>
      value.trim().length < 1 || value.length > 50
        ? vscode.l10n.t("The name must be between 1 and 50 characters.")
        : undefined,
  });
  if (name === undefined) {return;}

  const description = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Description (optional)"),
    validateInput: (value) =>
      value.length > 200 ? vscode.l10n.t("The description must be at most 200 characters.") : undefined,
  });
  if (description === undefined) {return;}

  try {
    await createWorkspace(deps.client, { name, description: description || undefined });
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

async function editWorkspaceCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const workspace = await resolveWorkspace(deps, arg);
  if (!workspace) {return;}

  const fields = [
    { label: vscode.l10n.t("Name"), field: "name" as const },
    { label: vscode.l10n.t("Description"), field: "description" as const },
  ];
  const picked = await vscode.window.showQuickPick(fields, { placeHolder: workspace.name });
  if (!picked) {return;}

  if (picked.field === "name") {
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Workspace name"),
      value: workspace.name,
      validateInput: (value) =>
        value.trim().length < 1 || value.length > 50
          ? vscode.l10n.t("The name must be between 1 and 50 characters.")
          : undefined,
    });
    if (name === undefined) {return;}
    try {
      await updateWorkspace(deps.client, workspace.id, { name });
      await deps.refresh();
    } catch (err) {
      deps.showError(err);
    }
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Description"),
    value: workspace.description ?? "",
    validateInput: (value) =>
      value.length > 200 ? vscode.l10n.t("The description must be at most 200 characters.") : undefined,
  });
  if (description === undefined) {return;}
  try {
    await updateWorkspace(deps.client, workspace.id, { description });
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

async function linkAppCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const workspace = await resolveWorkspace(deps, arg);
  if (!workspace) {return;}
  const entry = await deps.pickApp();
  if (!entry) {return;}
  try {
    await addAppToWorkspace(deps.client, workspace.id, entry.app.id);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

async function linkDatabaseCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const workspace = await resolveWorkspace(deps, arg);
  if (!workspace) {return;}
  const entry = await deps.pickDatabase();
  if (!entry) {return;}
  try {
    await addDatabaseToWorkspace(deps.client, workspace.id, entry.db.id);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(vscode.env.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

async function deleteWorkspaceCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const workspace = await resolveWorkspace(deps, arg);
  if (!workspace) {return;}
  const confirmed = await deps.confirmDanger(workspace.name, vscode.l10n.t("delete this workspace"));
  if (!confirmed) {return;}
  try {
    await deleteWorkspace(deps.client, workspace.id);
    await deps.refresh();
  } catch (err) {
    deps.showError(err);
  }
}

async function manageInvitesCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const workspace = await resolveWorkspace(deps, arg);
  if (!workspace) {return;}
  try {
    const invites = (await listWorkspaceInvites(deps.client, workspace.id)).filter(
      (invite) => !invite.accepted_at && !invite.revoked_at,
    );
    if (invites.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No pending invites."));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      invites.map((invite) => ({
        label: invite.email ?? vscode.l10n.t("Invite link"),
        description: invite.role_name,
        detail: vscode.l10n.t("Expires {0}", formatDate(invite.expires_at)),
        invite,
      })),
      { placeHolder: vscode.l10n.t("Select an invite to revoke") },
    );
    if (!pick) {return;}
    const revoke = vscode.l10n.t("Revoke");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Revoke the invite for {0}?", pick.label),
      { modal: true },
      revoke,
    );
    if (choice !== revoke) {return;}
    await revokeWorkspaceInvite(deps.client, workspace.id, pick.invite.id);
    void vscode.window.showInformationMessage(vscode.l10n.t("Invite revoked."));
  } catch (err) {
    deps.showError(err);
  }
}

/** Aceita o token puro ou a URL do convite (`.../invite/<token>`). */
export function inviteTokenFrom(value: string): string {
  const trimmed = value.trim().split(/[?#]/)[0];
  return trimmed.split("/").filter(Boolean).pop() ?? "";
}

async function openInviteCommand(deps: CommandDeps): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("Invite link or token"),
    ignoreFocusOut: true,
    validateInput: (input) => (inviteTokenFrom(input) ? undefined : vscode.l10n.t("Paste the invite link or token.")),
  });
  if (value === undefined) {return;}
  const token = inviteTokenFrom(value);
  try {
    const preview = await previewWorkspaceInvite(deps.client, token);
    const accept = vscode.l10n.t("Accept");
    const decline = vscode.l10n.t("Decline");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t("{0} invited you to the workspace {1} as {2}.", preview.inviter.display_name, preview.workspace.name, preview.role_name),
      { modal: true, detail: vscode.l10n.t("Expires {0}", formatDate(preview.expires_at)) },
      accept,
      decline,
    );
    if (choice === accept) {
      await acceptWorkspaceInvite(deps.client, token);
      await deps.refresh();
    } else if (choice === decline) {
      await declineWorkspaceInvite(deps.client, token);
    }
  } catch (err) {
    deps.showError(err);
  }
}

function actionLabel(action: WorkspaceActionRequestAction): string {
  switch (action) {
    case "app_delete":
      return vscode.l10n.t("Delete application");
    case "database_delete":
      return vscode.l10n.t("Delete database");
    case "snapshot_create":
      return vscode.l10n.t("Create snapshot");
    case "snapshot_restore":
      return vscode.l10n.t("Restore snapshot");
  }
}

function statusLabel(status: WorkspaceActionRequestStatus): string {
  switch (status) {
    case "pending":
      return vscode.l10n.t("Pending");
    case "approved":
      return vscode.l10n.t("Approved");
    case "rejected":
      return vscode.l10n.t("Rejected");
    case "expired":
      return vscode.l10n.t("Expired");
  }
}

const ACTION_REQUEST_STATUSES: WorkspaceActionRequestStatus[] = ["pending", "approved", "rejected", "expired"];

async function actionRequestsCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const workspace = await resolveWorkspace(deps, arg);
  if (!workspace) {return;}
  const filter = await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t("All"), status: undefined },
      ...ACTION_REQUEST_STATUSES.map((status) => ({ label: statusLabel(status), status })),
    ],
    { placeHolder: vscode.l10n.t("Filter by status") },
  );
  if (!filter) {return;}
  let requests: APIWorkspaceActionRequest[];
  try {
    requests = await listWorkspaceActionRequests(deps.client, workspace.id, filter.status);
  } catch (err) {
    deps.showError(err);
    return;
  }
  if (requests.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("No action requests."));
    return;
  }
  await vscode.window.showQuickPick(
    requests.map((request) => ({
      label: `${actionLabel(request.action)}: ${request.resource_name ?? request.resource_id}`,
      description: statusLabel(request.status),
      detail: vscode.l10n.t("Requested by {0} on {1}", request.requested_by.display_name, formatDate(request.created_at)),
    })),
    { placeHolder: workspace.name },
  );
}

async function requestActionCommand(deps: CommandDeps, arg: unknown): Promise<void> {
  const workspace = (await resolveWorkspace(deps, arg)) as WorkspaceEntry | undefined;
  if (!workspace) {return;}
  const actions: WorkspaceActionRequestAction[] = ["app_delete", "database_delete", "snapshot_create", "snapshot_restore"];
  const actionPick = await vscode.window.showQuickPick(
    actions.map((action) => ({ label: actionLabel(action), action })),
    { placeHolder: vscode.l10n.t("Select the action to request") },
  );
  if (!actionPick) {return;}
  const { action } = actionPick;

  const apps = action === "database_delete" ? [] : (workspace.applications ?? []).map((app) => ({ label: app.name, id: app.id, scope: "applications" as const }));
  const dbs = action === "app_delete" ? [] : (workspace.databases ?? []).map((db) => ({ label: db.name, id: db.id, scope: "databases" as const }));
  const resources = [...apps, ...dbs];
  if (resources.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("No resources in this workspace for this action."));
    return;
  }
  const resource = await vscode.window.showQuickPick(resources, { placeHolder: vscode.l10n.t("Select a resource") });
  if (!resource) {return;}

  try {
    let body: RESTPostAPIWorkspaceActionRequestBody;
    if (action === "snapshot_restore") {
      const snapshots = await listSnapshots(deps.client, resource.id, resource.scope);
      if (snapshots.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t("No snapshots available."));
        return;
      }
      const snapshot = await vscode.window.showQuickPick(
        snapshots.map((item) => ({ label: formatDate(item.date), id: item.id })),
        { placeHolder: vscode.l10n.t("Select a snapshot") },
      );
      if (!snapshot) {return;}
      body = { action, resource_id: resource.id, params: { snapshot_id: snapshot.id } };
    } else {
      body = { action, resource_id: resource.id };
    }
    await createWorkspaceActionRequest(deps.client, workspace.id, body);
    void vscode.window.showInformationMessage(vscode.l10n.t("Request sent for approval."));
  } catch (err) {
    deps.showError(err);
  }
}

export function registerWorkspacesCommands(deps: CommandDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("vertraCloud.workspace.create", () => createWorkspaceCommand(deps)),
    vscode.commands.registerCommand("vertraCloud.workspace.edit", (arg: unknown) => editWorkspaceCommand(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.workspace.linkApp", (arg: unknown) => linkAppCommand(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.workspace.linkDatabase", (arg: unknown) =>
      linkDatabaseCommand(deps, arg),
    ),
    vscode.commands.registerCommand("vertraCloud.workspace.delete", (arg: unknown) => deleteWorkspaceCommand(deps, arg)),
    vscode.commands.registerCommand("vertraCloud.workspace.manageInvites", (arg: unknown) =>
      manageInvitesCommand(deps, arg),
    ),
    vscode.commands.registerCommand("vertraCloud.workspace.openInvite", () => openInviteCommand(deps)),
    vscode.commands.registerCommand("vertraCloud.workspace.actionRequests", (arg: unknown) =>
      actionRequestsCommand(deps, arg),
    ),
    vscode.commands.registerCommand("vertraCloud.workspace.requestAction", (arg: unknown) =>
      requestActionCommand(deps, arg),
    ),
  );
}
