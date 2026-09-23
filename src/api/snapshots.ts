import * as vscode from "vscode";
import type { APIResourceSnapshot, APISnapshotRestoreResponse } from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

export type SnapshotScope = "applications" | "databases";

export function listSnapshots(
  client: ApiClient,
  resourceId: string,
  scope: SnapshotScope,
): Promise<APIResourceSnapshot[]> {
  return client.request<APIResourceSnapshot[]>(`/v1/users/${resourceId}/snapshots`, { query: { scope } });
}

export function createSnapshot(
  client: ApiClient,
  resourceId: string,
  scope: SnapshotScope,
): Promise<APIResourceSnapshot> {
  return client.request<APIResourceSnapshot>(`/v1/users/${resourceId}/snapshots`, {
    method: "POST",
    query: { scope },
  });
}

export function downloadSnapshot(
  client: ApiClient,
  resourceId: string,
  snapshotId: string,
  scope: SnapshotScope,
): Promise<ArrayBuffer> {
  return client.request<ArrayBuffer>(`/v1/users/${resourceId}/snapshots/${snapshotId}/download`, {
    query: { scope },
    raw: true,
    timeoutMs: 10 * 60_000,
  });
}

export function restoreSnapshot(
  client: ApiClient,
  resourceId: string,
  snapshotId: string,
  scope: SnapshotScope,
): Promise<APISnapshotRestoreResponse> {
  return client.request<APISnapshotRestoreResponse>(
    `/v1/users/${resourceId}/snapshots/${snapshotId}/restore`,
    { method: "POST", query: { scope } },
  );
}

export function downloadApp(client: ApiClient, id: string): Promise<ArrayBuffer> {
  return client.request<ArrayBuffer>(`/v1/apps/${id}/download`, { raw: true, timeoutMs: 10 * 60_000 });
}

/**
 * Recusa escrever dentro de uma pasta do workspace enquanto ele não é confiável — o zip baixado
 * pode conter o próprio código do usuário, e um workspace não confiável não deve ganhar arquivo
 * novo silenciosamente.
 */
function isInsideUntrustedWorkspace(target: vscode.Uri): boolean {
  if (vscode.workspace.isTrusted) {return false;}
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((folder) => target.fsPath.startsWith(folder.uri.fsPath));
}

export async function saveBufferInteractive(buffer: ArrayBuffer, suggestedName: string): Promise<boolean> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(suggestedName),
    filters: { Zip: ["zip"] },
  });
  if (!target) {return false;}
  if (isInsideUntrustedWorkspace(target)) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Can't save inside an untrusted workspace folder. Choose another location or trust the workspace."),
    );
    return false;
  }
  await vscode.workspace.fs.writeFile(target, new Uint8Array(buffer));
  return true;
}
