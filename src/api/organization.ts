import type {
  APIWorkspaceResourceFolder,
  APIWorkspaceResourceOrganization,
  APIWorkspaceResourceRef,
  WorkspaceFolderColor,
  WorkspaceResourceType,
} from "@vertracloud/api-types/v1";
import type { ApiClient } from "./client";

export type OrganizationResourceType = WorkspaceResourceType;
export type OrganizationScope = { workspaceId?: string };

function root(scope?: OrganizationScope): string {
  return scope?.workspaceId
    ? `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}`
    : "/v1/users/me";
}

export interface CreateFolderBody {
  name: string;
  color?: WorkspaceFolderColor;
  position?: number;
}

export interface UpdateFolderBody {
  name?: string;
  color?: WorkspaceFolderColor;
  position?: number;
}

export function createFolder(
  client: ApiClient,
  body: CreateFolderBody,
  scope?: OrganizationScope,
): Promise<APIWorkspaceResourceFolder> {
  return client.request<APIWorkspaceResourceFolder>(`${root(scope)}/folders`, { method: "POST", body });
}

export function updateFolder(
  client: ApiClient,
  folderId: string,
  body: UpdateFolderBody,
  scope?: OrganizationScope,
): Promise<APIWorkspaceResourceFolder> {
  return client.request<APIWorkspaceResourceFolder>(`${root(scope)}/folders/${encodeURIComponent(folderId)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteFolder(client: ApiClient, folderId: string, scope?: OrganizationScope): Promise<void> {
  return client.request<void>(`${root(scope)}/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" });
}

export function addResourceToFolder(
  client: ApiClient,
  folderId: string,
  resourceType: OrganizationResourceType,
  resourceId: string,
  scope?: OrganizationScope,
): Promise<APIWorkspaceResourceOrganization> {
  return client.request<APIWorkspaceResourceOrganization>(
    `${root(scope)}/folders/${encodeURIComponent(folderId)}/resources/${resourceType}/${encodeURIComponent(resourceId)}`,
    { method: "PUT" },
  );
}

export function removeResourceFromFolder(
  client: ApiClient,
  folderId: string,
  resourceType: OrganizationResourceType,
  resourceId: string,
  scope?: OrganizationScope,
): Promise<APIWorkspaceResourceOrganization> {
  return client.request<APIWorkspaceResourceOrganization>(
    `${root(scope)}/folders/${encodeURIComponent(folderId)}/resources/${resourceType}/${encodeURIComponent(resourceId)}`,
    { method: "DELETE" },
  );
}

export function setFavorite(
  client: ApiClient,
  resource: APIWorkspaceResourceRef,
  favorite: boolean,
  scope?: OrganizationScope,
): Promise<APIWorkspaceResourceOrganization> {
  const path = `${root(scope)}/favorites/${resource.resource_type}/${encodeURIComponent(resource.resource_id)}`;
  return client.request<APIWorkspaceResourceOrganization>(path, { method: favorite ? "PUT" : "DELETE" });
}
