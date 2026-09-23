import type {
  APIWorkspace,
  APIWorkspaceActionRequest,
  APIWorkspaceInvite,
  APIWorkspaceInvitePreview,
  RESTPostAPIWorkspaceActionRequestBody,
  WorkspaceActionRequestStatus,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

/**
 * O `.d.ts` publicado não declara corpo de criação/edição de workspace (só o zod da `api`,
 * `src/@types/workspace.ts`: `name` 1–50, `description` até 200, ambos opcionais na edição).
 * Intersection local mínima em vez de duplicar o payload inteiro (API_MATRIX §15).
 */
export interface WorkspaceWriteBody {
  name?: string;
  description?: string;
}

export function createWorkspace(client: ApiClient, body: Required<Pick<WorkspaceWriteBody, "name">> & WorkspaceWriteBody): Promise<APIWorkspace> {
  return client.request<APIWorkspace>("/v1/workspaces", { method: "POST", body });
}

export function updateWorkspace(client: ApiClient, workspaceId: string, body: WorkspaceWriteBody): Promise<APIWorkspace> {
  return client.request<APIWorkspace>(`/v1/workspaces/${workspaceId}`, { method: "PUT", body });
}

export function addAppToWorkspace(client: ApiClient, workspaceId: string, appId: string): Promise<APIWorkspace> {
  return client.request<APIWorkspace>(`/v1/workspaces/${workspaceId}/apps/${appId}`, { method: "POST" });
}

export function addDatabaseToWorkspace(client: ApiClient, workspaceId: string, dbId: string): Promise<APIWorkspace> {
  return client.request<APIWorkspace>(`/v1/workspaces/${workspaceId}/databases/${dbId}`, { method: "POST" });
}

export function deleteWorkspace(client: ApiClient, workspaceId: string): Promise<void> {
  return client.request<void>(`/v1/workspaces/${workspaceId}`, { method: "DELETE" });
}

export function listWorkspaceInvites(client: ApiClient, workspaceId: string): Promise<APIWorkspaceInvite[]> {
  return client.request<APIWorkspaceInvite[]>(`/v1/workspaces/${workspaceId}/invites`);
}

export function revokeWorkspaceInvite(client: ApiClient, workspaceId: string, inviteId: string): Promise<void> {
  return client.request<void>(`/v1/workspaces/${workspaceId}/invites/${inviteId}`, { method: "DELETE" });
}

export function previewWorkspaceInvite(client: ApiClient, token: string): Promise<APIWorkspaceInvitePreview> {
  return client.request<APIWorkspaceInvitePreview>(`/v1/workspaces/invites/${encodeURIComponent(token)}`);
}

export function acceptWorkspaceInvite(client: ApiClient, token: string): Promise<APIWorkspace> {
  return client.request<APIWorkspace>(`/v1/workspaces/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
}

export function declineWorkspaceInvite(client: ApiClient, token: string): Promise<void> {
  return client.request<void>(`/v1/workspaces/invites/${encodeURIComponent(token)}/decline`, { method: "POST" });
}

export function listWorkspaceActionRequests(
  client: ApiClient,
  workspaceId: string,
  status?: WorkspaceActionRequestStatus,
): Promise<APIWorkspaceActionRequest[]> {
  return client.request<APIWorkspaceActionRequest[]>(`/v1/workspaces/${workspaceId}/action-requests`, { query: { status } });
}

export function createWorkspaceActionRequest(
  client: ApiClient,
  workspaceId: string,
  body: RESTPostAPIWorkspaceActionRequestBody,
): Promise<APIWorkspaceActionRequest> {
  return client.request<APIWorkspaceActionRequest>(`/v1/workspaces/${workspaceId}/action-requests`, { method: "POST", body });
}
